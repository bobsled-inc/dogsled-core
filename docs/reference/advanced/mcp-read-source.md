# MCP `read_source` — Agent-Native Document Reads

<!-- last-reviewed: 2026-05-12 -->

Dogsled exposes its document corpus to LLM agents through MCP (Model Context Protocol). The first tool, `read_source`, returns rows from any `<resource>__documents` or `<resource>__chunks` table along with citation metadata, gated by a required `principal`.

This is the **outbound** MCP surface: Dogsled-as-server, agent-as-client. (Dogsled-as-client, consuming Notion / Atlassian / GDrive over MCP, is a separate package — see `packages/extractor/src/runtime/mcp-*.ts`.)

## Read This If

- You're building an agent or retrieval pipeline that needs to read documents and chunks from a Dogsled project with citations attached.
- You need to enforce per-principal ACLs on document reads without writing the enforcement layer yourself.
- You're choosing between the typed SDK and MCP for a particular use case — see [Two Patterns: When to Use What](#two-patterns-when-to-use-what).

## Prerequisites

- Documents and chunks materialized via `format: document` ingest (`<resource>__documents`, `<resource>__chunks`).
- A way to translate a `principal` into row-level filtering against your warehouse — typically a SQL `WHERE` clause that consults `__acl` or equivalent.

## What's Shipped Today

- One read tool: `read_source`. Returns rows + citations.
- Fail-closed default: every call requires a `principal`.
- Single explicit escape hatch (`--allow-unfiltered` AND `DOGSLED_MCP_ALLOW_UNFILTERED=1`) for single-tenant / public-data demos.
- Public subpath: `import { ... } from '@bobsled-inc/bobsled-core/mcp'`.

Richer tools (`search_documents`, `get_document`, `search_entity_context`, `traverse_entity_context`) are planned on a later milestone — they are not shipped on `main` yet.

## Quickstart

```ts
import { BobsledMcpServer, readSource } from '@bobsled-inc/bobsled-core/mcp';

const server = new BobsledMcpServer({ allowedSourceTables: new Set(['support_docs__chunks']) });

server.registerPermissionAdapter({
  name: 'source-acl',
  appliesTo: ({ sourceTable }) => sourceTable === 'support_docs__chunks',
  filter: (rows, { principal }) => filterRowsByAcl(rows, principal),
});

const result = await readSource(
  {
    server,
    principal: { principal_id: 'user_123', groups: ['revops'] },
    fetcher: ({ input, principal }) => queryRowsForPrincipal(input, principal),
  },
  {
    source_table: 'support_docs__chunks',
    limit: 10,
  }
);

console.log(result.result.rows[0].data);
console.log(result.citations);
```

Supply the declared source-table allowlist, a permission adapter and a fetcher. The server checks the allowlist and applicable adapter before fetching.

## Request Shape

```ts
interface ReadSourceInput {
  source_table: string; // e.g. 'support_docs__chunks'
  limit?: number;
  cursor?: string; // opaque; returned by the previous response
}
```

`source_table` is validated by the same identifier guard used in the SQL builders. Anything that doesn't match `[A-Za-z_][A-Za-z0-9_.]*` is rejected at the boundary — your fetcher never sees an injection attempt.

## Response Shape

```ts
interface ReadSourceOutput {
  rows: Array<{
    data: Record<string, unknown>;
    citation?: Citation;
  }>;
  next_cursor?: string;
}

interface Citation {
  document_id: string;
  document_version_id: string;
  source_uri: string;
  title?: string;
  chunk_id?: string;
  chunk_index?: number;
  acl_principals: string[];
  source_grant_types: string[];
}
```

Citations are added automatically when the table suffix is `__documents` or `__chunks`. Structured tables get no citation. If `document_id`, `document_version_id`, or `source_uri` is missing, the citation is dropped entirely rather than emitting an empty-string form.

The full MCP envelope also includes `permissions` (whether row filtering was enforced) and `routing_metadata` (`resolved_via: 'fts' | 'vector' | 'mention_join' | 'direct'`, plus cache + embedding flags). Future tools will populate the routing metadata more richly; `read_source` reports `'direct'` and `cache_hit: false`.

## Principal Required vs. Permissions Enforced

These are separate checks:

- **Principal required**: by default, `read_source` rejects requests that do not include a non-empty principal. This keeps unauthenticated requests out of the data plane.
- **Permissions enforced**: row-level filtering is active only when your fetcher applies ACL logic or when a registered permission adapter applies to the requested table.

Without an applicable permission adapter, source reads fail with `PermissionsNotConfigured`, even when a principal is supplied. The CLI has no built-in row filter, so it denies reads by default. Its explicit unfiltered opt-in still restricts reads to the current project's declared source tables.

When a registered adapter filters the returned rows, the response reports `{ "enforced": true, "adapter": "<name>" }`.

## Fail-Closed by Default

The default is to reject every request without a principal:

```ts
import { BobsledMcpServer } from '@bobsled-inc/bobsled-core/mcp';

const server = new BobsledMcpServer();
server.requirePrincipal(null);
// throws CommandError(2):
//   PermissionsNotConfigured: every MCP tool call requires a principal. ...
```

This is intentional. Production deployments that connect non-public data should run with enforcement on. The MCP server validates principal presence and can run registered permission adapters, but the **fetcher you write** is still responsible for translating `principal` into row-level filtering at the warehouse/API boundary. The server makes "I forgot the principal" impossible at the type level: the fetcher signature is `({ input, principal }) => ...`, and `principal` is non-optional in the default call site.

## The Escape Hatch

For a single-tenant demo / public-data preview / local dev, both of these must be set:

1. Construct the server with `allowUnfiltered: true`.
2. Set the environment variable `DOGSLED_MCP_ALLOW_UNFILTERED=1`.

```ts
const server = new BobsledMcpServer({
  allowUnfiltered: true,
  allowedSourceTables: new Set(['support_docs__chunks']),
});
// AND set DOGSLED_MCP_ALLOW_UNFILTERED=1 in the environment.
```

If only one of the two is set, the constructor throws `CommandError(2)`. The asymmetry is deliberate: a one-flag escape hatch is easy to set by accident; a flag-and-env-var escape hatch is not.

When unfiltered mode is active:

- The first request emits a WARN log: `[mcp-server] running with --allow-unfiltered. Permissions are NOT enforced.`
- The fetcher receives `principal: null` and **must** emit its own WARN on first call. This is required by the contract — if your fetcher silently passes data through with `null`, it has violated the contract.

When no permission adapter is registered, the `permissions` envelope reports `{ enforced: false, reason: 'no_adapter_registered' }`, so downstream agents can see that Dogsled did not apply row-level filtering after fetch. If an adapter is registered and applies, the response reports `{ enforced: true, adapter: '<name>' }`.

## Two Patterns: When to Use What

| Need                                                              | Use                    |
| ----------------------------------------------------------------- | ---------------------- |
| Typed entity profiles + filters + relationship traversal          | Generated SDK          |
| Document / chunk rows with citations for retrieval-style agents   | MCP `read_source`      |
| Raw SQL exploration of `__entity_profile` / `__document_mentions` | Direct warehouse query |

A pragmatic application uses both: the generated SDK for structured queries (`customer.findBy(...)`), and `read_source` from agent tools that need raw chunks to ground a response.

## Authoring a Fetcher

A fetcher is a single async function. Three responsibilities:

1. **Apply ACL filtering** using the `principal`. (The server validated that `principal` is non-null in enforcement mode; you just have to use it.)
2. **Translate** `input` (table name, limit, cursor) into a warehouse query.
3. **Return** `{ rows, next_cursor? }`. Each row is a `Record<string, unknown>` shaped like the underlying table; the server attaches a `Citation` automatically for document/chunk tables.

```ts
import type { RowFetcher } from '@bobsled-inc/bobsled-core/mcp';

let warnedUnfiltered = false;
const warn = (message: string) => process.stderr.write(`[warn] ${message}\n`);

const fetcher: RowFetcher = async ({ input, principal }) => {
  if (!principal) {
    if (!warnedUnfiltered) {
      warnedUnfiltered = true;
      warn('principal is null; running unfiltered fetch path');
    }
    return { rows: [] };
  }
  const sql = `
    SELECT *
    FROM ${input.source_table} t
    WHERE t.acl_principals && $1::text[]
    LIMIT $2
  `;
  const rows = await pool.query(sql, [
    [principal.principal_id, ...(principal.groups ?? [])],
    input.limit ?? 50,
  ]);
  return { rows: rows.rows };
};
```

The `__acl` table currently stores ACL evidence captured at ingest time. Today, full join-style enforcement is on the consumer: use the `principal` to filter against whatever ACL columns your sources expose, or join against `__acl` directly. Dogsled captures ACL evidence. Host applications implement enforcement, role hierarchies, and approval workflows.

## Cursors

`next_cursor` is opaque. Your fetcher decides what goes into it; clients only ever pass it back verbatim. A common pattern is to embed the last row's primary key plus the table name. The server does not interpret the cursor.

## Errors

All errors raised at the MCP boundary follow the Dogsled exit-code taxonomy:

| Exit code | When                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| `2`       | Missing principal in enforcement mode. Malformed escape hatch. Unsafe `source_table` identifier. |
| `1`       | Fetcher threw, or transport failure inside your runner.                                          |

The CLI / SDK layers wrap these into `CommandError` so consumers get a clean error envelope rather than a stack trace.

## Health Checks

`dogsled doctor` includes:

| Check                          | What it verifies                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `mcp_unfiltered_in_production` | Flags when `DOGSLED_MCP_ALLOW_UNFILTERED=1` is set in CI / production-shaped environments. |

Run before deploying:

```bash
dogsled doctor --json
```

## Versioning

The `Citation` shape is **additive**: new optional fields are minor; renames are major. The `routing_metadata.resolved_via` enum may gain values in minor releases — clients should treat unknown values as `'direct'`.

## See Also

- [Entity graph](../../guides/entity-graph.md) — full workflow from ingest to typed SDK.
- [Mention Extraction](mention-extraction.md) — how document chunks become resolved entity links.
- [SDK Codegen](sdk-codegen.md) — the typed alternative to `read_source` for structured queries.
- [Embeddings and AI providers](../../guides/embeddings-and-ai.md) — model roles + budgets that govern any AI calls layered on top of `read_source`.
