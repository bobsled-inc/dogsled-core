# @bobsled-inc/extractor — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

YAML-driven data extraction CLI supporting API, warehouse/database, and MCP sources with Bobsled Core protocol JSONL messages.

---

## Adding a New Warehouse Source

Use the `/add-warehouse-source` skill for the full workflow. See root AGENTS.md Builder's Skill Index.

Condensed steps:

1. Add connection + auth schemas in `framework/core/warehouse.ts`
2. Add integration spec variant in `framework/extractor/resource.ts`
3. Implement `WarehouseClient` in `runtime/<dialect>-client.ts`
4. Add case to `createWarehouseClient()` factory in `runtime/warehouse-client.ts`
5. Add dialect to `warehouse-query-builder.ts` (quoting, placeholders, table qualification)
6. Add type mappings in `runtime/warehouse-type-mapper.ts`
7. Types auto-derive from Zod — no manual type changes needed

## Adding a New Pagination Strategy

1. Add variant to `PaginationSchema` discriminated union in `schemas/connection.ts`
2. Add async generator function in `runtime/pagination.ts`
3. Add case to the `switch` in `paginate()`
4. Types auto-derive

## Adding a New Auth Type

1. Add variant to `AuthSchema` discriminated union in `schemas/connection.ts`
2. Add case to `resolveAuth()` switch in `runtime/auth.ts`
3. Update `getRequiredEnvVars()` in `commands/validate.ts`
4. Types auto-derive

## Adding MCP Support to an Integration

1. Set transport type to `mcp_http` or `mcp_stdio` in `integration.yml`
2. Define resources with `tool` block (tool_name, arguments) instead of `api` block
3. Use MCP pagination types: `mcp_cursor`, `mcp_offset`, `mcp_page_number`
4. Auth: bearer, api-key, oauth2, or none (configured on transport)

## Security Invariants — Must Follow

- **SSRF**: `client.ts` checks `url.origin === this.baseOrigin` on every request. Pagination checks Link header URLs with `isSameOrigin`. MCP HTTP transport uses DNS pre-resolution and private host blocking
- **Path traversal**: `assertPathContained` in `common.ts` resolves symlinks via `realpathSync`. Emitter checks output file paths
- **OAuth HTTPS**: `token_url` schema enforces `https://` prefix
- **Header injection**: `api_key.header`, static `headers` and `optional_headers` keys validated against regex + restricted header blocklist; resolved values are rejected on control characters. An `optional_headers` entry is omitted (never failed) when its variable is absent or empty, and a declared `headers` entry of the same name wins
- **File size**: YAML specs capped at 1 MB before parsing
- **Retry-After cap**: Rate limiter caps server-directed delays at 5 minutes
- **MCP stdio sandboxing**: Exact reviewed shapes only — `npx -y @ergut/mcp-bigquery-server@1.0.4` with project/location arguments, or `uvx mcp-snowflake-server==0.4.0`. Interpreters, containers, arbitrary packages/options, mutable versions, path separators, and unapproved env keys are rejected
- **SQL injection**: Warehouse query builder uses dialect-aware identifier quoting and parameterized queries

## Key Patterns

- **Types from Zod**: All domain types in `types/index.ts` use `z.infer<typeof Schema>`. Never duplicate types manually
- **Discriminated unions**: Auth (5 variants) and Pagination (5 variants) use Zod `discriminatedUnion` for exhaustive type narrowing
- **`.strict()` everywhere**: All Zod object schemas use `.strict()` to catch typos in YAML
- **Env var indirection**: Secrets never in YAML. Auth reads `process.env[auth.token_env]` at call time
- **Async generators**: Pagination strategies yield pages one at a time for bounded memory
- **Atomic state writes**: `state.ts` uses write-tmp-then-rename for crash safety
- **Message protocol**: stdout = data (SCHEMA/RECORD/STATE), stderr = control (LOG/METRIC). Version field `_v: 1` on every message
- **Load strategy resolution**: `emitSchema()` derives `load_strategy` via cascade: YAML override > fullRefresh flag > file `incremental_append` (append) > incremental+PKs inference > full_refresh. `resolveLoadStrategy()` helper in `schema-message.ts`
- **Warehouse client factory**: Dynamic `import()` in `warehouse-client.ts` lazy-loads dialect clients to avoid unnecessary dependency loading
- **CDC metadata normalization**: `warehouse-extractor.ts` normalizes Snowflake METADATA$, BigQuery \_CHANGE_TYPE, and Delta CDF columns to standard `_change_type` / `_is_update`
- **Error taxonomy**: `errors.ts` classifies errors as transient (retryable), config (fail-fast), or data (fail-fast)
- **Dual-dispatch**: `extract.ts` routes to HTTP or MCP page iterators based on transport type

## Error Handling

| Error type                                    | When to use                   | Behavior                    |
| --------------------------------------------- | ----------------------------- | --------------------------- |
| `CommandError` (from `@bobsled-inc/protocol`) | User-facing CLI errors        | Sets exitCode, clean output |
| `ExtractorTransientError`                     | Network, timeout, rate limit  | Retryable                   |
| `ExtractorConfigError`                        | Auth failures, tool not found | Fail-fast, not retryable    |
| `ExtractorDataError`                          | Parsing, validation           | Fail-fast, not retryable    |

Top-level catch in `index.ts` converts all `Error` instances to clean CLI output (no stack traces).

## Common Pitfalls

- **Never hardcode secrets in YAML** — always use `*_env` fields referencing environment variables
- **Endpoint must start with `/`** — absolute URLs rejected by SSRF check
- **Connection names must be snake_case** — validated by Zod schema and `SAFE_NAME_RE`
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
