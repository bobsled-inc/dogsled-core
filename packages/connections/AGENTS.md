# @bobsled-inc/connections — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

Shared connection schemas, secret resolution, connection construction, and SQL
runner selection for extractor, loader, model-spec, and entity-graph.

## Ownership

- Integration and target Zod schemas
- `${{ env.VAR }}` resolution through `SecretResolver`
- Per-dialect `ConnectionHandle` construction
- Custom and built-in SQL runner resolution
- Refreshable managed credentials and auth-retry primitives

Do not recreate these contracts in consumer packages. Drivers are dynamically
imported so this package can build without every warehouse SDK installed.

## Credential Invariants

- Never log tokens or interpolated secret values.
- Token endpoints must use HTTPS and header values must reject CR/LF.
- Refresh short-lived credentials proactively within the configured skew window.
- Retry once after a recognized authentication lapse; do not retry arbitrary errors.
- Keep the token-command contract shared with loader and model execution.

## Verify

```bash
pnpm --filter @bobsled-inc/connections build
pnpm --filter @bobsled-inc/connections typecheck
pnpm --filter @bobsled-inc/connections lint
pnpm --filter @bobsled-inc/connections test:unit
```
