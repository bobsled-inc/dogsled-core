# @bobsled-inc/ai — Agent Guide

<!-- last-reviewed: 2026-11-25 -->

Dogsled's shared AI substrate. Keep this package small and provider-neutral.

## Scope

This package owns:

1. Resolving model-role connections into provider clients.
2. Enforcing per-call and per-project daily AI budgets.
3. Normalizing provider and schema failures into Dogsled result unions.

Prompt orchestration, retrieval, extraction workflows, and domain agents belong in
their consuming packages.

## Invariants

- Generation and embedding functions return discriminated unions or async iterables of union
  items.
- `embedMany()` reports provider failures per input; a failed call fails only its own chunk.
- `generateStructured()` returns `schema_violation` and available raw text when output
  validation fails.
- Provider switches must be exhaustive; use `assertExhaustive()`.
- AI SDK and provider packages are bundled by `tsup.config.ts` and listed in
  `INLINED_AI_DEPENDENCY_NAMES`; keep that list synchronized with release staging and its
  regression tests so provider peer requirements never leak to Dogsled consumers.

## Verify

```bash
pnpm --filter @bobsled-inc/ai build
pnpm --filter @bobsled-inc/ai typecheck
pnpm --filter @bobsled-inc/ai lint
pnpm --filter @bobsled-inc/ai test:unit
```
