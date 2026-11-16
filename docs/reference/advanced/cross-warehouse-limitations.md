# Cross-Warehouse Publishing Limitations

This doc lists what `publish:` supports now and the boundaries that still matter for operators.

For setup, see [`cross-warehouse-cookbook.md`](cross-warehouse-cookbook.md). For data flow and security, see [`cross-warehouse-data-flow.md`](cross-warehouse-data-flow.md).

## What Is Supported

- Sources from any combination of Postgres, Snowflake, BigQuery, Databricks, and DuckDB
- Live/lazy **API sources** (`api_resource` with `mode: live` / `lazy`) as mixed-model leaves, joined with warehouse tables via `execution.engine` (or its `publish:` alias)
- A **DuckDB-engine `view`** variant: live/lazy API leaves hydrate into the DuckDB and foreign warehouse leaves stage into it, recomputed on every run (no warehouse publish)
- Destinations backed by the existing loader database destinations: Postgres, Snowflake, BigQuery, Databricks, and DuckDB
- `materialization.type: table`, `incremental`, and `snapshot`
- Destination-side model SELECT evaluation against transient `_xwh_stage_*` tables
- Per-source substrate selection:
  - Native UNLOAD to Parquet when `cross_warehouse_staging.uri` is configured and the source supports `unload()`
  - Streaming fallback when UNLOAD is unavailable or fails
- Destination schema drift handling for incremental and snapshot materializations
- Incremental source pruning with `materialization.cursor_field`
- SIGINT/SIGTERM cleanup of local streaming temp files
- Best-effort cleanup of destination-side staging/result tables
- Secret scrubbing on operator-visible callbacks (`onError`, `onWarn`)
- Driver-level type fidelity for Decimal/Timestamp/Binary where supported by the source runner

## Hard Limits

### Zero-Data-Movement Materializations

Published models reject these materializations:

- `view`
- `materialized_view`
- `dynamic_table`
- `ephemeral`

Those objects live inside one warehouse and do not move data. Cross-warehouse publish materializes data into a destination warehouse, so use `table`, `incremental`, or `snapshot`.

### Live / Lazy API Source Leaves (Mixed Models)

A mixed model can join a live/lazy `api_resource` source with warehouse tables. Three rules keep "source freshness" (`mode`) and "where the model runs / is it persisted" (`execution.engine` + materialization) from colliding:

- **API leaves always stream.** There is no source warehouse to `UNLOAD` from, so the `cross_warehouse_staging.uri` Parquet substrate applies only to warehouse leaves; the API rows are fetched and streamed into the engine.
- **A persisted model cannot root on a `live` source** — it must be a `view`. A live source has no persistent home, so freezing it into a `table`/`incremental`/`snapshot` contradicts "live". Use a `lazy` source to materialize a snapshot.
- **A published model's `execution.engine` must not be the live source cache's own DuckDB file.** The live orchestrator hydrates the cache file while the publisher opens it as a separate handle; two uncoordinated read-write handles corrupt it. Point persisted mixed models at a distinct warehouse / DuckDB file. (OAuth note below still applies, but API-resource leaves themselves are exempt from the OAuth-source rejection.)

### Source Authentication

OAuth and OAuth M2M auth on sources is rejected at validation time when the model has `publish:` set. Snowflake sources should use `rsa_key` or `pat`; Databricks sources should use `pat`. (Live/lazy `api_resource` leaves are exempt — their own auth is handled by the extractor.)

Why: OAuth tokens can expire during multi-hour publishes, and source runners do not refresh tokens mid-stream or mid-UNLOAD yet.

### UNLOAD Requires Shared Storage

The configured `cross_warehouse_staging.uri` must be writable by the source warehouse and readable by the destination warehouse. Dogsled does not abstract cloud IAM, storage integrations, external locations, or cross-cloud network policy.

If UNLOAD fails at runtime, Dogsled warns and falls back to streaming for that source. The publish can still complete, but slower and with the Dogsled host in the row-data path for that source.

### Postgres Sources

Postgres has no native cloud UNLOAD primitive in this implementation. Postgres sources always use the streaming fallback. Mixed-source publishes still work: for example, Postgres streams while Snowflake UNLOADs, then the destination joins both staging tables.

### Postgres Destinations

Postgres destinations do not support `loadFromUri()`. Published models targeting Postgres still work through streaming staging and destination-side SQL, but they do not use the UNLOAD substrate.

### Concurrency

There is no file lock or destination-side claim. Two concurrent `dogsled model run` invocations against the same published model can race on the same destination target.

Operator guidance: serialize publish runs per model in CI, CRON, and workflow schedulers.

Roadmap: a destination-side `_bobsled_xwh_locks` table plus stale-lock recovery command.

### Single Destination Per Model

`publish:` accepts one integration handle. A model cannot publish to multiple destinations in a single run.

If you need the same model in three warehouses, declare three models with different `publish:` targets or use an external orchestrator.

### Per-Environment Publish Targets

`publish:` does not support `${{ env.X }}` interpolation. A model that publishes to dev versus prod needs separate model files or a templating wrapper.

### Custom Warehouse Runners

The publish target type is restricted to bundled warehouse integrations. Custom runners registered through `@bobsled-inc/connections` can participate as sources only if they expose the required query/stream capabilities, but custom publish targets are not wired through the default destination factory.

### MySQL Destination

MySQL is not supported as a publish target because there is no `MySQLDestination` in `@bobsled-inc/loader`.

### Cost Controls

`--dry-run` shows the publish plan only. It does not count source rows, estimate egress, estimate destination compute, or enforce a publish-specific row cap.

Operator guidance: use warehouse-native cost controls such as Databricks SQL warehouse auto-stop, Snowflake warehouse limits, BigQuery reservations/quotas, and object-store lifecycle policy for staging prefixes.

### Observability

The CLI prints a phase summary at completion (`stage`, `publish`, `format`, `substrate`, row count). It does not emit protocol `METRIC` messages for cross-warehouse publish yet.

### Restartability

If a publish fails late, the next invocation restarts from the beginning. There is no checkpoint/resume protocol.

Roadmap: per-phase checkpoints plus `dogsled model run --resume-run <run_id>`.

## Scale Guidance

Native UNLOAD plus destination-side SELECT is the preferred path for large warehouse-to-warehouse publishes. Streaming fallback is functional and preserves v1 behavior, but the Dogsled host carries the row data for streamed sources. For very large Postgres sources, consider a normal extract/load pipeline into the destination first, then a single-warehouse Model Spec model.

## See Also

- [`cross-warehouse-cookbook.md`](cross-warehouse-cookbook.md) - setup walkthrough
- [`cross-warehouse-data-flow.md`](cross-warehouse-data-flow.md) - security and residency
- [`packages/model-spec/README.md`](../../../packages/model-spec/README.md) - model spec reference
- [`examples/cross-warehouse/`](../../../examples/cross-warehouse/) - runnable fixture
