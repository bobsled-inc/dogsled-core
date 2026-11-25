# @bobsled-inc/models — Agent Guide

<!-- last-reviewed: 2026-11-25 -->

Installable Model Spec source, staging, mart, metric, and relationship bundles for
Dogsled integrations.

## Design Rules

- Treat integration resource specs as the source of truth for raw fields and keys.
- Keep source and staging generation mechanical so bundles follow connector changes.
- Put human-authored business logic in marts, metrics, and relationships.
- Prefix staging and mart names by integration to avoid multi-package collisions.
- Default staging models to views and marts to tables.

Key entrypoints are `src/loader.ts`, `src/installer.ts`, `src/generator.ts`, and
curated mart definitions under `marts/`.

## Verify

```bash
pnpm --filter @bobsled-inc/models build
pnpm --filter @bobsled-inc/models typecheck
pnpm --filter @bobsled-inc/models lint
pnpm --filter @bobsled-inc/models test:unit
```
