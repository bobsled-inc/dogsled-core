# @bobsled-inc/ai — Agent Guide

<!-- last-reviewed: 2026-11-25 -->

Dogsled's shared AI substrate. Keep this package small and provider-neutral.

## Scope

This package owns:

1. Resolving model-role connections into provider clients.
2. Enforcing per-call and per-project daily AI budgets.
3. Normalizing provider and schema failures into Dogsled result unions.
4. The client for an embedding model that a host application supplies.

Prompt orchestration, retrieval, extraction workflows, and domain agents belong in
their consuming packages.

## Invariants

- Public functions return discriminated unions or async iterables of union items.
- `embedMany()` reports per-input provider failures instead of failing the whole batch.
- `generateStructured()` returns `schema_violation` and available raw text when output
  validation fails.
- Provider switches must be exhaustive; use `assertExhaustive()`.
- `embeddingDimensionOptions()` sends a configured `dimension` only to models that the
  bundled provider package is known to support. Check its source before adding one, and
  never send a dimension nobody configured.
- `connectHostEmbedding()` accepts `https` only, follows no redirect and refuses to run with
  certificate checks turned off, with no option or variable to relax any of it. Its errors are
  fixed wording plus a status or network code: no URL, token, body, text, id or `cause`. Tests
  inject `fetch`. The contract is `docs/reference/host-embeddings.md`; change both together.
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
