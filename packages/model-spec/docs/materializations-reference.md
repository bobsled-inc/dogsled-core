# Materializations reference

## Introduction

Model Spec supports seven materialization types — `view`, `table`, `incremental`, `ephemeral`, `snapshot`, `dynamic_table`, and `materialized_view` — mapped to per-dialect DDL by the compiler in `src/compiler/materializer.ts`. The compiler is multi-dialect by design: when a materialization is unsupported on the target dialect, Model Spec fails loud at compile time with a `CommandError(2)` rather than silently falling back. This document is sourced from production code; see citations to file paths and line ranges throughout.

## Type catalog

- `view` — `CREATE OR REPLACE VIEW`. Lightweight, always fresh, no storage. Default if not specified.
- `table` — `CREATE OR REPLACE TABLE` (Snowflake / BigQuery / Databricks / DuckDB), a swap-rename pattern that builds `<name>__dogsled_new`, renames the live table aside as `<name>__dogsled_old`, then drops the old table with `CASCADE` (Postgres / pgvector / Redshift), or `DROP TABLE IF EXISTS` + `CREATE TABLE` (MySQL). Full refresh on every run. The Postgres swap-rename keeps the live table available while the new copy is being built and avoids `cannot drop table because other objects depend on it` errors when a downstream `materialized_view` references this table; `CASCADE` on the renamed-aside copy intentionally drops the dependent MV so Model Spec can re-create it from the model that owns it later in the same DAG run.
- `incremental` — `MERGE`, `DELETE+INSERT`, or `APPEND` strategy. Requires `strategy` + (typically) `unique_key` + `incremental_filter`. First run creates the table; subsequent runs apply the strategy.
- `ephemeral` — Inlined as a CTE in downstream models. No DDL emitted; not a database object.
- `snapshot` — Slowly-Changing Dimension Type 2 (SCD-2). Tracks changes to `tracked_columns` for each `unique_key` over time via `valid_from` / `valid_to` / `is_current` columns.
- `dynamic_table` — Snowflake-managed dynamic table with `target_lag` and `warehouse`. Snowflake-only.
- `materialized_view` — Warehouse-managed materialized view. Snowflake / BigQuery / Postgres / Databricks / Redshift; not MySQL / DuckDB.

## Dialect capability matrix

| Materialization                                | Snowflake | BigQuery | Postgres | Databricks | MySQL | DuckDB | Redshift |
| ---------------------------------------------- | :-------: | :------: | :------: | :--------: | :---: | :----: | :------: |
| `view`                                         |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `table`                                        |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `incremental` (merge / delete_insert / append) |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `ephemeral`                                    |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `snapshot`                                     |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `dynamic_table`                                |    Yes    |    No    |    No    |     No     |  No   |   No   |    No    |
| `materialized_view`                            |    Yes    |   Yes    |   Yes    |    Yes     |  No   |   No   |   Yes    |

Capability flags live on `DialectProfile.capabilities` in `src/compiler/dialect.ts:99-208` (`materializedView`, `dynamicTable`).

Choosing a materialization unsupported on the target dialect throws `CommandError(2)` at compile time (`src/compiler/materializer.ts:307-393`). The error message includes a `bestMaterializationAlternative` suggestion: `materialized_view` is suggested as the fallback when `dynamic_table` is requested on a non-Snowflake dialect, and `table` is suggested when `materialized_view` is requested on MySQL or DuckDB.

## Choosing a type

| Need                                                                          | Type                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| Always-fresh exploratory queries                                              | `view`                                               |
| Curated outputs read by many consumers                                        | `table`                                              |
| Source data appends fast, you want incremental refresh                        | `incremental` (`merge` / `append` / `delete_insert`) |
| Internal staging logic that doesn't need persistence                          | `ephemeral`                                          |
| Slowly-changing dimensions where you need history                             | `snapshot`                                           |
| Snowflake-managed always-fresh outputs                                        | `dynamic_table`                                      |
| Warehouse-managed cached query (BigQuery / Postgres / Snowflake / Databricks) | `materialized_view`                                  |

For `incremental`, pick the strategy: `merge` for upserts, `append` for pure-insert sources, `delete_insert` for batched updates that should fully replace a slice of the target.

## on_schema_change

Validated on `incremental` and `snapshot` materializations.

- **Default**: `fail` — schema drift between runs raises `CommandError(3)` and aborts. State is preserved (no advance); the user can rebuild with `--full-refresh` or update the spec.
- **`full_refresh`** — drift triggers an automatic table rebuild. Prior data is discarded. The integration log surfaces a warning so the rebuild is visible in CI / logs (`src/api/run-project.ts:411-428`).
- **Snapshot constraint**: `on_schema_change` must be `fail` for snapshots. The schema parser rejects `full_refresh` because rebuilding a snapshot loses history. Snapshots use `z.literal('fail').default('fail')` (`src/compiler/schemas.ts:816`); incremental uses `OnSchemaChangeSchema.default('fail')` over the union `z.enum(['fail', 'full_refresh'])` (`src/compiler/schemas.ts:239,802`).

```yaml
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  incremental_filter: 'updated_at > DATEADD(hour, -2, self)'
  on_schema_change: full_refresh
```

## Transitions between materialization types

Source: `materializer.ts:planTransition` (L100-130).

- **Same → same**: no-op.
- **`view` ↔ `table`**: Model Spec auto-recreates by emitting `DROP VIEW IF EXISTS` (or `DROP TABLE IF EXISTS`) followed by the new `CREATE`. On Snowflake, `CREATE OR REPLACE` includes `COPY GRANTS` to preserve privileges. Caveat: `COPY GRANTS` preserves only privileges, not future grants, masking policies, row-access policies, or ownership.
- **All other transitions** (e.g. `incremental → table`, `snapshot → table`): hard fail with `CommandError(3)` and a remediation message containing the exact `DROP` statement to run before re-running. This guards against accidental data / history loss.

Failure-message structure:

```text
Materialization type for model `fct_orders` changed from `incremental` to `table`.
This transition could lose data or history and must be performed explicitly.

To migrate:
  DROP TABLE IF EXISTS "ANALYTICS"."FCT_ORDERS";
  -- then re-run: dogsled model run fct_orders

Dialect: snowflake
```

## Hooks

- `pre_hook` and `post_hook` are arrays of SQL strings on the materialization spec.
- Template substitution: `{schema}` resolves to the effective target schema; `{name}` resolves to the model name (`materializer.ts:540-542`, `expandHookTemplate`).
- Pre-hooks execute before the materialization DDL; post-hooks execute after. Both are part of the same execution batch.
- Validation: a `dangerousHookRegex` rejects semicolons and any hook whose first non-whitespace token is `DROP` / `ALTER` / `TRUNCATE` / `DELETE` / `GRANT` / `REVOKE` (`schemas.ts:43`). Use stored procedures (`CALL`) or admin tooling outside hooks for those operations.

```yaml
materialization:
  type: table
  pre_hook:
    - "CALL ops.set_session_tag('build:{name}')"
  post_hook:
    - 'ANALYZE {schema}.{name}'
```

## Snapshot SCD-2

- Required: `unique_key` (string or array). Optional: `tracked_columns` (defaults to all non-key columns), `valid_from_column` (default `valid_from`), `valid_to_column` (default `valid_to`).
- Model Spec emits an additional `is_current` column automatically (boolean).
- First run: creates the table with all source rows as `is_current = TRUE`, `valid_from = CURRENT_TIMESTAMP`, `valid_to = NULL` (`materializer.ts:576-609`, `generateSnapshotFirstRunDdl`).
- Subsequent runs (`generateSnapshotMergeDdl` for non-MySQL, `generateSnapshotMysqlDdl` for MySQL):
  1. **Close changed rows** — `MERGE` / `UPDATE` sets `valid_to = CURRENT_TIMESTAMP, is_current = FALSE` for keys whose `tracked_columns` changed. Change detection uses `IS DISTINCT FROM`; MySQL uses `<=>` (`buildChangeDetectionClause`, L628-637).
  2. **Insert new versions** — single `INSERT` using `NOT EXISTS` to find source rows that no longer have an `is_current = TRUE` row in the target. Covers both new keys (never seen before) and changed keys (just closed). Timestamp-independent; safe across dialects with non-deterministic `CURRENT_TIMESTAMP` across statements.
- `on_schema_change` must be `fail` for snapshots (schema changes lose history).

```yaml
spec_version: '0.2'
name: customer_history
type: model
description: SCD-2 of customer attributes
grain: customer_id
source:
  ref: ecom.raw_customers
columns:
  - name: customer_id
    expr: ID
    primary_key: true
  - name: name
    expr: NAME
  - name: email
    expr: EMAIL
  - name: tier
    expr: TIER
materialization:
  type: snapshot
  unique_key: customer_id
  tracked_columns: [name, email, tier]
```

## dynamic_table options (Snowflake-only)

Source: `materializer.ts:209-244`, schema validation at `schemas.ts:271-294`.

- `target_lag`: required (or default `'DOWNSTREAM'`). Either the bare keyword `DOWNSTREAM` or a duration string like `'1 hour'`. Numeric durations must be at least 60 seconds. Validated by `snowflakeTargetLagRegex` (`schemas.ts:242`) plus `superRefine` at `schemas.ts:284-294`.
- `warehouse`: required if not set on the integration. Must be a valid Snowflake identifier (`snowflakeWarehouseRegex`, `schemas.ts:243`). Inherited from `connection.warehouse` if set on the integration.
- Throws `CommandError(2)` if `target_lag` or `warehouse` is set on a non-Snowflake model (`materializer.ts:329-355`).

```yaml
materialization:
  type: dynamic_table
  target_lag: '1 hour'
  warehouse: TRANSFORMING_WH
```

```yaml
materialization:
  type: dynamic_table
  target_lag: DOWNSTREAM # refresh whenever a downstream consumer needs fresh data
```

Generated DDL (Snowflake):

```sql
CREATE OR REPLACE DYNAMIC TABLE "ANALYTICS"."FCT_ORDERS"
  TARGET_LAG = '1 hour'
  WAREHOUSE = TRANSFORMING_WH COPY GRANTS
AS (
  ...
);
```

## materialized_view options

Supported on Snowflake / BigQuery / Postgres / Databricks / Redshift. Not supported on MySQL / DuckDB.

- BigQuery `max_staleness`: optional. Format: `"30 minute"`, `"1 hour"`, `"3 day"`, or BigQuery `INTERVAL "N" UNIT` form. Range: 30 minutes to 3 days inclusive (`bigQueryMaxStalenessRegex` + `superRefine` at `schemas.ts:296-318`).
- Throws `CommandError(2)` if `max_staleness` is set on a non-BigQuery dialect (`materializer.ts:357-369`).

```yaml
# BigQuery with max_staleness
materialization:
  type: materialized_view
  max_staleness: '1 hour'
```

```yaml
# Plain materialized view on Postgres
materialization:
  type: materialized_view
```

Generated DDL (Postgres):

```sql
DROP MATERIALIZED VIEW IF EXISTS "analytics"."fct_orders";
CREATE MATERIALIZED VIEW "analytics"."fct_orders" AS (
  ...
);
```

## Incremental strategies

Three strategies, dispatched in `materializer.ts:287-305`.

- `merge` (default) — emits `MERGE INTO` with `WHEN MATCHED THEN UPDATE` / `WHEN NOT MATCHED THEN INSERT`. Requires `unique_key`. On MySQL, Model Spec emits `INSERT ... ON DUPLICATE KEY UPDATE` instead since MySQL has no `MERGE` (`generateMergeDdl` L506-511).
- `delete_insert` — `DELETE FROM ... WHERE unique_key IN (...)` followed by `INSERT INTO`, wrapped in a `BEGIN` / `COMMIT` (`START TRANSACTION` / `COMMIT` on MySQL). Requires `unique_key`. Useful when the source emits "batches" you want to fully replace.
- `append` — `INSERT INTO` only. Requires `incremental_filter` (without it, every row duplicates each run). Use the `self` keyword in `incremental_filter` to reference the model's own table — it is substituted to the fully-qualified table name at run time.

```yaml
# merge — upsert on unique_key
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  incremental_filter: 'updated_at > DATEADD(hour, -2, self)'
```

```yaml
# delete_insert — replace a batched slice
materialization:
  type: incremental
  strategy: delete_insert
  unique_key: [batch_id, order_id]
  incremental_filter: 'batch_id IN (SELECT batch_id FROM staging.recent_batches)'
```

```yaml
# append — pure-insert source (e.g. event stream)
materialization:
  type: incremental
  strategy: append
  incremental_filter: "event_ts > (SELECT COALESCE(MAX(event_ts), TIMESTAMP '1970-01-01') FROM self)"
```

## State and run semantics

Model Spec persists per-model materialization metadata in `.dogsled-model-spec-state/state.json` (or `.dogsled/model-spec/run-state.json` for multi-integration projects, scoped under `<handle>.<model>` keys). State tracks `materialization`, `selectSignature`, `columns`, and `lastRunAt` (`src/compiler/state.ts:37-53`). The compiler uses prior state to detect transitions (`planTransition`) and schema changes (`planSchemaChange`).

On error, state does not advance — the user can fix and re-run safely. `--full-refresh` clears state for the run; on re-run, all models behave as first-run.

## Errors and exit codes

- `CommandError(2)` — validation: unsupported dialect / option combo, malformed config, missing required option (e.g. `unique_key` for `merge`).
- `CommandError(3)` — schema drift in `fail` mode, unsupported materialization transition, materialization-history violation. Means "user action required to proceed".
- `CommandError(1)` — runtime / connection error.

Aside: at the API layer (`runProject`), schema-drift `fail` and unsupported transitions currently throw `CommandError(3)` rather than returning `{ ok: false }` with a per-integration error. CLI exit codes match the thrown `CommandError` code. This is current behavior; future work may align the API and CLI behavior.

## Cross-references

- `AGENTS.md` and `README.md` cover the YAML schema overview.
- `docs/tutorials/snowflake-materializations.md` provides a multi-step tutorial.
- `.agents/skills/dogsled-model-spec/SKILL.md` contains the agent-facing skill.
