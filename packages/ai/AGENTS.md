# @bobsled-inc/ai — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

Bobsled Core's shared AI substrate. Keep this package small and provider-neutral.

## Scope

This package owns:

1. Resolving model-role connections into provider clients.
2. Enforcing per-call and per-project daily AI budgets.
3. Normalizing provider and schema failures into Bobsled Core result unions.

Prompt orchestration, retrieval, extraction workflows, and domain agents belong in
their consuming packages.

## Invariants

- Public functions return discriminated unions or async iterables of union items.
- `embedMany()` reports per-input provider failures instead of failing the whole batch.
- `generateStructured()` returns `schema_violation` and available raw text when output
  validation fails.
- Provider switches must be exhaustive; use `assertExhaustive()`.
- AI SDK and provider packages are bundled by `tsup.config.ts` and listed in
  `INLINED_AI_DEPENDENCY_NAMES`; keep that list synchronized with release staging and its
  regression tests so provider peer requirements never leak to Bobsled Core consumers.

## Verify

```bash
pnpm --filter @bobsled-inc/ai build
pnpm --filter @bobsled-inc/ai typecheck
pnpm --filter @bobsled-inc/ai lint
pnpm --filter @bobsled-inc/ai test:unit
```
