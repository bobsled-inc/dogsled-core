# Cross-Warehouse Model Publishing Cookbook

This guide walks through publishing a Model Spec model that reads from multiple source warehouses and writes the result to a single destination. The canonical production shape is Postgres plus Snowflake into Databricks, but the same contract works across Snowflake, BigQuery, Databricks, DuckDB, and Postgres destinations.

For the conceptual overview, see [`packages/model-spec/README.md`](../../../packages/model-spec/README.md#cross-warehouse-publish). For an executable example, see [`examples/cross-warehouse/`](../../../examples/cross-warehouse/). For current boundaries, see [`cross-warehouse-limitations.md`](cross-warehouse-limitations.md). For security and data residency, see [`cross-warehouse-data-flow.md`](cross-warehouse-data-flow.md).

## What `publish:` gives you

One YAML model file. Two or more source warehouses. One destination. One command (`dogsled model run`). Dogsled stages each source into destination-side temporary tables, evaluates the model SELECT in the destination warehouse, then applies the model materialization there.

```yaml
# models/customer_event_revenue.yml
spec_version: '0.2'
name: customer_event_revenue
type: model
publish:
  target: databricks
  target_schema: analytics
source:
  ref: postgres.events
joins:
  - ref: snowflake.accounts
    type: left
    on: postgres.events.account_id = snowflake.accounts.account_id
columns:
  - { name: event_id, expr: postgres.events.event_id, type: integer, primary_key: true }
  - { name: account_id, expr: postgres.events.account_id, type: integer }
  - { name: account_name, expr: snowflake.accounts.account_name, type: string }
  - { name: event_ts, expr: postgres.events.event_ts, type: timestamp }
  - { name: event_value, expr: postgres.events.event_value, type: number }
materialization:
  type: table
```

Run:

```bash
dogsled model run customer_event_revenue --secrets secrets.yml
```

`publish:` supports `materialization.type: table`, `incremental`, and `snapshot`. It rejects `view`, `materialized_view`, `dynamic_table`, and `ephemeral` because those imply zero data movement and cannot represent a cross-warehouse publish.

## Pre-Requisites

Set up grants in this order. The destination needs create/modify grants for the final model table and the transient `_xwh_*` staging/result tables. Each source needs read grants on referenced tables.

### Destination Warehouse

For Databricks, a service principal needs:

| Object                                | Grant                                  | Why                                                     |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Catalog `<catalog>`                   | `USE CATALOG`                          | Resolve schemas and tables                              |
| Schema `<catalog>.<target_schema>`    | `USE SCHEMA`, `CREATE TABLE`, `MODIFY` | Create staging tables and materialized output           |
| Shared staging URI, when using UNLOAD | Read access                            | Load Parquet files into destination-side staging tables |

For Snowflake, BigQuery, DuckDB, and Postgres destinations, grant the equivalent create-table, truncate/delete, insert, merge, and select privileges on the target schema. Postgres destinations always use streaming staging because Postgres has no native cloud UNLOAD primitive.

### Source Warehouses

Each source needs read-only access to referenced tables. Snowflake and Databricks sources for published models must use long-lived credentials (`rsa_key` or `pat` for Snowflake, `pat` for Databricks). OAuth source credentials are rejected for published models because token TTLs can expire during long runs.

### Dogsled Host

The host running `dogsled model run` needs:

- Outbound network access to every source and the destination
- Access to the shared staging URI when a source uses the streaming fallback
- Ephemeral disk for streaming fallback chunks
- Enough memory for bounded row buffers; the model SELECT runs in the destination warehouse

## Configuring The UNLOAD Substrate

UNLOAD is optional. If the destination integration has `cross_warehouse_staging.uri` and a source runner supports `unload()`, Dogsled asks the source warehouse to write Parquet directly to that URI, then asks the destination to load those files. If UNLOAD is unavailable or fails, Dogsled logs a redacted warning and streams that source through the existing JSONL/Parquet fallback.

The URI must be reachable by both the source warehouse writing files and the destination warehouse loading files. In cross-cloud scenarios this is usually a shared object-store prefix such as `s3://...` or `gs://...`, with the necessary warehouse-side storage integration or IAM grants.

```yaml
# integrations/databricks.yml
spec_version: '1'
auth_env_vars:
  [DATABRICKS_HTTP_PATH, DATABRICKS_TOKEN, DATABRICKS_WORKSPACE_URL, XWH_SHARED_STAGING_URI]
type: integration
name: databricks
source_type: databricks
connection:
  workspace_url: ${{ env.DATABRICKS_WORKSPACE_URL }}
  http_path: ${{ env.DATABRICKS_HTTP_PATH }}
  catalog: main
  schema: raw
auth:
  type: pat
  token: ${{ env.DATABRICKS_TOKEN }}
cross_warehouse_staging:
  uri: ${{ env.XWH_SHARED_STAGING_URI }} # e.g. s3://company-xwh-stage/publish/
```

Supported source UNLOAD implementations:

| Source     | UNLOAD behavior                                                  |
| ---------- | ---------------------------------------------------------------- |
| Snowflake  | `COPY INTO '<uri>' FROM (<select>) FILE_FORMAT=(TYPE=PARQUET)`   |
| BigQuery   | `EXPORT DATA` to `gs://.../*.parquet`                            |
| Databricks | `INSERT OVERWRITE DIRECTORY '<uri>' USING PARQUET <select>`      |
| DuckDB     | `COPY (<select>) TO '<uri>/part-00000.parquet' (FORMAT PARQUET)` |
| Postgres   | No native UNLOAD; streaming fallback                             |

## Materialization Examples

Incremental publish uses the normal Model Spec incremental DDL in the destination warehouse. Add `cursor_field` when the driving source can be pruned by the destination watermark.

```yaml
materialization:
  type: incremental
  strategy: merge
  unique_key: event_id
  cursor_field: event_ts
  incremental_filter: "event_ts > (SELECT COALESCE(MAX(event_ts), TIMESTAMP '1970-01-01') FROM self)"
  on_schema_change: full_refresh
```

Snapshots use the normal SCD-2 materialization and preserve history in the destination table.

```yaml
materialization:
  type: snapshot
  unique_key: account_id
  tracked_columns: [account_name, segment]
```

## Schema Drift

For published `incremental` and `snapshot` models, Dogsled describes the destination table before writing. If declared model columns drift from the destination schema:

- `on_schema_change: fail` raises `CommandError(3)` and leaves state unchanged.
- `on_schema_change: full_refresh` on incremental drops the target and rebuilds it as a first run.
- Snapshot materializations require `fail` because rebuilding would discard history.

Table materializations still replace the target table each run.

## Source Pruning

For incremental published models, `cursor_field` lets dogsled query the destination target for `MAX(cursor_field)` and push a `WHERE <cursor_field> > <watermark>` predicate into the driving source extraction. First runs, snapshots, table materializations, joined sources, and sources missing the cursor column extract fully.

Use a monotonic cursor such as `updated_at`, `event_ts`, or a strictly increasing ID. Keep `incremental_filter` for the destination-side MERGE/APPEND semantics; `cursor_field` is only the source extraction pruning hint.

## Dry Run

Run `--dry-run` first when authoring a new model:

```bash
dogsled model run customer_event_revenue --dry-run --secrets secrets.yml
```

The dry run loads the project and resolves the publish plan. It does not open source connections, unload rows, count source rows, or estimate warehouse cost.

## Production Run

```bash
$ dogsled model run customer_event_revenue --secrets secrets.yml
ℹ [databricks] customer_event_revenue: staging postgres.events
ℹ [databricks] customer_event_revenue: staging snowflake.accounts
✓ [databricks] Published customer_event_revenue (12,345,678 row(s)) in 14m32s; stage=8m12s publish=6m20s format=jsonl substrate=unload-or-stream
```

Run state is persisted to `.dogsled/model-spec/run-state.json` under `<publish_handle>.<model_name>` with `lastRunAt`, `publishedSnapshotId`, and `publishedAt`.

## Runtime Controls

```bash
dogsled model run <name> --dry-run        # show plan; do not open source connections
dogsled model run <name> --full-refresh   # clear run state for this run
```

```bash
DOGSLED_XWH_STAGING_FORMAT=parquet      # streaming fallback writes Parquet chunks instead of JSONL
DOGSLED_XWH_SOURCE_TIMEOUT_S=14400      # abort source streaming after N seconds
DOGSLED_ALLOW_PRIVATE_OAUTH_HOSTS=1     # allow OAuth token endpoint on private hosts
```

`DOGSLED_XWH_STAGING_FORMAT` affects only the streaming fallback. Native UNLOAD always writes Parquet.

## Troubleshooting

| Symptom                                                          | Diagnosis                                                       | Fix                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `UNLOAD failed ... falling back to JSONL streaming`              | Source could not write to `cross_warehouse_staging.uri`         | Check storage integration/IAM grants, URI scheme, network policy, and bucket/volume region |
| Snowflake `COPY INTO` external URI error                         | Snowflake lacks storage integration or external-location access | Grant a Snowflake storage integration or use a reachable stage/prefix                      |
| BigQuery unload rejects the staging URI                          | BigQuery UNLOAD supports `gs://` only                           | Use a GCS staging prefix for BigQuery sources                                              |
| Databricks `PERMISSION_DENIED` on `COPY INTO`                    | Destination cannot read the staged Parquet files                | Grant the service principal read access to the object-store prefix or Volume               |
| `Model "..." sets publish: ... with materialization "view"`      | Zero-data-movement materialization selected                     | Use `table`, `incremental`, or `snapshot`                                                  |
| `Model "..." sets publish: ... but source "..." uses oauth auth` | Published source uses short-lived OAuth credentials             | Switch to long-lived credentials such as Snowflake `rsa_key` or Databricks `pat`           |
| `Model "..." can publish only warehouse_table sources`           | A source is an API extractor instead of a warehouse table       | Extract the API into a warehouse first, then reference the warehouse table                 |
| `cross-warehouse target ... schema drifted`                      | Destination table no longer matches the model columns           | Update the model or set incremental `on_schema_change: full_refresh`                       |
| `cross-warehouse models require a publisher`                     | Programmatic `runProject` call did not inject the publisher     | Use the Dogsled CLI or inject `publishCrossWarehouse` from `@bobsled-inc/dogsled`          |

## Operational Notes

- **Concurrency**: do not run two publishes for the same model concurrently. There is no destination lock yet.
- **Cleanup**: Dogsled drops destination-side `_xwh_stage_*` and `_xwh_result_*` tables in `finally` and removes local streaming temp files on success, failure, SIGINT, and SIGTERM.
- **Secrets in errors**: resolved secret values with length at least 8 are scrubbed from `onWarn` and `onError` output.
- **State location**: `.dogsled/model-spec/run-state.json` is per-project state. Commit it only when your deployment workflow intentionally tracks run metadata in Git.

## See Also

- [`cross-warehouse-limitations.md`](cross-warehouse-limitations.md) - current boundaries
- [`cross-warehouse-data-flow.md`](cross-warehouse-data-flow.md) - security and residency
- [`examples/cross-warehouse/`](../../../examples/cross-warehouse/) - runnable fixture
- [`packages/model-spec/README.md`](../../../packages/model-spec/README.md) - model spec reference
