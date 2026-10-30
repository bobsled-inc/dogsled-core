# Agentic publication benchmark

This opt-in benchmark runs complete incremental agentic runs through the real
coordinator, warehouse checkpoint store, warehouse cursor store and SQL publisher.
Only the warehouse is simulated: one in-memory Snowflake-dialect double keeps the
checkpoint, cursor, publication metadata and target tables across runner instances.
It models protocol decisions, not provider SQL acceptance, query planning, login
cost or billing. Each scenario prepares its state without latency, then measures one
run.

## What changed

A publication with no processed keys leaves the target unchanged, and its commit
never reads a stage. `prepare()` previously still dropped and rebuilt a
processed-key table and a stage, counted the retained rows, copied every existing
target row into the stage and checked the copy. It now counts and checks an
existing target in place when its columns compare values exactly like a stage's.
The schema assertion, row limit, all final checks, the manifest, the fenced
version bump and the receipt are unchanged, and another publication between
prepare and commit still invalidates the claimed version.

Each run's preflight already creates a probe stage with the output schema. It now
creates the probe before asserting the target's schema, so the same information
schema query also returns the probe's column types and collations at no extra
request. A no-op checks in place only when every target column has the same type
and collation as the probe column; otherwise it stages the target as before. This
covers accepted type aliases such as PostgreSQL `json`, column collations such as
a nondeterministic ICU collation, and schema or account default collations that a
new stage would take. Databricks does not report collations in its information
schema, and a probe in a different BigQuery dataset is not listed with the target,
so those no-ops are staged.

A publication to a missing target no longer builds the processed-key table, which
is read only to retain rows from an existing target. Preflight and inspection
always initialize the publication tables; the claim that follows reuses that work
until an operation fails.

## Scenarios

The incremental single-step model processes rows whose `updated_at` exceeds the
saved cursor. "Populated" targets were written by a prior run of 100 rows.

- Missing target, empty input: the first run sees no rows.
- Populated target, no new rows: a genuinely empty incremental run.
- Second equivalent empty run: the same, after an earlier empty run.
- Five changed rows: five keys are reprocessed and replaced.
- Processed key without rows: as above, but one answer has no rows, removing that
  key's prior output.
- One new row advances the cursor: one new key is inserted.
- Resume after an uncertain commit: the commit applies but its response is lost
  and the reconciling inspection fails; the measured run resumes, finds the
  receipt, confirms it and only then advances the cursor.

## Reproduce

```sh
PUBLICATION_BENCHMARK=1 pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/unit/agentic/agentic-publication.bench.test.ts
```

`PUBLICATION_BENCHMARK_LATENCY_MS` adds simulated latency to every measured request
(default `0`); `PUBLICATION_BENCHMARK_SAMPLES` sets repeated samples (default `3`).
Compare versions by running the same benchmark files in a worktree of the previous
commit, as described in `checkpoint-transport-benchmark.md`.

## Results

Measured on one Apple M3 Max laptop (Node.js 25.9.0, macOS) while other benchmark
jobs ran, so timings are indicative. Before is `main` at `8592f76`; after is this
change at `7c89138`, which also includes the checkpoint processing work, so
checkpoint requests are shown separately. Request counts are deterministic. The
double does not model login, query planning or scan cost: a skipped copy of a
large target saves far more on a real warehouse than one request suggests.

**0 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |   Run ms | Publisher ms |  Requests | Checkpoint requests | Publication requests | Publication DDL | Target copies |
| -------------------------------- | -------: | -----------: | --------: | ------------------: | -------------------: | --------------: | ------------: |
| Missing target, empty input      |   18 → 9 |        0 → 0 |  107 → 88 |             60 → 47 |              34 → 29 |          12 → 7 |         0 → 0 |
| Populated target, no new rows    |   15 → 7 |        0 → 0 |  111 → 89 |             60 → 47 |              38 → 30 |          12 → 5 |         1 → 0 |
| Second equivalent empty run      |   12 → 5 |        0 → 0 |  111 → 89 |             60 → 47 |              38 → 30 |          12 → 5 |         1 → 0 |
| Five changed rows                | 376 → 58 |        2 → 1 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| Processed key without rows       | 373 → 53 |        2 → 1 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| One new row advances the cursor  |  61 → 14 |        2 → 0 | 126 → 105 |             72 → 55 |              41 → 38 |         13 → 10 |         1 → 1 |
| Resume after an uncertain commit |  99 → 19 |        0 → 0 |   41 → 35 |             26 → 20 |                4 → 4 |           3 → 3 |         0 → 0 |

**50 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |        Run ms |  Publisher ms |  Requests | Checkpoint requests | Publication requests | Publication DDL | Target copies |
| -------------------------------- | ------------: | ------------: | --------: | ------------------: | -------------------: | --------------: | ------------: |
| Missing target, empty input      | 5,563 → 4,601 | 1,846 → 1,564 |  107 → 88 |             60 → 47 |              34 → 29 |          12 → 7 |         0 → 0 |
| Populated target, no new rows    | 5,792 → 4,647 | 2,072 → 1,616 |  111 → 89 |             60 → 47 |              38 → 30 |          12 → 5 |         1 → 0 |
| Second equivalent empty run      | 5,783 → 4,638 | 2,077 → 1,614 |  111 → 89 |             60 → 47 |              38 → 30 |          12 → 5 |         1 → 0 |
| Five changed rows                | 9,430 → 7,194 | 2,239 → 2,032 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| Processed key without rows       | 9,436 → 7,198 | 2,241 → 2,030 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| One new row advances the cursor  | 6,631 → 5,486 | 2,242 → 2,032 | 126 → 105 |             72 → 55 |              41 → 38 |         13 → 10 |         1 → 1 |
| Resume after an uncertain commit | 2,229 → 1,840 |     261 → 259 |   41 → 35 |             26 → 20 |                4 → 4 |           3 → 3 |         0 → 0 |

An empty run still makes 89 requests: 47 checkpoint requests for eight durable
transitions and the ownership reads between publication steps, 8 cursor requests,
4 schema creations, and 30 publication requests (preflight 12, prepare 12, claim 2,
commit 4). Every run acquires seven runners: one checkpoint session, two cursor
updates and four publisher operations. Each is a separate connection on
PostgreSQL, Snowflake and Databricks.
