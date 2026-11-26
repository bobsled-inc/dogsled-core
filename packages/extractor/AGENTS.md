# @bobsled-inc/extractor — Agent Guide

<!-- last-reviewed: 2026-11-25 -->

YAML-driven data extraction CLI supporting API, warehouse/database, and MCP sources with Dogsled protocol JSONL messages.

---

## Adding a New Warehouse Source

Use the `/add-warehouse-source` skill for the full workflow.

Condensed steps:

1. Add connection + auth schemas in `framework/core/warehouse.ts`
2. Add integration spec variant in `framework/extractor/resource.ts`
3. Implement `WarehouseClient` in `runtime/<dialect>-client.ts`
4. Add case to `createWarehouseClient()` factory in `runtime/warehouse-client.ts`
5. Add dialect to `warehouse-query-builder.ts` (quoting, placeholders, table qualification)
6. Add type mappings in `runtime/warehouse-type-mapper.ts`
7. Types auto-derive from Zod — no manual type changes needed

## Adding a New Pagination Strategy

1. Add variant to `PaginationSchema` discriminated union in `framework/extractor/pagination.ts`
2. Add async generator function in `runtime/pagination.ts`, or `runtime/mcp-pagination.ts` for MCP
3. Add case to the `switch` in both `paginate()` and `paginateMcpTool()`
4. Types auto-derive

## Adding a New Auth Type

1. Add variant to `AuthSchema` union in `framework/core/auth.ts`
2. Add a handler in `framework/runtime/auth-handlers/`
3. Add case to the `getAuthHandler()` switch in `framework/runtime/auth-handlers/index.ts`
4. Types auto-derive

## Adding MCP Support to an Integration

1. Set transport type to `mcp_http` or `mcp_stdio` in the integration file
2. Define resources with `tool` block (tool_name, arguments) instead of `api` block
3. Use MCP pagination types: `mcp_cursor`, `mcp_offset`, `mcp_page_number`
4. Auth: bearer, api-key, oauth2, or none (configured on transport)

## Security Invariants — Must Follow

- **SSRF**: The request planner in `@bobsled-inc/api-resource` rejects endpoints outside the integration origin, and `client.ts` checks override and redirect URLs with `isSameOrigin`. Pagination checks next-page URLs with `isSameOrigin`. MCP HTTP transport uses DNS pre-resolution and private host blocking
- **Path traversal**: `assertPathContained` in `common.ts` resolves symlinks via `realpathSync`. Emitter checks output file paths
- **OAuth HTTPS**: `token_url` schema enforces `https://` prefix
- **Header injection**: `api-key` `header`, static `headers` and `optional_headers` keys validated against regex + restricted header blocklist; resolved values are rejected on control characters. An `optional_headers` entry is omitted (never failed) when its variable is absent or empty, and a declared `headers` entry of the same name wins
- **File size**: Integration and resource specs capped at 1 MB before parsing
- **Retry-After cap**: Rate limiter caps server-directed delays at 5 minutes
- **MCP stdio sandboxing**: Exact reviewed shapes only — `npx -y @ergut/mcp-bigquery-server@1.0.4` with project/location arguments, or `uvx mcp-snowflake-server==0.4.0`. Interpreters, containers, arbitrary packages/options, mutable versions, path separators, and unapproved env keys are rejected
- **SQL injection**: Warehouse query builder uses dialect-aware identifier quoting and parameterized queries; Iceberg and Delta, which take no bind parameters, inline escaped cursor values

## Key Patterns

- **Types from Zod**: Domain types in `types/index.ts` derive from `z.infer<typeof Schema>`. Never duplicate types manually
- **Discriminated unions**: Auth (`z.union`) and Pagination (`z.discriminatedUnion`) narrow exhaustively on `type`
- **`.strict()` by default**: Zod object schemas for YAML specs use `.strict()` to catch typos
- **Env var indirection**: Secrets never in YAML. Auth fields use `${{ env.VAR }}` references resolved at call time
- **Async generators**: Pagination strategies yield pages one at a time for bounded memory
- **Atomic state writes**: `state.ts` uses write-tmp-then-rename for crash safety
- **Staged state**: `--staged-state` (a pipeline's own option) keeps what a run saves in a private file until `commit-state` saves it through the backend. File sources only: a CDC slot moves with the saved state
- **Message protocol**: stdout = data (such as SCHEMA/RECORD/STATE), stderr = control (such as LOG/METRIC). Version field `_v: 1` on every message
- **Load strategy resolution**: `emitSchema()` derives `load_strategy` via cascade: YAML override > fullRefresh flag > file `incremental_append` (append) > incremental+PKs inference > full_refresh. `resolveLoadStrategy()` helper in `schema-message.ts`
- **Copy Resources**: `source.kind: copy` runs `runtime/file-copy-extractor.ts`, which sends one FILE message per file and saves state only after the loader has deleted every temp file. It needs a loader on a pipe, so it refuses `--no-state-write` and output to a file or terminal. Behaviour and limits are in `docs/guides/extract-from-files.md`
- **Warehouse client factory**: Dynamic `import()` in `warehouse-client.ts` lazy-loads dialect clients to avoid unnecessary dependency loading
- **CDC metadata normalization**: `warehouse-extractor.ts` normalizes Snowflake METADATA$, BigQuery \_CHANGE_TYPE, and Delta CDF columns to standard `_change_type` / `_is_update`
- **Error taxonomy**: `errors.ts` classifies errors as transient (retryable), config (fail-fast), or data (fail-fast)
- **Request retries**: `RateLimiter.fetchWithRetry` gives each attempt its own `timeout_ms` and reads a successful body inside the attempt (`readBody`), so a stalled or dropped read retries one request. Parse after `readBody` returns, so a bad document is never requested again. A caller that changes data at the provider passes `idempotent: false` (Actions and activation do), so a timeout, a failed body read or a 502/504 is never resent. `onRetry` reports each retry; extraction logs it as an `http.request_retry` warning
- **Dual-dispatch**: `extract-resource.ts` routes to HTTP or MCP page iterators based on transport type

## Error Handling

| Error type                                    | When to use                   | Behavior                    |
| --------------------------------------------- | ----------------------------- | --------------------------- |
| `CommandError` (from `@bobsled-inc/protocol`) | User-facing CLI errors        | Sets exitCode, clean output |
| `ExtractorTransientError`                     | Network, timeout, rate limit  | Retryable                   |
| `ExtractorConfigError`                        | Auth failures, tool not found | Fail-fast, not retryable    |
| `ExtractorDataError`                          | Parsing, validation           | Fail-fast, not retryable    |

Top-level catch in `index.ts` converts all `Error` instances to clean CLI output (no stack traces).

## Common Pitfalls

- **Never hardcode secrets in YAML** — always use `${{ env.VAR }}` references, or `*_env` fields where the schema requires them
- **Endpoint must start with `/` or stay on the integration origin** — other origins are rejected
- **Integration names must be snake_case** — validated by Zod schema and `SAFE_NAME_RE`
- **State dir must be within project root** — enforced by `assertPathContained` with symlink resolution
- **`--limit` runs are always non-durable previews** — state is never persisted, even when state advancement is otherwise enabled
- **Normalization warnings** routed through ControlLogger (not raw stderr)
- **HTTP client follows same-origin redirects** — up to 5 hops, origin checked on each hop
- **`extractRecords()` filters non-object items** — only plain objects pass through
- **Integer/number cursors reject relative durations** — relative durations only valid for timestamp cursors
- **`incremental_merge` requires `primary_key`** — Zod schema validates at parse time

## Development

```bash
pnpm --filter @bobsled-inc/extractor build
pnpm --filter @bobsled-inc/extractor typecheck
pnpm --filter @bobsled-inc/extractor lint
pnpm --filter @bobsled-inc/extractor test:unit
```

Tests are in `tests/unit/` and `tests/integration/`. Test fixtures in `tests/fixtures/`.
