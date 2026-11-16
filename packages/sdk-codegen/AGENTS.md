# @bobsled-inc/sdk-codegen — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

Pure transformation from compiled Entity Graph IR to typed SDK source.

## Scope

This package owns:

1. Loading and validating the `ir_version: '1.0'` contract.
2. Emitting TypeScript SDKs with branded IDs and executor-backed clients.
3. Emitting Python SDKs with Pydantic v2 models.

Do not add runtime entity resolution, prompt orchestration, business logic, or
database drivers. Generated SDKs are vendored into consumer repositories; they are
not independently published by this workflow.

## Compatibility

- Treat IR additions as minor and renames/removals as major changes.
- Keep `polymorphic_groups[]` present even when empty.
- TypeScript output supports TypeScript 5.0 through 5.4.
- Python output supports Python 3.10+ and Pydantic v2.
- Python emission remains library-only until its CLI distribution plan is active.
- The consumer supplies `BobsledEntityExecutor`; generated clients stay transport-free.

## Verify

```bash
pnpm --filter @bobsled-inc/sdk-codegen build
pnpm --filter @bobsled-inc/sdk-codegen typecheck
pnpm --filter @bobsled-inc/sdk-codegen lint
pnpm --filter @bobsled-inc/sdk-codegen test:unit
```
