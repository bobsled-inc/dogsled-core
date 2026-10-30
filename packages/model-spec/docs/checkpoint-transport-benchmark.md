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
- The store renews before staging and before the pointer transaction only when a
  third of the lease has elapsed since the last successful extension started.
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

Before is the batching change at its review head (`a2e87f5`). The merged `main`
(`454dc83`) produces identical counts for every workload up to 100 assignments:
its final pre-commit renewal never triggers under the benchmark's frozen clock.
After is this change, measured at `82f8449`; its later commits also produce
identical counts up to 100 assignments. Both ran the same benchmark files in
separate worktrees. Timings are
medians of the listed samples; the 300-assignment baselines are single samples
because each takes 8 to 13 minutes. Measured on one Apple M3 Max laptop with
Node.js 25.9.0 while other jobs ran, so timings are indicative. Counts are
deterministic, except that long runs can include an extra heartbeat renewal.

**0 ms simulated request latency** (before → after):

| Shape | Assignments | Samples |    Executor s |  Checkpoint s |      Requests | Payload reads | Snapshot validations |      Canonical digests |
| ----- | ----------: | :-----: | ------------: | ------------: | ------------: | ------------: | -------------------: | ---------------------: |
| map   |           0 |  3 / 3  | 0.007 → 0.004 | 0.003 → 0.001 |       23 → 18 |         2 → 0 |               17 → 7 |               145 → 21 |
| map   |           5 |  3 / 3  |  0.31 → 0.043 |  0.18 → 0.021 |       83 → 58 |        12 → 0 |              87 → 27 |            2,130 → 141 |
| map   |         100 |  3 / 3  |   55.6 → 5.71 |   31.9 → 2.98 | 1,425 → 1,020 |       202 → 0 |          1,417 → 407 |       505,345 → 21,421 |
| map   |         300 |  1 / 3  |  470.1 → 47.1 |  270.0 → 25.0 | 5,363 → 4,158 |       602 → 0 |        4,217 → 1,207 |    4,455,745 → 184,221 |
| plan  |           0 |  3 / 3  | 0.017 → 0.007 | 0.009 → 0.003 |       35 → 26 |         4 → 0 |              31 → 11 |               497 → 43 |
| plan  |           5 |  3 / 3  |  0.39 → 0.069 |  0.22 → 0.033 |       95 → 66 |        14 → 0 |             101 → 31 |          6,768 → 1,545 |
| plan  |         100 |  3 / 3  |   78.4 → 9.27 |   44.9 → 4.77 | 1,480 → 1,071 |       204 → 0 |          1,431 → 411 |    3,293,977 → 368,283 |
| plan  |         300 |  1 / 3  |  752.3 → 70.4 |  430.4 → 36.7 | 5,444 → 4,235 |       604 → 0 |        4,231 → 1,211 | 61,608,137 → 3,240,763 |

**50 ms simulated request latency** (before → after):

| Shape | Assignments | Samples |   Executor s | Checkpoint s |      Requests | Payload reads | Snapshot validations |   Canonical digests |
| ----- | ----------: | :-----: | -----------: | -----------: | ------------: | ------------: | -------------------: | ------------------: |
| map   |           5 |  1 / 1  |  4.98 → 3.04 |  4.33 → 2.69 |       83 → 58 |        12 → 0 |              87 → 27 |         2,130 → 141 |
| map   |         100 |  1 / 1  | 129.2 → 58.2 | 103.9 → 54.9 | 1,428 → 1,021 |       202 → 0 |          1,417 → 407 |    505,345 → 21,421 |
| plan  |           5 |  1 / 1  |  5.60 → 3.45 |  4.97 → 3.10 |       95 → 66 |        14 → 0 |             101 → 31 |       6,768 → 1,545 |
| plan  |         100 |  1 / 1  | 158.9 → 63.6 | 122.3 → 59.1 | 1,483 → 1,072 |       204 → 0 |          1,431 → 411 | 3,293,977 → 368,283 |

Payload bytes and heap at 0 ms (before → after). Written bytes are identical:

| Shape | Assignments | Final snapshot bytes | Payload bytes written | Payload bytes read | Peak heap MiB | Retained heap MiB |
| ----- | ----------: | -------------------: | --------------------: | -----------------: | ------------: | ----------------: |
| map   |           0 |               53,500 |               213,980 |        142,644 → 0 |    15.3 → 6.5 |         0.2 → 0.2 |
| map   |           5 |              107,151 |             1,668,272 |      1,525,404 → 0 |   71.9 → 30.1 |         0.4 → 0.2 |
| map   |         100 |              620,286 |           139,960,244 |    139,133,196 → 0 |   289 → 290.2 |         1.5 → 1.3 |
| map   |         300 |            1,474,411 |           940,261,988 |    938,296,104 → 0 | 322.2 → 320.8 |         4.3 → 1.3 |
| plan  |           0 |               55,609 |               370,096 |        295,948 → 0 |   36.1 → 12.9 |         0.1 → 0.1 |
| plan  |           5 |              114,177 |             1,827,460 |      1,675,224 → 0 |   96.7 → 59.1 |         0.3 → 0.2 |
| plan  |         100 |              813,678 |           140,440,812 |    139,355,908 → 0 | 300.7 → 315.1 |         0.8 → 0.6 |
| plan  |         300 |            2,090,303 |           964,140,416 |    961,353,344 → 0 | 342.6 → 364.6 |         1.8 → 3.5 |

CPU attribution for one profiled 100-assignment run at 0 ms, inclusive seconds (before → after). Categories overlap:

| Category                   |        map |       plan |
| -------------------------- | ---------: | ---------: |
| Sampled total              | 58.9 → 5.6 | 81.9 → 9.6 |
| Zod validation             | 51.4 → 4.2 | 72.3 → 7.6 |
| Row schema construction    | 26.4 → 1.0 | 38.1 → 1.7 |
| Attempt outcome validation | 19.5 → 0.8 | 19.5 → 0.9 |
| Consistency checks         |  4.4 → 0.2 | 27.8 → 3.1 |
| Receipt validation         | 22.9 → 2.3 | 31.9 → 4.1 |
| Canonical digests          |  7.4 → 0.5 |  9.6 → 0.9 |
| Bounded JSON scans         |  5.4 → 1.3 |  7.1 → 2.2 |
| Garbage collection         |  4.2 → 0.4 |  6.2 → 0.7 |

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

## Remaining work

Every transition still validates the whole new state twice (store and coordinator)
and writes the whole snapshot, so total work grows with the square of plan size.
Each save still issues a pointer read, a retained-size scan, its payload INSERTs and
the fenced pointer commit. Reducing written bytes needs a new persistence format,
such as an append-only command log with periodic compaction, and a staged rollout
because older readers cannot read it. Batching and reuse do not change billable
dispatch reservations, result acceptance, usage accounting, cursor or publication
semantics. Measure representative applications on real providers before drawing
conclusions about end-to-end production speedups.
