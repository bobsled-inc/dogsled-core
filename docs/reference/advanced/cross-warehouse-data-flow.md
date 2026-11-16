# Cross-Warehouse Publishing Data Flow And Residency

This doc covers the data path, credential lifecycle, encryption, and residency considerations for `publish:` models.

For setup steps, see [`cross-warehouse-cookbook.md`](cross-warehouse-cookbook.md). For current boundaries, see [`cross-warehouse-limitations.md`](cross-warehouse-limitations.md).

## Data Path

Each source chooses a substrate independently.

```text
UNLOAD-capable source
  [Snowflake / BigQuery / Databricks / DuckDB]
        |
        | native UNLOAD / EXPORT as Parquet
        v
  [shared staging URI]
        |
        | destination loadFromUri()
        v
  [destination _xwh_stage_* table]

Streaming fallback source
  [Postgres / source with no UNLOAD / failed UNLOAD]
        |
        | driver TLS stream
        v
  [Dogsled host temp chunks]
        |
        | destination loadAndFinalize()
        v
  [destination _xwh_stage_* table]

All staged sources
        |
        | destination warehouse executes model SELECT
        v
  [destination _xwh_result_* table]
        |
        | table / incremental / snapshot materialization
        v
  [destination target table]
```

The Dogsled host orchestrates every step. On the UNLOAD path, source row data does not pass through the Dogsled host; the host submits SQL and load jobs. On the streaming fallback path, source row data does pass through the Dogsled host in bounded JSONL or Parquet chunks.

## What Touches Dogsled Host Disk

UNLOAD path:

- No source row files are written by Dogsled.
- Credentials are not written to disk.
- Local temp directory is still created for a uniform cleanup lifecycle, but it does not hold source rows unless a source falls back to streaming.

Streaming fallback:

- Local temp directory under `${TMPDIR}/Dogsled-xwh-<safe_model_name>-XXXXXX`
- Mode `0700` on POSIX, best-effort `chmod`
- JSONL chunks by default, or Parquet chunks when `BOBSLED_CORE_XWH_STAGING_FORMAT=parquet`
- Removed in `finally`; SIGINT/SIGTERM handlers also remove the directory before re-raising the signal

Encryption at rest depends on the host. Managed cloud runners and customer infrastructure should provide disk encryption. Dogsled does not encrypt fallback chunks at the application layer.

## What Touches Dogsled Host Memory

UNLOAD path:

- SQL strings, job metadata, URI lists, row counts, and warnings
- No source row payloads

Streaming fallback:

- Bounded driver reads and `RecordBuffer` batches
- Default flush threshold is 10,000 records
- The final model SELECT is still executed in the destination, not in local DuckDB

## Credential Lifecycle

- Source and destination credentials enter through `${{ env.VAR }}` interpolation in `integrations/<handle>.yml`, optionally layered with `--secrets <path>`.
- Resolved credentials live in process memory on runner/destination objects for the duration of the publish.
- Dogsled does not write credentials to `.bobsled/model-spec/run-state.json`, checkpoints, staging files, or docs.
- OAuth source credentials are rejected for published models because long publishes can outlive token TTLs.

## Logging And Redaction

The publisher scrubs resolved secret values from `onWarn` and `onError` callbacks:

- Secrets with length at least 8 are added to a per-publish scrub set.
- Longer values are replaced first to avoid leaving suffixes visible.
- Short secrets are not auto-redacted; use real-length credential values.

Logs are emitted through the normal Dogsled CLI paths. The publisher does not send customer data to any external log sink.

## Cross-Region Data Movement

UNLOAD path:

- Source rows move from the source warehouse to the shared staging URI using the source warehouse's native export mechanism.
- Destination rows move from the staging URI into the destination warehouse.
- Dogsled host location matters for control-plane access, not row-data residency.

Streaming fallback:

- Source rows transit through the Dogsled host region before loading into the destination.
- Local temp chunks briefly live in the Dogsled host region.

Customers with data-residency constraints should place the shared staging URI and Dogsled host in approved regions and verify warehouse-side egress policy. Dogsled does not infer or validate region compatibility.

## Staging Retention

- Local fallback files are removed on success and failure.
- Destination `_xwh_stage_*` and `_xwh_result_*` tables are dropped in `finally` on success and failure.
- If a destination drop fails, Dogsled emits a redacted warning and continues cleanup.
- Object-store files written by native UNLOAD are not deleted by Dogsled today. Configure lifecycle policy on the staging prefix.

## What Dogsled Does Not Do

- Dogsled never sends source rows to Dogsled cloud or another third party.
- Dogsled does not aggregate customer metadata.
- Dogsled does not persist source rows beyond the publish lifecycle, except for warehouse-native UNLOAD files left in the operator-controlled staging URI.
- Dogsled does not manage cloud IAM, Snowflake storage integrations, Databricks external locations, or BigQuery bucket policy.

## Audit Trail

Useful audit artifacts:

- `dogsled model run` stderr or JSON output
- `.bobsled/model-spec/run-state.json` with per-model `lastRunAt`, `publishedSnapshotId`, and `publishedAt`
- Destination warehouse query history under the service principal identity
- Source warehouse query/export history for UNLOAD-capable sources
- Object-store access logs for the shared staging prefix, when enabled

The destination warehouse query history is the canonical record of final materialization SQL.

## See Also

- [`cross-warehouse-cookbook.md`](cross-warehouse-cookbook.md) - setup walkthrough
- [`cross-warehouse-limitations.md`](cross-warehouse-limitations.md) - current boundaries
- [`packages/model-spec/README.md`](../../../packages/model-spec/README.md) - model spec reference
