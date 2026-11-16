# Snowflake Materializations

This tutorial builds a small Snowflake project with the materialization path most teams use first:

1. a staging `view`
2. a curated `table`
3. an `incremental` fact table using `merge`
4. a Snowflake Dynamic Table for a hot downstream consumer

The copy-pasteable project lives at `examples/snowflake-materializations/`. It can compile locally against DuckDB without warehouse credentials, then run against Snowflake after you point the Snowflake integration at a real account.

## Project Layout

```text
examples/snowflake-materializations/
├── model-spec.yml
├── integrations/
│   ├── duckdb.yml
│   └── snowflake.yml
├── sources/
│   └── snowflake/
│       └── orders.yml
└── models/
    ├── stg_orders.yml
    ├── dim_customers_from_orders.yml
    ├── fct_orders_incremental.yml
    └── hot_customer_revenue.yml
```

## Install

From the repo root:

```bash
pnpm install
pnpm --filter @bobsled-inc/model-spec build
```

## Compile Locally With DuckDB

DuckDB compile mode is useful for checking the portable part of the graph without opening a Snowflake connection:

```bash
cd examples/snowflake-materializations
pnpm exec bobsled model compile \
  stg_orders dim_customers_from_orders fct_orders_incremental \
  --integration duckdb
```

The source file still models a Snowflake table (`RAW.ORDERS`). Passing `--integration duckdb` compiles the portable `view`, `table`, and `incremental` models using DuckDB SQL so you can validate the project locally. `hot_customer_revenue` is Snowflake-only because it uses `materialization.type: dynamic_table`.

## Configure Snowflake

Create a raw table with the columns declared in `sources/snowflake/orders.yml`, then export credentials for the example integration:

```bash
export SNOWFLAKE_ACCOUNT='xy12345.us-east-1'
export SNOWFLAKE_WAREHOUSE='TRANSFORM_WH'
export SNOWFLAKE_DATABASE='DEMO'
export SNOWFLAKE_ROLE='TRANSFORM_ROLE'
export SNOWFLAKE_USER='MODEL_SPEC_DEMO_USER'
export SNOWFLAKE_PAT='...'
```

The tutorial assumes the integration's target schema is `ANALYTICS` and the source table is `RAW.ORDERS`.

## Compile And Run Snowflake

```bash
cd examples/snowflake-materializations
pnpm exec bobsled model compile --integration snowflake
pnpm exec bobsled model run --integration snowflake
```

To force a full rebuild of the incremental table:

```bash
pnpm exec bobsled model run --integration snowflake --full-refresh
```

## What Each Model Does

`stg_orders.yml` creates a view over `snowflake.orders`. Keep staging views thin: rename, cast, and normalize source fields, but avoid heavyweight business logic.

`dim_customers_from_orders.yml` creates a physical table. Use tables for curated objects that many downstream consumers read repeatedly.

`fct_orders_incremental.yml` creates an incremental merge table keyed by `ORDER_ID`. On the first run, Bobsled Core creates the table. On later runs, it emits a warehouse-native `MERGE` using `unique_key: ORDER_ID` and the `incremental_filter`.

`hot_customer_revenue.yml` creates a Snowflake Dynamic Table. Dynamic Tables are best for hot downstream consumers where Snowflake should manage refreshes after Bobsled Core creates the object.

## Operational Notes

Dynamic Tables and BigQuery materialized views consume warehouse credits or query processing per refresh. Use a target lag of `1 hour` or longer unless you have a tight freshness SLA.

Snowflake `view` to `table` transitions preserve grants with `COPY GRANTS` when Bobsled Core recreates the object. `COPY GRANTS` copies privileges only; it does not copy future grants, masking policies, row access policies, or ownership. On BigQuery, dataset-level IAM is unaffected by table recreation, but row-level policies and column policy tags may need recreation.

Snowflake DDL auto-commits. If a `DROP` succeeds and the following `CREATE OR REPLACE` fails, the object is gone; fix the error and re-run `bobsled model run`.

BigQuery materialized view `max_staleness` must stay within the materialized-view range of 30 minutes to 3 days. A view that has not refreshed within the allowed staleness window can fail at query time while streaming-buffer data is still unavailable.

BigQuery materialized views and Snowflake materialized views do not support Time Travel. If you need point-in-time restoration, use a plain `table` or a Snowflake Dynamic Table.

## Schema-change safety

Suppose your `fct_orders_incremental.yml` model started as:

```yaml
materialization:
  type: incremental
  strategy: merge
  unique_key: ORDER_ID
  incremental_filter: 'ORDERED_AT > DATEADD(hour, -2, self)'
  on_schema_change: fail # default
```

If a downstream change drops a column from `columns:`, the next `bobsled model run` aborts with `CommandError(3)` and a remediation message:

```text
Schema drift detected for model `fct_orders_incremental`.
...
To proceed, either:
  - rebuild the table: bobsled model run fct_orders_incremental --full-refresh
  - opt into auto-rebuild: set `on_schema_change: full_refresh` in fct_orders_incremental.yml
```

Switching to `on_schema_change: full_refresh` makes drift trigger an automatic rebuild on the next run. Prior data is discarded; the integration log surfaces a warning so the rebuild is visible in CI.

Snapshots only allow `fail` — rebuilding a snapshot loses history.

## Switching `view` ↔ `table`

`stg_orders.yml` is a `view` in this tutorial. If a downstream consumer needs a physical table, change it to:

```yaml
materialization:
  type: table
```

On the next `bobsled model run`, Model Spec emits `DROP VIEW IF EXISTS "ANALYTICS"."STG_ORDERS"` followed by `CREATE OR REPLACE TABLE ... COPY GRANTS`, preserving privileges on Snowflake. You can switch back to `view` the same way — `view` ↔ `table` is the only auto-recreate transition. Other transitions (e.g. `incremental` → `table`) abort with `CommandError(3)` and require manual `DROP` to confirm intent.

See `docs/materializations-reference.md` for the full transition matrix and `COPY GRANTS` caveats.
