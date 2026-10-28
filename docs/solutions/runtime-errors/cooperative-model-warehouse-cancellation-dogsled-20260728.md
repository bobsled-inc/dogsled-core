---
module: dogsled model execution
date: 2026-07-28
problem_type: runtime_error
component: model-spec runProject and warehouse runners
symptoms:
  - 'AbortSignal was absent from the public runProject contract.'
  - 'Promise-only abort handling could return while warehouse work continued.'
  - 'Late runner or publisher success could advance model state after cancellation.'
root_cause: Cancellation was not a driver-acknowledged execution contract across the model orchestrator, SQL runner, and publisher boundaries.
severity: high
tags: [model-spec, cancellation, abort-signal, warehouse, runner]
---

# Cooperative Model Warehouse Cancellation

## Symptom

Programmatic model consumers could not stop an active `runProject` warehouse operation.
Adding only a `Promise.race` would have made the public promise reject while the database
statement continued consuming compute or committing writes. Cancellation during runner
resolution, schema setup, verification, or publishing could also allow later work to begin
or successful state to be persisted.

## Investigation

Each built-in driver was inspected for an actual cancellation primitive. Cleanup methods
such as `close()` were rejected as a universal answer because they do not consistently
cancel active jobs. Abort checks only at loop boundaries were also insufficient: an abort
can land while a driver is returning the statement/job handle.

The usable primitives were DuckDB `interrupt()`, BigQuery `Job.cancel()`, Snowflake
statement `cancel()`, Databricks operation `cancel()`, and Postgres
`pg_cancel_backend(pid)` through a separate connection.

## Root Cause

The public API, compiler executor, runner types, provider adapters, model state machine,
and cross-warehouse publisher had no shared cooperative-cancellation protocol. Without
late handle registration and operation settlement, submit-then-abort races left work
running. Without post-await guards, a resolved operation could be recorded as successful
after its signal had already aborted.

## Solution

- Add optional `signal?: AbortSignal` execution options while preserving one-argument
  custom runners.
- Route built-in driver calls through `runCancellable`, registering the real driver
  canceller as soon as its handle exists.
- Wait for cancellation delivery and active-operation settlement before returning the
  typed `SqlCancelledError`.
- Check the signal before and after asynchronous setup boundaries and before every later
  statement, schema operation, verification step, and published model.
- Return `RunProjectResult.cancelled === true`, mark unfinished models `cancelled`, omit
  successful state advancement, and always close resolved runners.
- Track state keys committed by the current invocation explicitly. A pre-existing state
  entry proves only that an earlier run completed; it must not turn a provisional SQL
  success into a successful result when current-run verification is cancelled.
- Give database destinations an optional `cancel()` capability for publisher loads;
  cancellation-aware orchestration requires it instead of treating `close()` as cancel.
- Keep shared authentication-token producers independent from individual request signals,
  while racing each caller against its own signal so one cancellation cannot affect a
  sibling request.

## Prevention

For every new runner or destination, prove the specific driver cancellation primitive in
tests. Cover already-aborted, abort during active work, late handle registration,
cancel-delivery failure, operation settlement, no later dispatch, state preservation, and
the unchanged no-signal call shape. Repeat verification-abort coverage with pre-existing
state. Never equate rejection of the wrapper promise with cancellation of warehouse work.

## Related Issues
