# Agentic publication benchmark

This opt-in benchmark runs complete incremental agentic runs through the real
coordinator, warehouse checkpoint store, warehouse cursor store and SQL publisher.
Only the warehouse is simulated: one in-memory PostgreSQL- or Snowflake-dialect
double keeps the checkpoint, cursor, publication metadata and target tables across
runner instances.
It models protocol decisions, not provider SQL acceptance, query planning, login
cost or billing. Each scenario prepares its state without latency, then measures one
run.

## What changed

A publication with no processed keys leaves the target unchanged, and its commit
never reads a stage. `prepare()` previously still dropped and rebuilt a
processed-key table and a stage, counted the retained rows, copied every existing
target row into the stage and checked the copy. On PostgreSQL it now counts and
checks an existing target in place when its columns compare values exactly like a
stage's.
The schema assertion, row limit, all final checks, the manifest, the fenced
version bump and the receipt are unchanged, and another publication between
prepare and commit still invalidates the claimed version.

Each run's preflight already creates a probe stage with the output schema. It now
creates the probe before asserting the target's schema, so the same information
schema query also returns the probe's column types and collations at no extra
request. A no-op checks in place only when every target column has the same type
and collation as the probe column; otherwise it stages the target as before. This
covers accepted type aliases such as `json`, column collations such as a
nondeterministic ICU collation, and schema default collations that a new stage
would take.

Only PostgreSQL documents `INFORMATION_SCHEMA.COLUMNS.COLLATION_NAME` as each
column's effective collation. Snowflake documents it as not applicable, BigQuery
does not document whether collations inherited from table or dataset defaults are
reported, and Databricks does not report it. Without that metadata a publication
cannot establish that a check compares values alike in place, so no-ops on those
warehouses are staged as before.

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

`PUBLICATION_BENCHMARK_DIALECT` selects `postgres` (default) or `snowflake`.
`PUBLICATION_BENCHMARK_LATENCY_MS` adds simulated latency to every measured request
(default `0`); `PUBLICATION_BENCHMARK_SAMPLES` sets repeated samples (default `3`).
PostgreSQL sends `BEGIN`, each statement and `COMMIT` as separate requests, and
Snowflake sends each transaction as one script, so their request counts differ.
Compare versions by running the same benchmark files in a worktree of the previous
commit, as described in `checkpoint-transport-benchmark.md`.

## Results

Measured on one Apple M3 Max laptop (Node.js 25.9.0, macOS) while other benchmark
jobs ran, so timings are indicative. Before is `main` at `8592f76`; after is this
change at `69fa29a`, which also includes the checkpoint processing work, so
checkpoint requests are shown separately. Request counts are deterministic. The
double does not model login, query planning or scan cost: a skipped copy of a
large target saves far more on a real warehouse than one request suggests.

**PostgreSQL, 0 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |   Run ms | Publisher ms |  Requests | Checkpoint requests | Publication requests | Publication DDL | Target copies |
| -------------------------------- | -------: | -----------: | --------: | ------------------: | -------------------: | --------------: | ------------: |
| Missing target, empty input      |  20 → 11 |        0 → 0 | 177 → 137 |            112 → 78 |              42 → 37 |          12 → 7 |         0 → 0 |
| Populated target, no new rows    |   17 → 7 |        1 → 0 | 181 → 138 |            112 → 78 |              46 → 38 |          12 → 5 |         1 → 0 |
| Second equivalent empty run      |   15 → 5 |        0 → 0 | 181 → 138 |            112 → 78 |              46 → 38 |          12 → 5 |         1 → 0 |
| Five changed rows                | 389 → 57 |        2 → 1 | 316 → 228 |           242 → 158 |              51 → 48 |         13 → 10 |         1 → 1 |
| Processed key without rows       | 369 → 60 |        2 → 1 | 316 → 228 |           242 → 158 |              51 → 48 |         13 → 10 |         1 → 1 |
| One new row advances the cursor  |  60 → 16 |        1 → 1 | 212 → 164 |            138 → 94 |              51 → 48 |         13 → 10 |         1 → 1 |
| Resume after an uncertain commit |  98 → 20 |        0 → 0 |   70 → 55 |             50 → 35 |                4 → 4 |           3 → 3 |         0 → 0 |

**PostgreSQL, 50 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |          Run ms |  Publisher ms |  Requests | Checkpoint requests | Publication requests | Publication DDL | Target copies |
| -------------------------------- | --------------: | ------------: | --------: | ------------------: | -------------------: | --------------: | ------------: |
| Missing target, empty input      |   9,089 → 7,016 | 2,250 → 1,943 | 177 → 137 |            112 → 78 |              42 → 37 |          12 → 7 |         0 → 0 |
| Populated target, no new rows    |   9,268 → 7,087 | 2,456 → 1,997 | 181 → 138 |            112 → 78 |              46 → 38 |          12 → 5 |         1 → 0 |
| Second equivalent empty run      |   9,269 → 7,068 | 2,455 → 1,992 | 181 → 138 |            112 → 78 |              46 → 38 |          12 → 5 |         1 → 0 |
| Five changed rows                | 16,528 → 11,746 | 2,708 → 2,511 | 316 → 228 |           242 → 158 |              51 → 48 |         13 → 10 |         1 → 1 |
| Processed key without rows       | 16,517 → 11,723 | 2,707 → 2,506 | 316 → 228 |           242 → 158 |              51 → 48 |         13 → 10 |         1 → 1 |
| One new row advances the cursor  |  10,895 → 8,398 | 2,710 → 2,503 | 212 → 164 |            138 → 94 |              51 → 48 |         13 → 10 |         1 → 1 |
| Resume after an uncertain commit |   3,741 → 2,833 |     256 → 256 |   70 → 55 |             50 → 35 |                4 → 4 |           3 → 3 |         0 → 0 |

**Snowflake, 0 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |   Run ms | Publisher ms |  Requests | Checkpoint requests | Publication requests | Publication DDL | Target copies |
| -------------------------------- | -------: | -----------: | --------: | ------------------: | -------------------: | --------------: | ------------: |
| Missing target, empty input      |  19 → 11 |        0 → 0 |  107 → 88 |             60 → 47 |              34 → 29 |          12 → 7 |         0 → 0 |
| Populated target, no new rows    |   17 → 8 |        1 → 0 |  111 → 94 |             60 → 47 |              38 → 35 |          12 → 9 |         1 → 1 |
| Second equivalent empty run      |   14 → 8 |        0 → 0 |  111 → 94 |             60 → 47 |              38 → 35 |          12 → 9 |         1 → 1 |
| Five changed rows                | 388 → 58 |        2 → 1 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| Processed key without rows       | 370 → 58 |        2 → 1 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| One new row advances the cursor  |  58 → 16 |        2 → 0 | 126 → 105 |             72 → 55 |              41 → 38 |         13 → 10 |         1 → 1 |
| Resume after an uncertain commit | 106 → 21 |        0 → 0 |   41 → 35 |             26 → 20 |                4 → 4 |           3 → 3 |         0 → 0 |

**Snowflake, 50 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |        Run ms |  Publisher ms |  Requests | Checkpoint requests | Publication requests | Publication DDL | Target copies |
| -------------------------------- | ------------: | ------------: | --------: | ------------------: | -------------------: | --------------: | ------------: |
| Missing target, empty input      | 5,507 → 4,525 | 1,846 → 1,534 |  107 → 88 |             60 → 47 |              34 → 29 |          12 → 7 |         0 → 0 |
| Populated target, no new rows    | 5,696 → 4,820 | 2,044 → 1,844 |  111 → 94 |             60 → 47 |              38 → 35 |          12 → 9 |         1 → 1 |
| Second equivalent empty run      | 5,690 → 4,822 | 2,046 → 1,843 |  111 → 94 |             60 → 47 |              38 → 35 |          12 → 9 |         1 → 1 |
| Five changed rows                | 9,276 → 7,108 | 2,200 → 1,999 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| Processed key without rows       | 9,279 → 7,080 | 2,196 → 1,994 | 174 → 137 |            120 → 87 |              41 → 38 |         13 → 10 |         1 → 1 |
| One new row advances the cursor  | 6,508 → 5,394 | 2,197 → 1,995 | 126 → 105 |             72 → 55 |              41 → 38 |         13 → 10 |         1 → 1 |
| Resume after an uncertain commit | 2,264 → 1,809 |     255 → 256 |   41 → 35 |             26 → 20 |                4 → 4 |           3 → 3 |         0 → 0 |

An empty PostgreSQL run against a populated target still makes 138 requests: 78
checkpoint requests for eight durable transitions, 18 cursor requests, 4 schema
creations and 38 publication requests. PostgreSQL sends `BEGIN`, each statement
and `COMMIT` separately. On Snowflake the same run makes 94 requests (47, 8, 4
and 35), and its publication requests still include the staged copy of the
target. Every run opens seven connections: one checkpoint session, two cursor
updates and four publisher operations.
