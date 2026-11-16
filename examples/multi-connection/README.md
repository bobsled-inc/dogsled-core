# multi-connection

End-to-end test project for `bobsled model` with two live warehouses (Snowflake + BigQuery) in one Model Spec project. Committed to the repo so we can contribute to it as new Model Spec features land.

## What it exercises

- Multi-integration compile/run fan-out (one `model-spec.yml`, two integrations).
- `--integration <handle>` filter to scope work to one warehouse.
- Per-model `target_schema` override (both warehouses).
- Per-model `target_database` override (Snowflake only — BigQuery cross-project is a larger topic we're deferring).
- RSA-key Snowflake auth via `integrations/snowflake.yml`.
- ADC BigQuery auth via `integrations/bigquery.yml`.
- Secrets overlay via `--secrets secrets.yml`.
- Metadata entities: 4 metrics, 4 relationships, 3 VQs spanning both warehouses, emitted as JSON under `--include-metadata`.

## Directory layout

```
├── model-spec.yml
├── secrets.example.yml        → copy to secrets.yml, fill in
├── integrations/
│   ├── snowflake.yml          rsa_key auth
│   └── bigquery.yml           adc auth
├── sources/
│   ├── snowflake/{customers,orders,lineitems}.yml
│   └── bigquery/{customers,orders,lineitems}.yml
├── models/
│   ├── sf_stg_customers.yml
│   ├── sf_stg_orders.yml
│   ├── sf_stg_lineitems.yml
│   ├── sf_fct_orders.yml               target_schema: ANALYTICS
│   ├── sf_mart_customer_revenue.yml    target_database + target_schema override
│   ├── bq_stg_customers.yml
│   ├── bq_stg_orders.yml
│   ├── bq_stg_lineitems.yml
│   ├── bq_fct_orders.yml               target_schema: multi_conn_analytics
│   └── bq_mart_customer_revenue.yml    target_schema: multi_conn_mart
├── metrics/                            # 4 metrics — sf + bq revenue, order count, AOV
├── relationships/                      # 4 relationships — fct↔customers, fct↔lineitems × 2
└── vqs/                                # 3 verified queries pinned via `connection: <handle>`
```

Models are prefixed `sf_` / `bq_` because Model Spec model refs are bare names — without the prefix `stg_customers` collides. Metrics, relationships, and VQs reference models by the same bare name.

## Warehouse setup

Already provisioned. Re-running the setup scripts is idempotent.

### Snowflake

Isolated resources in account `MYORG-MYACCOUNT`:

- Warehouse: `MULTI_CONN_WH` (x-small, auto-suspend 60s)
- Role: `MULTI_CONN_ROLE`
- Database: `MULTI_CONN_DB` — schemas `RAW`, `STAGING`, `ANALYTICS`
- Database: `MULTI_CONN_DB_OVERRIDE` — schema `MART`
- User: `"analytics@example.com"` (the `@` requires double-quoting in DDL)
- Auth: RSA key at `/Users/you/.ssh/snowflake/multi_conn.p8`

Seed tables live in `MULTI_CONN_DB.RAW.{CUSTOMERS, ORDERS, LINEITEMS}`.

### BigQuery

- Project: `my-gcp-project` (location `US`)
- Datasets: `multi_conn_raw`, `multi_conn_staging`, `multi_conn_analytics`, `multi_conn_mart`
- Auth: Application Default Credentials (`gcloud auth application-default login` + `gcloud auth application-default set-quota-project my-gcp-project`)

## Running it

```bash
# 1. Copy + fill in secrets.
cp secrets.example.yml secrets.yml
$EDITOR secrets.yml

# 2. Validate both integrations' specs (no warehouse hits).
bobsled model validate

# 3. Compile both dialects to local SQL.
bobsled model compile -o target/
# → target/snowflake/*.sql + target/bigquery/*.sql

# 3b. Also emit metrics/relationships/vqs JSON alongside the SQL tree.
bobsled model compile -o target/ --include-metadata
# → target/metrics.json + target/relationships.json + target/vqs.json

# 4. Dry-run the full plan against both warehouses.
bobsled model run --dry-run --secrets secrets.yml

# 5. Run against one warehouse at a time.
bobsled model run --integration snowflake --secrets secrets.yml
bobsled model run --integration bigquery  --secrets secrets.yml

# 6. Fan out over both warehouses in one shot.
bobsled model run --secrets secrets.yml

# 7. Full refresh — recreates every view from source (no-op for `type: view`
#    on Snowflake/BigQuery since views always `CREATE OR REPLACE`, but keeps
#    run-state fresh).
bobsled model run --full-refresh --secrets secrets.yml
```

All 10 models are `materialization: view`, so a run is idempotent — it always `CREATE OR REPLACE`s the view against the current source data. After a run the views land at:

| Warehouse | Model                      | Location                                                          |
| --------- | -------------------------- | ----------------------------------------------------------------- |
| Snowflake | `sf_stg_customers`         | `MULTI_CONN_DB.STAGING.SF_STG_CUSTOMERS`                  |
| Snowflake | `sf_stg_orders`            | `MULTI_CONN_DB.STAGING.SF_STG_ORDERS`                     |
| Snowflake | `sf_stg_lineitems`         | `MULTI_CONN_DB.STAGING.SF_STG_LINEITEMS`                  |
| Snowflake | `sf_fct_orders`            | `MULTI_CONN_DB.ANALYTICS.SF_FCT_ORDERS`                   |
| Snowflake | `sf_mart_customer_revenue` | `MULTI_CONN_DB_OVERRIDE.MART.SF_MART_CUSTOMER_REVENUE`    |
| BigQuery  | `bq_stg_*`                 | `my-gcp-project.multi_conn_staging.*`                     |
| BigQuery  | `bq_fct_orders`            | `my-gcp-project.multi_conn_analytics.bq_fct_orders`       |
| BigQuery  | `bq_mart_customer_revenue` | `my-gcp-project.multi_conn_mart.bq_mart_customer_revenue` |
