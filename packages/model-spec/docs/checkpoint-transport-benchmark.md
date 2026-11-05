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
- The coordinator's receipt validator remembers the last state it validated. When
  the coordinator still holds that object and it serializes to the same JSON, the
  command is replayed on a copy and compared with the fully validated response.
  Any difference falls back to the complete check, which reports the original
  error.
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
`tests/integration/warehouse/README.md`. `postgres-rows` uses the dialect in test support, which
does not ship.

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

Statements per assignment settle at four: two per model call, plus a fixed cost per run. Time per
assignment still grows with the run, but no longer because of storage. The coordinator and the
store each validate the whole snapshot on every checkpoint, and the run loop is deliberately
unchanged. That is now the main cost, and it is why the row limits stay where they are.

**Why the limits stay at 1,000 rows.** To see whether the store could hold more, one run lifted the
ceilings temporarily, in a scratch change. At 2,000 assignments on a run file, statements stayed at
4.01 per assignment, the run sent 12.3 MB, and peak heap was 623 MiB with 863 MiB resident, so storage
and memory hold up. Time does not. Overhead reached 1,003 ms per assignment, double the
1,000-assignment figure, so a run's total overhead grows with the square of its size: 33 minutes at
2,000, and on the same curve about 3.5 hours at 5,000 and 14 hours at 10,000, before any model time.
Raising the limits first needs checkpoint validation that does not read the whole snapshot.

## Remaining work

Every transition still validates the whole new state twice (store and coordinator),
so total work grows with the square of plan size. The warehouse store also writes the
whole snapshot on each save, and issues a pointer read, a retained-size scan, its
payload INSERTs and the fenced pointer commit; the row layout removes that once a
warehouse dialect exists. Batching and reuse do not change billable dispatch
reservations, result acceptance, usage accounting, cursor or publication semantics.
Measure representative applications on real providers before drawing conclusions
about end-to-end production speedups.
