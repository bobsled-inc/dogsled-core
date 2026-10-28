# @bobsled-inc/entity-graph — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

Owns Entity Graph CLI commands and the resolution, review, clustering,
survivorship, truthset, mention, relationship, and agent-task workflows.

## Boundaries

- Keep Entity Graph compilers here; generic modeling primitives belong in
  `@bobsled-inc/model-spec`.
- Import shared project loading, formatter, dialect, and command utilities from
  public `@bobsled-inc/model-spec` entrypoints.
- Keep command modules thin. Structured workflows live under `src/api/`.
- `dogsled entity-graph` delegates to this package's CLI entrypoint.
- Use `src/runtime/project-context.ts` and `src/runtime/runner-resolver.ts` for
  project and runner resolution.

## Workflow Invariants

- `__review_decisions` remains the review source of truth.
- Public relationship consumers read `__entity_relationship`;
  `__entity_relationship_edge` is staging.
- Agent-judge failures are fail-soft and appear in structured results.
- API modules return data; command shells own user-facing output.
- Agent-consumable JSON results also support YAML unless the output is a stream or
  fixed external contract.
- Normalize legacy configuration names before returning compiled objects.

## Security And Testing

- Treat user-provided paths as untrusted and reuse guarded path helpers.
- Use shared output helpers, never `console.*`; set `process.exitCode`, never call
  `process.exit()`.
- Add regression tests for compiler and command behavior changes.
- Native database scenarios belong in `tests/integration/`; `test:unit` must not
  load DuckDB or other database runtimes.

## Verify

```bash
pnpm --filter @bobsled-inc/entity-graph build
pnpm --filter @bobsled-inc/entity-graph typecheck
pnpm --filter @bobsled-inc/entity-graph lint
pnpm --filter @bobsled-inc/entity-graph test:unit
```
