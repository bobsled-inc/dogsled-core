# @bobsled-inc/api-resource — Agent Guide

<!-- last-reviewed: 2026-08-19 -->

Dependency-light request planning shared by the extractor runtime and the
catalog-only resource probe. This package must remain safe to import from
catalog consumers without loading extractor, DuckDB, or other native runtime
dependencies.

## Boundaries

- Keep resource schema validation and first-request construction here; do not
  add pagination, retries, loaders, state, or durable pipeline behavior.
- Preserve the extractor-compatible interpolation and input-default semantics
  when changing the shared planner.
- Treat external definitions as untrusted: validate them with the canonical
  schema before planning and reject unresolved templates, unsafe headers, and
  unencoded path substitutions.
- Never log request URLs, resolved headers, request bodies, secrets, or response
  bodies from this package.

## Development

```bash
pnpm --filter @bobsled-inc/api-resource typecheck
pnpm --filter @bobsled-inc/api-resource build
```
