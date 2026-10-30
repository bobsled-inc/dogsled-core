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
existing target in place when every column compares like the stage's type. The
schema assertion, row limit, all final checks, the manifest, the fenced version
bump and the receipt are unchanged, and another publication between prepare and
commit still invalidates the claimed version. Targets that use PostgreSQL `json`
or Databricks `FLOAT` or `TIMESTAMP_NTZ` columns are staged as before. In-place
checks use the target's column collation, as the published rows do.

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
jobs ran, so timings are indicative. Before is the checkpoint-processing change
(`e351fa1`); after adds this change. Request counts are deterministic. The double does not model
login, query planning or scan cost: a skipped copy of a large target saves far more
on a real warehouse than one request suggests.

**0 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |  Run ms | Publisher ms |  Requests | Publication requests | Publication DDL | Target copies | Checks | Runners |
| -------------------------------- | ------: | -----------: | --------: | -------------------: | --------------: | ------------: | -----: | ------: |
| Missing target, empty input      |  9 → 15 |        0 → 0 |   94 → 88 |              34 → 29 |          12 → 7 |         0 → 0 |  8 → 8 |   7 → 7 |
| Populated target, no new rows    |   7 → 6 |        0 → 0 |   98 → 89 |              38 → 30 |          12 → 5 |         1 → 0 |  8 → 8 |   7 → 7 |
| Second equivalent empty run      |   6 → 5 |        0 → 0 |   98 → 89 |              38 → 30 |          12 → 5 |         1 → 0 |  8 → 8 |   7 → 7 |
| Five changed rows                | 54 → 52 |        1 → 1 | 141 → 137 |              41 → 38 |         13 → 10 |         1 → 1 |  8 → 8 |   7 → 7 |
| Processed key without rows       | 54 → 55 |        1 → 1 | 141 → 137 |              41 → 38 |         13 → 10 |         1 → 1 |  8 → 8 |   7 → 7 |
| One new row advances the cursor  | 14 → 14 |        1 → 1 | 109 → 105 |              41 → 38 |         13 → 10 |         1 → 1 |  8 → 8 |   7 → 7 |
| Resume after an uncertain commit | 17 → 18 |        0 → 0 |   35 → 35 |                4 → 4 |           3 → 3 |         0 → 0 |  0 → 0 |   4 → 4 |

**50 ms simulated request latency** (before → after; medians of three samples):

| Scenario                         |        Run ms |  Publisher ms |  Requests | Publication requests | Publication DDL | Target copies | Checks | Runners |
| -------------------------------- | ------------: | ------------: | --------: | -------------------: | --------------: | ------------: | -----: | ------: |
| Missing target, empty input      | 4,824 → 4,512 | 1,842 → 1,535 |   94 → 88 |              34 → 29 |          12 → 7 |         0 → 0 |  8 → 8 |   7 → 7 |
| Populated target, no new rows    | 5,010 → 4,559 | 2,042 → 1,584 |   98 → 89 |              38 → 30 |          12 → 5 |         1 → 0 |  8 → 8 |   7 → 7 |
| Second equivalent empty run      | 5,011 → 4,557 | 2,041 → 1,585 |   98 → 89 |              38 → 30 |          12 → 5 |         1 → 0 |  8 → 8 |   7 → 7 |
| Five changed rows                | 7,286 → 7,066 | 2,197 → 1,994 | 141 → 137 |              41 → 38 |         13 → 10 |         1 → 1 |  8 → 8 |   7 → 7 |
| Processed key without rows       | 7,266 → 7,068 | 2,199 → 1,994 | 141 → 137 |              41 → 38 |         13 → 10 |         1 → 1 |  8 → 8 |   7 → 7 |
| One new row advances the cursor  | 5,593 → 5,386 | 2,197 → 1,994 | 109 → 105 |              41 → 38 |         13 → 10 |         1 → 1 |  8 → 8 |   7 → 7 |
| Resume after an uncertain commit | 1,807 → 1,807 |     255 → 256 |   35 → 35 |                4 → 4 |           3 → 3 |         0 → 0 |  0 → 0 |   4 → 4 |

An empty run still makes 89 requests: 47 checkpoint requests for eight durable
transitions and the ownership reads between publication steps, 8 cursor requests,
4 schema creations, and 30 publication requests (preflight 12, prepare 12, claim 2,
commit 4). Every run acquires seven runners: one checkpoint session, two cursor
updates and four publisher operations. Each is a separate connection on
PostgreSQL, Snowflake and Databricks.
