# Warehouse checkpoint benchmark

This opt-in benchmark measures agentic checkpoint work with the real executor,
scheduler, checkpoint commands, receipts and warehouse checkpoint store. Only the SQL
transport is a deterministic double. Two changes are measured: batching payload
INSERTs (transport) and reducing repeated snapshot processing (CPU and payload reads).

## Transport batching

Warehouse checkpoint saves retain the existing version 2 snapshot and 64 KiB
base64 chunks. Each INSERT carries at most seven chunks (448 KiB of encoded
payload) and 21 bound values. SQL contains only quoted names and placeholders
and is normally a few KiB. The separate 64 KiB SQL guard is a defensive ceiling
for unexpectedly large namespace text; chunk count controls normal request size.
Snapshot IDs and ordinals add less than 1 KiB per batch. Base64 and IDs need no
JSON escaping; the remaining space below 1 MB accommodates driver parameter
metadata and transport framing.

The same parameterized multi-row `VALUES` syntax works through the existing
PostgreSQL, Snowflake, BigQuery, and Databricks runners. PostgreSQL placeholders
restart at `$1` in each request; the other runners use positional `?` markers.
The final batch contains only its remaining chunks. A single-chunk snapshot still
uses one INSERT.

These are intentionally conservative application bounds, rather than attempts to
maximize a provider's request limit:

- [Snowflake recommends at most 1 MB including bound values](https://docs.snowflake.com/en/user-guide/query-size-limits), measured uncompressed for safety.
- [BigQuery permits a 10 MB request, 10,000 parameters, and 1 MB unresolved GoogleSQL](https://docs.cloud.google.com/bigquery/quotas).
- [PostgreSQL permits 65,535 query parameters](https://www.postgresql.org/docs/17/limits.html).
- [Databricks documents 16 MiB query text for Statement Execution](https://docs.databricks.com/api/statement-execution/v1/statement-execution). The built-in runner uses its SQL driver; this benchmark does not establish a driver request ceiling.

The authoritative snapshot pointer and cleanup remain in the existing fenced
transaction after every batch succeeds. The store checks cancellation before each
batch and before committing the pointer, and retains lease renewal opportunities
between batches and before the final pointer transaction when renewal is due.
The renewal window includes retained-size reads and response delays. A single
request that outlasts the lease still fails under the existing ownership fence;
short leases need enough margin for individual warehouse requests. It does not
retry ambiguous writes. Table layout, chunk ordinals, digests, public APIs, and
stored snapshots are unchanged.

## Checkpoint processing

The second benchmark measures state processing rather than transport batching.
Every transition used to validate the whole snapshot about seven times: the store
read and parsed the prior snapshot, `applyAgenticCheckpoint` parsed its input and
result, the store parsed the result again before saving, and the coordinator parsed
the response and applied the command again with two more parses. Each validation
rebuilt Zod row schemas for every assignment and attempt outcome. A CPU profile of
the 100-assignment transport benchmark at 0 ms latency attributed 48% of samples to
row-schema construction and 84% to schema validation overall. Canonical hashing was
11%.

This change keeps the stored format and validation rules and removes repeated work:

- Scalar and metadata row field schemas are built once; array and object columns
  keep their own recursive schemas, so exported JSON Schemas are unchanged.
  Assignment validation builds the key schema once per assignment instead of once
  per processed key, and one-shot schemas that check a handful of values skip Zod's
  compiled fast path.
- Snapshot validation checks each attempt outcome against the already parsed
  assignment instead of parsing the assignment again.
- Structurally equal JSON is compared without hashing; any difference falls back
  to digest comparison, so results are unchanged.
- A warehouse session keeps the JSON text of the snapshot whose fenced pointer
  commit it confirmed or whose payload it verified. A command applies to that state
  only while the pointer, read under the owner and expiry predicate, still names
  it. The store transitions a private copy and validates the result once.
  `read()` always fetches and verifies the payload; bytes identical to the
  session's own commit skip only the second parse and hash.
- The coordinator does not validate a response twice over. A later change replaced
  this step: see [Checkpoint cost](agentic-state.md#checkpoint-cost). A command applied
  to verified state is compared with the response, and any difference takes the
  complete check, which reports the original error.
- The store renews before the retained-size query, each staging batch and the
  pointer transaction only when a third of the lease has elapsed since the last
  successful extension started.
  Acquisition and every fenced pointer commit extend the lease, so back-to-back
  saves no longer renew first; the commit remains fenced.
- Rebuilding a reduce step hashes upstream output keys once instead of once per
  marker.

### Workloads

`map` is one map step. `plan` maps four fifths of the rows and then reduces groups
of four in a second step, for the same assignment count. Every assignment returns
accepted rows with evidence, a confidence and a reason. Instructions and input
padding scale with the square root of plan size as in the transport benchmark, so
larger plans cross INSERT batch boundaries. Dates are frozen, limits are unlimited,
and both versions write byte-identical payloads.

The benchmark reports median executor and checkpoint time over repeated samples,
requests by operation, payload bytes written and read, complete snapshot
validations, canonical digests, and heap. Peak heap is sampled after each state
call and includes uncollected garbage. Set `CHECKPOINT_BENCHMARK_PROFILE` to a
directory to write a V8 CPU profile of one extra run and print inclusive time by
category.

## Reproduce

Build the workspace first with `pnpm build`. From the repository root:

```sh
CHECKPOINT_BENCHMARK=1 pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/unit/agentic/warehouse-checkpoint.bench.test.ts
```

Settings: `CHECKPOINT_BENCHMARK_SIZES` (default `0,5,100,300`),
`CHECKPOINT_BENCHMARK_SHAPES` (`map,plan`), `CHECKPOINT_BENCHMARK_LATENCY_MS`
(simulated latency per runner request, default `0`), `CHECKPOINT_BENCHMARK_SAMPLES`
(default `3`) and `CHECKPOINT_BENCHMARK_PROFILE` (a directory for CPU profiles). Allow
up to an hour for the largest baseline cases.

To compare with an earlier commit, run the same benchmark files there:

```sh
git worktree add /tmp/dogsled-baseline <baseline-commit>
cp packages/model-spec/tests/unit/agentic/warehouse-checkpoint.bench.test.ts \
  /tmp/dogsled-baseline/packages/model-spec/tests/unit/agentic/
cp packages/model-spec/tests/support/{agentic-benchmark,checkpoint-transport,snapshot-validations}.ts \
  /tmp/dogsled-baseline/packages/model-spec/tests/support/
(cd /tmp/dogsled-baseline && pnpm install --frozen-lockfile && pnpm build)
(cd /tmp/dogsled-baseline/packages/model-spec && CHECKPOINT_BENCHMARK=1 \
  npx vitest run tests/unit/agentic/warehouse-checkpoint.bench.test.ts)
```

The benchmark is skipped in normal unit runs and never requires warehouse
credentials or an inference service.

## Method

The SQL transport stores chunk rows and models pointer visibility; it does not
implement a provider SQL engine. Counts describe runner calls; a real driver may
submit, poll, or fetch through several network requests. Times use the real
monotonic clock. Checkpoint time sums awaited `create` and `checkpoint` calls;
executor time includes the full run. Payload bytes count base64 data, excluding
SQL, IDs and driver framing. Snowflake transaction scripts include cleanup in the
pointer request. Real heartbeat timers remain active, so long cases can include an
extra renewal. Snapshot validations count complete `AgenticRunSnapshotSchema`
parses; canonical digests count `json-canonicalize` calls. Elapsed times include
CPU processing, transport-double work and simulated waits; the optional profile
attributes CPU time.

## Results: checkpoint processing

Before is `main` at `8592f76`, which includes the batching, spend-cap and
recovery changes. After is this change at `7c89138`; its later commits produce identical counts for
every workload up to 100 assignments. Both ran the same benchmark
files in separate worktrees. Timings are medians of the listed samples; the
300-assignment baselines are single samples because each takes several minutes.
Measured on one Apple M3 Max laptop with Node.js 25.9.0 while other jobs ran, so
timings are indicative. Counts are deterministic, except that long runs can
include an extra heartbeat renewal.

**0 ms simulated request latency** (before → after):

| Shape | Assignments | Samples |    Executor s |  Checkpoint s |      Requests | Payload reads | Snapshot validations |      Canonical digests |
| ----- | ----------: | :-----: | ------------: | ------------: | ------------: | ------------: | -------------------: | ---------------------: |
| map   |           0 |  3 / 3  | 0.008 → 0.004 | 0.004 → 0.001 |       23 → 18 |         2 → 0 |               17 → 7 |               146 → 22 |
| map   |           5 |  3 / 3  |  0.24 → 0.043 |  0.13 → 0.021 |       83 → 58 |        12 → 0 |              87 → 27 |            2,131 → 142 |
| map   |         100 |  3 / 3  |   52.3 → 5.80 |   30.0 → 3.05 | 1,425 → 1,020 |       202 → 0 |          1,417 → 407 |       505,346 → 21,422 |
| map   |         300 |  1 / 3  |  464.3 → 47.8 |  266.2 → 25.3 | 5,371 → 4,166 |       602 → 0 |        4,217 → 1,207 |    4,455,746 → 184,222 |
| plan  |           0 |  3 / 3  | 0.016 → 0.007 | 0.009 → 0.003 |       35 → 26 |         4 → 0 |              31 → 11 |               498 → 44 |
| plan  |           5 |  3 / 3  |  0.36 → 0.061 |  0.20 → 0.030 |       95 → 66 |        14 → 0 |             101 → 31 |          6,769 → 1,546 |
| plan  |         100 |  3 / 3  |   78.7 → 8.56 |   45.1 → 4.46 | 1,480 → 1,071 |       204 → 0 |          1,431 → 411 |    3,293,978 → 368,284 |
| plan  |         300 |  1 / 3  |  716.7 → 70.9 |  410.6 → 36.9 | 5,449 → 4,240 |       604 → 0 |        4,231 → 1,211 | 61,608,138 → 3,240,764 |

**50 ms simulated request latency** (before → after):

| Shape | Assignments | Samples |   Executor s | Checkpoint s |      Requests | Payload reads | Snapshot validations |   Canonical digests |
| ----- | ----------: | :-----: | -----------: | -----------: | ------------: | ------------: | -------------------: | ------------------: |
| map   |           5 |  1 / 1  |  4.67 → 3.04 |  4.22 → 2.69 |       83 → 58 |        12 → 0 |              87 → 27 |         2,131 → 142 |
| map   |         100 |  1 / 1  | 127.4 → 58.3 | 103.7 → 55.1 | 1,428 → 1,021 |       202 → 0 |          1,417 → 407 |    505,346 → 21,422 |
| plan  |           5 |  1 / 1  |  5.85 → 3.46 |  5.09 → 3.10 |       95 → 66 |        14 → 0 |             101 → 31 |       6,769 → 1,546 |
| plan  |         100 |  1 / 1  | 157.0 → 63.7 | 121.9 → 59.0 | 1,483 → 1,072 |       204 → 0 |          1,431 → 411 | 3,293,978 → 368,284 |

Payload bytes and heap at 0 ms (before → after). Written bytes are identical:

| Shape | Assignments | Final snapshot bytes | Payload bytes written | Payload bytes read | Peak heap MiB | Retained heap MiB |
| ----- | ----------: | -------------------: | --------------------: | -----------------: | ------------: | ----------------: |
| map   |           0 |               53,573 |               214,268 |        142,836 → 0 |    15.5 → 6.8 |         0.1 → 0.2 |
| map   |           5 |              107,334 |             1,670,612 |      1,527,500 → 0 |   72.3 → 30.4 |         0.5 → 0.3 |
| map   |         100 |              622,559 |           140,292,672 |    139,462,592 → 0 | 275.5 → 304.8 |         1.5 → 1.3 |
| map   |         300 |            1,481,084 |           943,098,352 |    941,123,572 → 0 | 294.9 → 332.8 |           4.4 → 1 |
| plan  |           0 |               55,682 |               370,584 |        296,340 → 0 |   36.6 → 13.2 |         0.1 → 0.1 |
| plan  |           5 |              114,360 |             1,830,092 |      1,677,612 → 0 |     99.4 → 59 |         0.3 → 0.2 |
| plan  |         100 |              815,951 |           140,771,516 |    139,683,580 → 0 | 302.9 → 299.2 |         0.9 → 0.7 |
| plan  |         300 |            2,096,976 |           966,945,744 |    964,149,776 → 0 | 318.8 → 348.5 |         1.9 → 1.5 |

CPU attribution for one profiled 100-assignment run at 0 ms, inclusive seconds (before → after). Categories overlap:

| Category                   |        map |       plan |
| -------------------------- | ---------: | ---------: |
| Sampled total              | 53.7 → 5.6 | 79.8 → 8.5 |
| Zod validation             | 46.9 → 4.1 | 70.5 → 6.7 |
| Row schema construction    | 24.2 → 1.0 | 37.0 → 1.5 |
| Attempt outcome validation | 17.6 → 0.8 | 18.9 → 0.8 |
| Consistency checks         |  4.2 → 0.2 | 27.2 → 2.7 |
| Receipt validation         | 20.9 → 2.3 | 31.1 → 3.6 |
| Canonical digests          |  6.9 → 0.5 |  9.5 → 0.9 |
| Bounded JSON scans         |  4.8 → 1.3 |  7.1 → 1.9 |
| Garbage collection         |  3.8 → 0.3 |  5.9 → 0.6 |

Payload bytes written do not change: every save still writes the whole snapshot.
Peak heap is sampled after state calls and includes uncollected garbage. A session
now retains the JSON text of its last committed snapshot, and the coordinator the
last validated state and its JSON, for the session's lifetime.

## Results: transport batching

Measured for the batching change with the earlier version of this benchmark: an
executor that returned no output rows, 1, 5, 100 and 300 assignments, 1 ms
simulated latency and single samples. These rows are not comparable with the
processing results above.

Results are single local observations with the simulated latency above, not
production throughput predictions. Deterministic query-count assertions in
`warehouse-batching.test.ts` protect the request reduction without wall-time gates.

Before → after; times are seconds. Both versions use 1 ms simulated request latency.

| Assignments | Payload INSERTs | Total runner requests | Payload bytes (both) | Checkpoint elapsed | Executor elapsed  |
| ----------- | --------------- | --------------------- | -------------------- | ------------------ | ----------------- |
| 1           | 10 → 5          | 40 → 35               | 520,748              | 0.061 → 0.056      | 0.093 → 0.091     |
| 5           | 29 → 13         | 99 → 83               | 1,599,452            | 0.234 → 0.229      | 0.334 → 0.337     |
| 100         | 1,905 → 405     | 2,926 → 1,426         | 117,925,664          | 29.845 → 29.389    | 49.306 → 50.063   |
| 300         | 11,647 → 1,807  | 14,677 → 4,837        | 743,047,572          | 249.744 → 236.125  | 422.189 → 407.165 |

Operation counts for the same runs (before → after):

| Assignments | DDL   | Ownership | Pointer reads | Payload reads | Retained-size reads | Pointer commits |
| ----------- | ----- | --------- | ------------- | ------------- | ------------------- | --------------- |
| 1           | 3 → 3 | 7 → 7     | 6 → 6         | 4 → 4         | 5 → 5               | 5 → 5           |
| 5           | 3 → 3 | 15 → 15   | 14 → 14       | 12 → 12       | 13 → 13             | 13 → 13         |
| 100         | 3 → 3 | 206 → 206 | 204 → 204     | 202 → 202     | 203 → 203           | 203 → 203       |
| 300         | 3 → 3 | 615 → 615 | 604 → 604     | 602 → 602     | 603 → 603           | 603 → 603       |

A separate matched five-assignment run with **50 ms simulated request latency** used 29 → 13 payload INSERTs and 99 → 83 total runner requests. Checkpoint elapsed time was 5.102 → 4.279 seconds (16.1% lower); executor elapsed was 5.721 → 4.894 seconds. Payload bytes remained 1,599,452.

At 1 ms simulated latency, CPU and transport-double work dominate the larger plans; elapsed-time differences are small relative to total execution time and run-to-run variability. The higher-latency case shows the benefit of fewer serialized requests under simulated transport latency. Neither measurement establishes a real-provider or production speedup. Compare versions within a row: padding differs across plan sizes.

Measured on Node.js 25.9.0 with pnpm 10.30.2 on macOS arm64. These are single observations without statistical significance claims. The initial 300-assignment run exceeded the old five-minute benchmark harness timeout; the completed result used the documented fifteen-minute harness limit with unchanged workload and production settings.

After tightening renewal around slow warehouse requests, a five-assignment
50 ms simulated-latency rerun retained 13 payload INSERTs, 83 total runner
requests, and 1,599,452 payload bytes (4.139 s checkpoint elapsed; 4.672 s executor
elapsed). The tables above capture the initial batching measurements. The
follow-up changes when renewals become due; the frozen-date benchmark keeps
its fast-path request counts unchanged.

## Row layout

The [row layout](agentic-state.md#row-layout) writes only what changed, so what a checkpoint writes
no longer grows with the run. This benchmark measures it on real engines: DuckDB in process
and PostgreSQL over a local socket. It uses the workloads above and counts every statement at the
runner boundary. Each run is the real executor, scheduler, receipts and store. Only the model call
is synthetic, and it returns at once, so these numbers are store overhead and not run length.

```sh
CHECKPOINT_BENCHMARK=1 pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/integration/agentic-row-state.bench.test.ts
```

Settings: `CHECKPOINT_BENCHMARK_STORES` (`file`, `duckdb-run-file`, `duckdb-shared`,
`postgres-warehouse`, `postgres-rows`), `CHECKPOINT_BENCHMARK_SIZES`,
`CHECKPOINT_BENCHMARK_SHAPES`, `CHECKPOINT_BENCHMARK_SAMPLES` and
`CHECKPOINT_BENCHMARK_LATENCY_MS`. The PostgreSQL stores use the settings in
`tests/integration/warehouse/README.md`. `postgres-rows` is `createWarehouseRowStore`.

Measured on one Apple M3 Max laptop with Node.js 25.9.0, and PostgreSQL 17 in Docker on the same
machine, while other jobs ran. Before and after ran in the same session on the same code, so compare
within a row; timings are indicative. Timings are medians of the listed samples. The 1,000-assignment
row-layout PostgreSQL figure is the median of three runs of 492, 567 and 1,858 ms per assignment; the
slowest ran during a load spike that slowed the coordinator by the same factor. Statement and byte
counts are deterministic.

**PostgreSQL, 0 ms added latency** (warehouse store → row layout):

| Shape | Assignments | Samples | Statements per assignment | Checkpoint ms per assignment | Run ms per assignment |
| ----- | ----------: | :-----: | ------------------------: | ---------------------------: | --------------------: |
| map   |           5 |  3 / 3  |              22.60 → 6.80 |                   21.8 → 7.4 |           30.6 → 15.2 |
| map   |         100 |  3 / 3  |              18.35 → 4.14 |                  68.9 → 32.9 |           96.9 → 57.9 |
| map   |         300 |  3 / 3  |              21.95 → 4.05 |                 174.0 → 77.5 |         251.3 → 150.9 |
| map   |       1,000 |  1 / 3  |              33.92 → 4.03 |                457.3 → 273.9 |         705.9 → 567.3 |
| plan  |           5 |  3 / 3  |              25.80 → 7.60 |                  23.4 → 11.4 |           34.6 → 23.6 |
| plan  |         100 |  3 / 3  |              18.94 → 4.18 |                  86.5 → 47.0 |          127.4 → 87.2 |
| plan  |         300 |  3 / 3  |              22.24 → 4.07 |                211.3 → 119.3 |         324.1 → 237.5 |

**PostgreSQL, 50 ms added per statement.** A local socket hides what statements cost, so this adds
a delay per statement, as the transport benchmark does:

| Shape | Assignments | Statements per assignment | Run ms per assignment |
| ----- | ----------: | ------------------------: | --------------------: |
| map   |         100 |              18.43 → 4.14 |       1,143.6 → 296.2 |
| plan  |         100 |              19.02 → 4.18 |       1,181.4 → 323.6 |

**DuckDB project** (file store → one DuckDB file per run). DuckDB could not hold checkpoints
before, so the file store is the baseline. It issues no statements. Each rewrite is a full snapshot
with an fsync:

| Shape | Assignments | Samples | Before: file rewrites per assignment | After: statements per assignment | Checkpoint ms per assignment | Run ms per assignment |
| ----- | ----------: | :-----: | -----------------------------------: | -------------------------------: | ---------------------------: | --------------------: |
| map   |           5 |  3 / 3  |                                 5.20 |                             6.60 |                   90.6 → 6.2 |           99.2 → 16.0 |
| map   |         100 |  3 / 3  |                                 4.06 |                             4.13 |                 195.1 → 28.4 |          222.7 → 56.1 |
| map   |         300 |  3 / 3  |                                 4.02 |                             4.05 |                 465.8 → 75.7 |         544.7 → 152.2 |
| map   |       1,000 |  1 / 2  |                                 4.01 |                             4.02 |              1,449.7 → 247.0 |       1,709.8 → 506.4 |
| plan  |           5 |  3 / 3  |                                 6.00 |                             7.40 |                  115.6 → 9.6 |          128.4 → 22.4 |
| plan  |         100 |  3 / 3  |                                 4.10 |                             4.17 |                 263.8 → 44.3 |          305.3 → 87.3 |
| plan  |         300 |  3 / 3  |                                 4.03 |                             4.06 |                675.8 → 121.6 |         797.9 → 241.4 |

**Data each run sends or rewrites.** The old stores grow with the square of the run:

| Assignments | File store rewrites (MB) | PostgreSQL warehouse store sends (MB) | Row store sends (MB) |
| ----------: | -----------------------: | ------------------------------------: | -------------------: |
|         100 |                    105.3 |                                 141.0 |                  0.9 |
|         300 |                    707.5 |                                 946.2 |                  2.3 |
|       1,000 |                  6,476.6 |                               8,656.9 |                  7.0 |

**DuckDB `checkpoint_store`**, which opens its file for each operation:

| Shape | Assignments | Statements per assignment | File opens | Checkpoint ms per assignment | Run ms per assignment |
| ----- | ----------: | ------------------------: | ---------: | ---------------------------: | --------------------: |
| map   |           5 |                      7.00 |         17 |                         22.4 |                  31.0 |
| map   |         100 |                      4.15 |        207 |                         46.3 |                  74.4 |
| map   |         300 |                      4.06 |        608 |                         94.0 |                 168.7 |
| map   |       1,000 |                      4.03 |      2,020 |                        272.9 |                 526.5 |
| plan  |           5 |                      7.80 |         19 |                         30.2 |                  42.6 |
| plan  |         100 |                      4.19 |        209 |                         61.1 |                 102.1 |
| plan  |         300 |                      4.07 |        610 |                        131.6 |                 243.5 |

These counts predate two later checks. Setup now confirms what the tables are, which adds up to
three statements per run, and a DuckDB `checkpoint_store` repeats that on every operation, which
adds about 11 ms to each. A load that rebuilds a run from its rows checks the total first, which
adds one statement, and it names the writes it reads, which adds one for each 1,024 past the first.

Statements per assignment settle at four: two per model call, plus a fixed cost per run. In these
figures time per assignment still grows with the run, but no longer because of storage. The
coordinator and the store each validated the whole snapshot on every checkpoint: a CPU profile put
80% of a 1,000-assignment run on a run file inside schema validation, and 77% at 300. A later change
removed that cost. See [checkpoint cost](agentic-state.md#checkpoint-cost) for the figures since.

**What the limits looked like at 2,000 rows.** To see whether the store could hold more, this was
measured with the row limits temporarily raised. At 2,000 assignments on a run file, statements stayed at
4.01 per assignment, the run sent 12.3 MB, and peak heap was 623 MiB with 863 MiB resident, so storage
and memory hold up. Time does not. Overhead reached 1,003 ms per assignment, double the
1,000-assignment figure, so a run's total overhead grows with the square of its size: 33 minutes at
2,000, and on the same curve about 3.5 hours at 5,000 and 14 hours at 10,000, before any model time.
Checkpoint validation no longer reads the whole snapshot, so that curve is gone, and the same run
now takes seconds. See [row store limits](agentic-state.md#row-store-limits) for the limits that
followed, and [the row store at 10,000 assignments](#row-store-at-10000-assignments) for their
measurement.

## Row store header tables

The row store keeps one header row per run, and every checkpoint ends with one fenced update of that
row. So the question for a warehouse is what those updates do as runs are added, and how many tables
they need. This benchmark starts that many real runs at once, each in its own process so that they
contend at the database rather than for one event loop. Every statement is timed at the runner
boundary. The model call is synthetic and returns at once, which is the worst case for the table:
nothing spaces the updates out.

```sh
CHECKPOINT_BENCHMARK=1 pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/integration/warehouse/row-store-contention.bench.test.ts
```

It runs on PostgreSQL with `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=postgres` and the settings in
`tests/integration/warehouse/README.md`, and on Snowflake with
`DOGSLED_MODEL_SPEC_CHECKPOINT_INTEGRATION` and `DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA`. Settings:
`CHECKPOINT_BENCHMARK_RUNS` (default `1,4,8,16`), `CHECKPOINT_BENCHMARK_ASSIGNMENTS` (per run,
default `100`), `CHECKPOINT_BENCHMARK_SAMPLES` (default `3`), `CHECKPOINT_BENCHMARK_MODEL_MS`
(default `0`), `CHECKPOINT_BENCHMARK_HEADER_TABLES` (the size of the Snowflake header set to measure,
where `1` is one table, default the size that ships),
`CHECKPOINT_BENCHMARK_STORE` (`warehouse` for the store this replaces) and
`CHECKPOINT_BENCHMARK_OUTPUT` (a file for one JSON line per sample). On Snowflake, 30 assignments and
one sample are enough: 16 runs on one table take about ten minutes.

**PostgreSQL 17, real engine.** 100 assignments per run, the median of 3 samples of each measure, on
one Apple M3 Max laptop with Node.js 25.9 and PostgreSQL in Docker, while other jobs ran:

| Runs at once | Statements per assignment | Header updates per second | Header update p50 / p95 | Row insert p50 / p95 | Failures |
| -----------: | ------------------------: | ------------------------: | ----------------------: | -------------------: | -------: |
|            1 |                      4.14 |                        33 |            1.6 / 2.1 ms |         2.0 / 2.7 ms |        0 |
|            4 |                      4.14 |                       129 |            1.3 / 2.2 ms |         1.8 / 3.2 ms |        0 |
|            8 |                      4.14 |                       226 |            1.5 / 3.3 ms |         2.6 / 6.4 ms |        0 |
|           16 |                      4.14 |                       241 |           2.9 / 13.4 ms |        6.2 / 27.2 ms |        0 |

Header updates scale with the runs, because PostgreSQL locks rows and each run updates its own. At
16 runs throughput stops rising and latency goes up, but the cause is the machine rather than the
table: the row inserts, which contend for nothing, slow down at least as much as the header updates.

**Snowflake, real account.** 30 assignments per run, one sample, run from one laptop. This first
table is what led to a set of header tables. Spreading the runs across 8 schemas, by a hash of the
run, gives each group its own header table and its own rows table, with no change to the store:

| Runs at once | One table: calls a minute | Per run | Header update p50 / p95 | 8 schemas: calls a minute | Per run | Header update p50 / p95 |
| -----------: | ------------------------: | ------: | ----------------------: | ------------------------: | ------: | ----------------------: |
|            1 |                      20.4 |    20.4 |          550 / 1,090 ms |                      21.4 |    21.4 |            563 / 857 ms |
|            4 |                      52.2 |    13.0 |        1,133 / 2,734 ms |                      74.0 |    18.5 |          565 / 1,145 ms |
|            8 |                      56.8 |     7.1 |        2,745 / 4,128 ms |                     163.9 |    20.5 |          546 / 1,048 ms |
|           16 |                      52.1 |     3.3 |        6,219 / 8,034 ms |                     243.6 |    15.2 |          657 / 2,567 ms |

No run failed in any configuration. Statements per assignment were 4.57 to 4.93 on one table and 4.57
to 4.59 across eight schemas. They are above four because a 30-assignment run has a larger fixed share, and on one
table a run that waits renews its lease more often.

Latency per statement with one run: a header update 550 ms, a row insert 532 ms, a read about 290 ms,
a table setup statement 234 ms and the first-row script 1,631 ms. Row inserts stay at 500 to 590 ms
here, but that does not show that appends are free. On one table the header queue holds inserts to
about two a second, and the runs across 8 schemas split the rows table as well as the headers. The
first-row script queues on its guard, up to 13 seconds with 16 runs starting together, but it runs
once per run.

Updates of one table do run one at a time on Snowflake. In this sample they ran at about 2.2 a
second, so a shared table stopped scaling at about four runs and held a schema to about 55 model
calls a minute however many runs shared it. Past that point the total fell, because a run waiting in
the queue still renews its lease, and renewals join the same queue. At 16 runs a header update waited
6.2 seconds and a run did 3.3 calls a minute. Eight schemas took that wait back to 0.7 seconds and
gave 4.7 times the total.

**A set of header tables, same account and workload.** Inside one schema the store picks a table from
a hash of the run, and all runs share one rows table. One sample of each size, while other jobs ran
on the laptop:

| Tables | Runs at once | Calls a minute | Per run | Statements per assignment | Header update p50 / p95 | Row insert p50 |
| -----: | -----------: | -------------: | ------: | ------------------------: | ----------------------: | -------------: |
|      8 |            1 |           17.7 |    17.7 |                      4.47 |          599 / 1,523 ms |         559 ms |
|      8 |            4 |           67.5 |    16.9 |                      4.47 |          548 / 1,163 ms |         600 ms |
|      8 |            8 |          111.9 |    14.0 |                      4.47 |          601 / 1,413 ms |         639 ms |
|      8 |           16 |          125.3 |     7.8 |                      4.53 |          602 / 1,901 ms |       2,185 ms |
|     16 |            1 |           19.7 |    19.7 |                      4.47 |          589 / 1,234 ms |         524 ms |
|     16 |            4 |           80.2 |    20.0 |                      4.44 |            532 / 927 ms |         555 ms |
|     16 |            8 |          127.9 |    16.0 |                      4.47 |          539 / 1,068 ms |         671 ms |
|     16 |           16 |          133.0 |     8.3 |                      4.53 |          549 / 1,126 ms |       2,242 ms |

No run failed. Each row is one sample, and passes with the same number of runs differed by up to
19%, 67.5 against 80.2 calls a minute at 4 runs, so only large gaps mean anything. With 16 runs a
header update's median stayed at its single-run value on both sizes: 602 ms against 599 on 8
tables, and 549 ms against 589 on 16. So 8 was enough in this sample, and 16 improved only the p95,
because 16 runs cannot all get a table of their own from a hash of 8. Four tables were not
measured, but they would put about four runs on each, and four runs on one table took 1,133 ms.

The limit then moved, probably to the rows table. Row inserts stayed under 700 ms up to 8 runs and
reached 2.2 seconds at 16. Counting each pass's row inserts over its elapsed time, they levelled off
at 4.3 and 4.6 a second with 16 runs on the two sizes, and the total stopped near 130 calls a
minute. The spread across schemas went further, to 243.6, which is consistent with its having eight
rows tables. At 16 runs in this sample, a set of 8 tables gave 2.4 times the total of one table,
125.3 calls a minute against 52.1, rather than the 4.7 times of the spread, and a header update's
median fell from 6.2 seconds to 0.6.

**Before and after, same account and workload.** One run of 30 assignments on the store this replaces
took 8.77 statements per assignment and did 7.7 calls a minute, against 4.57 and 20.4, in one sample.
Its transaction scripts took 2,033 ms each at the median. It writes the whole run at every
checkpoint, so its writes get larger as a run grows, but neither store was measured at 1,000 rows
here.

**What ships: one header table on PostgreSQL, and a fixed set of 8 on Snowflake.**

- **PostgreSQL:** measured above, runs do not contend. A fixed set would add nothing.
- **Snowflake:** 8 header tables, chosen by a hash of the run. In this sample it was the smaller of
  the two sizes measured that kept a header update near its single-run median at 16 runs. Eight
  tables also divide the queue of waiting statements, which
  [public reports](https://community.streamsets.com/community-articles-and-got-a-question-7/jdbcqueryexecutor-can-t-execute-querynet-snowflake-client-jdbc-snowflakesqlexception-2177)
  say Snowflake aborts at 20 waiters.

A host that needs more than the roughly 130 calls a minute seen here can give different models
different schemas, which divides the rows table too. A model's runs must stay in one schema, because
its cursor lives there.

## Row store at 10,000 assignments

The [row store limits](agentic-state.md#row-store-limits) come from this measurement. It runs the
real executor, scheduler, receipts and store with the synthetic workload above, at a payload that
keeps each assignment the same size at every run size, about 4.2 KB and 134 JSON values, and a
model call that returns at once. Each run goes through three processes, so that the peak memory of
each is its own: the first starts the run and stops it once 90% of its assignments are done, the
second resumes it as after a crash and finishes it, and the third opens the finished run again.

```sh
CHECKPOINT_BENCHMARK=1 pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/integration/agentic-row-limits.bench.test.ts
```

Settings: `CHECKPOINT_BENCHMARK_STORES` (`duckdb-run-file`, `duckdb-shared`, `postgres-rows` and
`snowflake-rows`, and `file` and `postgres-warehouse` for the stores they replace),
`CHECKPOINT_BENCHMARK_SIZES` (default `1000,2000,5000,10000`), `CHECKPOINT_BENCHMARK_SHAPES`,
`CHECKPOINT_BENCHMARK_STOP_SHARE` (default `0.9`), `CHECKPOINT_BENCHMARK_PUBLISH=1` for a publisher
that writes nothing, `CHECKPOINT_BENCHMARK_PAYLOAD` (smaller makes each assignment larger),
`CHECKPOINT_BENCHMARK_NODE_OPTIONS`, for example a heap limit, and `CHECKPOINT_BENCHMARK_OUTPUT`.
`CHECKPOINT_BENCHMARK_BULK` is the number of assignments a run on a warehouse row store leaves to
its resume when the rest is written in bulk, 40 by default on `snowflake-rows` and none elsewhere.
In bulk mode, `CHECKPOINT_BENCHMARK_PUBLICATION=1` also publishes the finished run, and
`CHECKPOINT_BENCHMARK_PHASES` chooses the phases. PostgreSQL uses the settings in
`tests/integration/warehouse/README.md`, and Snowflake the two checkpoint variables there.

Measured on one Apple M3 Max laptop with Node.js 25.9.0, and PostgreSQL 17 in Docker on the same
machine, one sample of each row with nothing else running. Per assignment is the time between model
calls over the last quarter of the first process, which covers both checkpoints of a call and the
coordinator's work. Set up runs from the start of a run to its first model call, and complete is the
`complete` checkpoint. Resume runs from the start of the second process to its first model call:
opening the run, validating it and starting a new execution window. Reopen is opening the finished
run in the third process. Peak memory is the largest resident set of the three processes, about 270 MiB of which is
the process itself, and open run is the heap that the second process still held for the run after
a collection. Statements stayed at 4.0 per model call on PostgreSQL at every size.

| Store                     | Assignments | Per assignment | Set up | Complete | Resume | Reopen | Peak memory | Open run |
| ------------------------- | ----------: | -------------: | -----: | -------: | -----: | -----: | ----------: | -------: |
| DuckDB run file           |       1,000 |         2.5 ms | 616 ms |   208 ms | 834 ms | 611 ms |     595 MiB |   13 MiB |
| DuckDB run file           |       2,000 |         2.6 ms | 936 ms |   398 ms |  1.5 s |  1.1 s |     770 MiB |   21 MiB |
| DuckDB run file           |       5,000 |         2.7 ms |  2.3 s |   984 ms |  3.5 s |  2.5 s |    1.15 GiB |   42 MiB |
| DuckDB run file           |      10,000 |         2.9 ms |  3.9 s |    2.0 s |  6.9 s |  4.8 s |    1.82 GiB |   75 MiB |
| PostgreSQL                |       1,000 |         2.5 ms | 524 ms |   209 ms | 813 ms | 602 ms |     562 MiB |   12 MiB |
| PostgreSQL                |       2,000 |         2.6 ms | 889 ms |   407 ms |  1.5 s |  1.0 s |     782 MiB |   20 MiB |
| PostgreSQL                |       5,000 |         3.0 ms |  1.9 s |   964 ms |  3.4 s |  2.7 s |    1.05 GiB |   43 MiB |
| PostgreSQL                |      10,000 |         3.2 ms |  3.8 s |    2.1 s |  6.8 s |  4.8 s |    1.67 GiB |   74 MiB |
| DuckDB `checkpoint_store` |       1,000 |        50.0 ms | 692 ms |   229 ms | 889 ms | 657 ms |     645 MiB |   12 MiB |
| DuckDB `checkpoint_store` |       2,000 |        51.1 ms |  1.0 s |   459 ms |  1.5 s |  1.1 s |     672 MiB |   18 MiB |
| DuckDB `checkpoint_store` |       5,000 |        54.4 ms |  2.2 s |    1.0 s |  3.5 s |  2.6 s |    1.08 GiB |   39 MiB |
| DuckDB `checkpoint_store` |      10,000 |        51.6 ms |  4.0 s |    2.0 s |  6.9 s |  4.9 s |    1.58 GiB |   75 MiB |

**Before and after.** Before is v0.1.10, measured with the row limits temporarily raised, on the
same machine and harness. At 1,000 that is v0.1.10 as released. Opening a run, starting a new
execution window and completing a run each validate the whole run fewer times now, so resuming
takes 34 to 43% less time and completing a run 37 to 42% less. Reopening a finished run takes up to
13% more, because the opened run is now kept as verified state, which is what makes the next
command cheap:

| Store                     | Assignments | Per assignment |            Resume |         Complete |           Reopen |         Peak memory |
| ------------------------- | ----------: | -------------: | ----------------: | ---------------: | ---------------: | ------------------: |
| DuckDB run file           |       1,000 |   2.3 → 2.5 ms |    1,260 → 834 ms |     346 → 208 ms |     611 → 611 ms |   641 MiB → 595 MiB |
| DuckDB run file           |      10,000 |   3.0 → 2.9 ms | 11,659 → 6,911 ms | 3,344 → 2,046 ms | 4,452 → 4,789 ms | 2.00 GiB → 1.82 GiB |
| PostgreSQL                |       1,000 |   2.8 → 2.5 ms |    1,324 → 813 ms |     360 → 209 ms |     567 → 602 ms |   592 MiB → 562 MiB |
| PostgreSQL                |      10,000 |   3.0 → 3.2 ms | 11,558 → 6,809 ms | 3,462 → 2,058 ms | 4,286 → 4,765 ms | 1.95 GiB → 1.67 GiB |
| DuckDB `checkpoint_store` |       1,000 | 50.8 → 50.0 ms |    1,350 → 889 ms |     366 → 229 ms |     582 → 657 ms |   683 MiB → 645 MiB |
| DuckDB `checkpoint_store` |      10,000 | 52.4 → 51.6 ms | 12,050 → 6,879 ms | 3,456 → 2,041 ms | 4,381 → 4,904 ms | 1.68 GiB → 1.58 GiB |

**Other workloads, on a DuckDB run file.** A plan that maps four fifths of its rows and then
reduces groups of four holds 199 JSON values per assignment, so at 10,000 it is near the checkpoint's
2,097,152. Each step that reads such a run takes about 3.5 seconds, and the longest stretch without
a pause, 4.7 seconds, builds and appends the 8,000 assignments of its first step. Published uses a
publisher that writes nothing, so its complete column is everything from the last model call to the
end. Publication proves ownership by reading the whole run again, two times before the first model
call and five after the last, and each read of 10,000 assignments takes about 2.5 seconds. Larger assignments use a
payload that brings 10,000 of them to 131 MB, just inside the 128 MiB limit:

| Workload                | Assignments |                Snapshot | Per assignment | Set up | Complete | Resume | Reopen | Peak memory | Open run |
| ----------------------- | ----------: | ----------------------: | -------------: | -----: | -------: | -----: | -----: | ----------: | -------: |
| Map then reduce         |       1,000 |   6.4 MB, 0.20 M values |         3.1 ms | 736 ms |   368 ms |  1.4 s | 989 ms |     778 MiB |   17 MiB |
| Map then reduce         |      10,000 |  64.5 MB, 1.99 M values |         3.3 ms |  6.0 s |    3.6 s | 11.6 s |  8.3 s |    2.25 GiB |  106 MiB |
| Map, published          |       1,000 |   4.2 MB, 0.13 M values |         2.5 ms | 544 ms |    2.1 s |  1.3 s | 616 ms |     774 MiB |   13 MiB |
| Map, published          |      10,000 |  42.5 MB, 1.34 M values |         2.6 ms |  3.9 s |   20.9 s | 11.9 s |  5.0 s |    3.08 GiB |   78 MiB |
| Map, larger assignments |       1,000 |  13.1 MB, 0.13 M values |         3.0 ms | 636 ms |   221 ms | 919 ms | 678 ms |     832 MiB |   22 MiB |
| Map, larger assignments |      10,000 | 130.8 MB, 1.34 M values |         3.0 ms |  5.1 s |    2.2 s |  8.1 s |  5.5 s |    3.78 GiB |  163 MiB |

**Memory under a heap limit.** V8 collects lazily on a machine with plenty of memory, so the peak
resident sets above say little about what a run needs. These ran 10,000 assignments, the resume and
the reopen, with `--max-old-space-size` set through `CHECKPOINT_BENCHMARK_NODE_OPTIONS`, starting at
256 MiB and stopping at the first heap that passed. Each smaller heap failed with V8 out of memory.
A run takes longer under a tight heap: resuming the map workload took 9.2 seconds in 384 MiB, against
6.9 without a limit.

| Workload                | Snapshot | Smallest heap that passed | Peak memory at that heap |
| ----------------------- | -------: | ------------------------: | -----------------------: |
| Map                     |  42.5 MB |                   384 MiB |                  1.0 GiB |
| Map, published          |  42.5 MB |                   768 MiB |                  1.5 GiB |
| Map, larger assignments | 130.8 MB |                     1 GiB |                  2.4 GiB |

### On Snowflake

A checkpoint on Snowflake took about a second here, so running every assignment of a
10,000-assignment run would take hours. In bulk mode, the default for `snowflake-rows`, the first process instead
starts another run of the same size and stops it at its first model call, which times setting up and
sealing the whole run. The second writes the measured run with all but its last 40 assignments done,
through the store's own backend and batched inserts. The third resumes it and finishes it, the fourth
reopens it, and with `CHECKPOINT_BENCHMARK_PUBLICATION=1`, as here, a fifth publishes it through a
publisher that writes nothing. Opening the run
through the store verifies every write and validates the whole run, so a mistake in the bulk writer
reads as a damaged run, never as a fast one. Each run has a schema of its own, which the benchmark
drops afterwards. One sample per size, on a real account, from the same laptop:

| Store     | Assignments | Per assignment | Set up | Complete | Resume | Reopen | Peak memory | Open run |
| --------- | ----------: | -------------: | -----: | -------: | -----: | -----: | ----------: | -------: |
| Snowflake |       1,000 |          2.5 s | 27.5 s |   772 ms | 11.8 s | 11.7 s |     548 MiB |   34 MiB |
| Snowflake |       2,000 |          2.5 s | 36.1 s |    1.1 s | 15.5 s | 13.4 s |     767 MiB |   41 MiB |
| Snowflake |       5,000 |          2.4 s | 60.5 s |    1.6 s | 22.8 s | 23.4 s |    1.14 GiB |   64 MiB |
| Snowflake |      10,000 |          2.6 s | 96.3 s |    2.7 s | 39.7 s | 33.3 s |    1.61 GiB |   97 MiB |

Per assignment is the time between model calls over the last ten of the 40 that the resume runs:
four statements per model call at every size, at about 0.6 seconds each. Set up includes about ten
seconds of creating the store's tables in a new schema, which a schema pays once. Peak memory leaves
out the bulk writer, which is not part of a run.

Every step that reads or writes the whole run is many statements there, and the session renews its
lease between them, so what the lease has to outlast is one statement or one stretch of local work.
Under the default lease of two minutes, a statement may take 60 seconds and a stretch starts with 108. Load is opening the finished run, and publication's reads are the opening read and the seven
that prove ownership:

| Assignments |                  Seal |                  Load | Publication's reads | Longest statement | Longest stretch |
| ----------: | --------------------: | --------------------: | ------------------: | ----------------: | --------------: |
|       1,000 |  8.4 s, 10 statements |   5.2 s, 5 statements |           22.5 s, 8 |             3.2 s |          727 ms |
|       2,000 | 15.1 s, 18 statements |   7.7 s, 7 statements |           30.2 s, 8 |             2.5 s |           1.4 s |
|       5,000 | 40.7 s, 44 statements | 15.5 s, 14 statements |           80.8 s, 8 |             2.7 s |           3.2 s |
|      10,000 | 72.2 s, 86 statements | 24.9 s, 24 statements |          147.9 s, 8 |             4.2 s |           6.5 s |

A load's longest statement grew from 1.5 seconds at 1,000 assignments to 3.3 at 10,000, and one of
publication's reads at 10,000 had a statement of 4.2. Each statement of a load returns the rows of at
most 1,024 writes, and one of them also holds every sealed assignment. With the largest checkpoint,
10,000 larger assignments and 131 MB, a load took 28 to 30 seconds in 24 statements, its longest
statement 3.2 seconds and the longest stretch 7.1, and resuming took 42 seconds at 2.83 GiB peak.

The shortest lease, 10 seconds, leaves five seconds per statement, and a statement in a run of 1,000
took 3.2, so it does not suit Snowflake at any size. The measurement took about 71 minutes of
warehouse time: 34 for `cloud-row-store.test.ts`, with its case at the limit, 26 for the four sizes
with publication, and 11 for the largest checkpoint.

## Remaining work

The warehouse store still validates the whole new state on every transition, so its
total work grows with the square of plan size. It also writes the
whole snapshot on each save, and issues a pointer read, a retained-size scan, its
payload INSERTs and the fenced pointer commit; the row layout removes that for a host
that opts in. Batching and reuse do not change billable dispatch
reservations, result acceptance, usage accounting, cursor or publication semantics.
Measure representative applications on real providers before drawing conclusions
about end-to-end production speedups.
