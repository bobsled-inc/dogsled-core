# Warehouse checkpoint transport benchmark

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
retry ambiguous writes or cache previously read snapshots. Table layout, chunk ordinals, digests, public APIs, and stored snapshots
are unchanged.

## Reproduce

Build the workspace first with `pnpm build`. From the repository root:

```sh
CHECKPOINT_BENCHMARK=1 pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/unit/agentic/warehouse-checkpoint.bench.test.ts
```

To measure the original store with precisely the same fixture and transport:

```sh
git show a7736698bb39619ff9d8be749cf5f6d7955d591a:packages/model-spec/src/agentic/warehouse-state.ts \
  > packages/model-spec/src/agentic/warehouse-state.baseline.ts
trap 'rm -f packages/model-spec/src/agentic/warehouse-state.baseline.ts' EXIT
CHECKPOINT_BENCHMARK=1 CHECKPOINT_BENCHMARK_BASELINE=1 \
  pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/unit/agentic/warehouse-checkpoint.bench.test.ts
```

The baseline file is temporary. Remove it before other checks or commits. The
benchmark is skipped in normal unit runs and never requires warehouse credentials
or an inference service. Allow up to fifteen minutes per case on slower machines.

The benchmark runs the real `executeAgenticRun`, scheduling, checkpoint commands,
validation, serialization, reads, and warehouse state store. A deterministic
executor settles two measured tokens per assignment and returns no output rows.
Plans contain 1, 5, 100, or 300 assignments with synthetic instructions and input
evidence. Padding scales with the square root of plan size to keep the workload
bounded while crossing chunk and batch boundaries. Both versions use identical
inputs, a frozen wall date, and unlimited execution limits.

Only the SQL transport is mocked. It stores chunk rows and models pointer
visibility, and does not implement a provider SQL engine. It adds **simulated
1 ms latency per runner request**, configurable with
`CHECKPOINT_BENCHMARK_LATENCY_MS` (set `0` to remove artificial delays). Counts describe
runner calls; a real driver may submit, poll, or fetch through several network
requests. Times use the real monotonic clock. Checkpoint elapsed time sums awaited
`create` and `checkpoint` calls; executor elapsed time includes the full run.
Payload bytes count base64 data written across every checkpoint, excluding SQL,
IDs, and driver framing. Request output groups DDL, ownership, pointer reads,
payload reads, retained-size reads, payload INSERTs, and pointer commits. Snowflake
transaction scripts include cleanup in the pointer request. Real heartbeat timers
remain active, so ownership and total request counts can include an extra renewal
when a case crosses a heartbeat interval. Payload INSERT counts and byte totals
are independent of those timer ticks. Elapsed times include CPU processing,
transport-double work, and simulated waits; they do not isolate CPU time.

## Results

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

Full-snapshot byte amplification, prior-snapshot reads, retained-size scans,
validation, hashing, and serialized durable transitions remain. Large plans can
still spend substantial CPU time in snapshot processing. Batching does not change
billable dispatch reservations, result acceptance, usage accounting, cursor or
publication semantics. Measure representative applications on real providers
before drawing conclusions about end-to-end production speedups. Provider-specific
queueing, job polling, transaction behavior, and billing are outside the simulated
benchmark.
