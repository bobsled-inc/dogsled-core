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

- Generation functions and `embedMany()` return discriminated unions or async iterables of union
  items. `connectHostEmbedding()` and its connection throw instead, because a failed request
  stops the stage.
- `embedMany()` reports provider failures per input; a failed call fails only its own chunk.
- `generateStructured()` returns `schema_violation` and available raw text when output
  validation fails.
- Provider switches must be exhaustive; use `assertExhaustive()`.
- `embeddingDimensionOptions()` sends a configured `dimension` only to models that are known
  to take one. Check the bundled provider package and the provider's documentation before
  adding one, and never send a dimension nobody configured.
- `connectHostEmbedding()` accepts `https` only, follows no redirect and refuses to run with
  certificate checks turned off. No project setting or variable relaxes any of it; the `fetch`
  option, which replaces the transport, is for tests. Its errors are fixed wording plus a status
  or network code: no URL, token, body, text, id or `cause`. The contract is
  `docs/reference/host-embeddings.md`; change both together.
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
