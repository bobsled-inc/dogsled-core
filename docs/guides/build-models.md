# Build models

A model is a YAML file that describes a table or view: where it reads from, its
columns as SQL expressions, and how to materialize it. Dogsled compiles models to
SQL for your warehouse, works out the order from the references between them, and
runs them. This guide continues the `shop` project from
[Get started](../getting-started.md), which already has an `orders` source and a
`customer_revenue` model.

## Connect to the warehouse

Models run through an integration whose `source_type` is the warehouse. In the
`shop` project, `integrations/warehouse.yml` points at the DuckDB file:

```yaml
spec_version: '1'
type: integration
name: warehouse
source_type: duckdb
connection:
  schema: analytics
auth:
  type: file
  path: .dogsled/dogsled.duckdb
```

`connection.schema` is where models are created. Models can run on DuckDB,
PostgreSQL, Snowflake, BigQuery, Databricks and ClickHouse. Other warehouses use
the same file with their own connection fields, for example PostgreSQL:

```yaml
spec_version: '1'
auth_env_vars: [PG_PASSWORD]
type: integration
name: pg_warehouse
source_type: postgres
connection:
  host: db.example.com
  port: 5432
  database: analytics
  schema: marts
auth:
  type: password
  user: modeler
  password: ${{ env.PG_PASSWORD }}
```

Database sources for `extract run` use `password_env` instead; see
[Extract from databases](extract-from-databases.md).

When a project has more than one model integration, pass `--integration <name>` to
every `dogsled model` command.

## Sources and models

A source declares a table that already exists, and a model reads from a source or
from another model with `source.ref`:

- `<integration>.<source>` refers to a source, for example `warehouse.orders`.
- `<model>` refers to another model, for example `customer_revenue`.

Add a view that keeps the customers who spent more than 100.

Create `models/top_customers.yml`:

```yaml
spec_version: '0.2'
type: model
name: top_customers
description: Customers whose orders total more than 100.
grain: [customer]
source:
  ref: customer_revenue
columns:
  - name: customer
    expr: customer
  - name: total_amount
    expr: total_amount
where: total_amount > 100
materialization:
  type: view
```

Every model needs a `description` and a `grain` (the columns that identify a row).
`dogsled model validate` names any field that is missing or wrong:

```bash
dogsled model validate --integration warehouse
dogsled model run --integration warehouse
```

```text
✓ customer_revenue (3 columns)
✓ top_customers (2 columns)
Validated 2 model(s): 2 passed
...
✓ customer_revenue: executed.
✓ top_customers: executed.
✓ Executed 2 model operation(s).
```

`top_customers` depends on `customer_revenue`, so Dogsled builds that first. Run
one model with `dogsled model run top_customers`, and see the plan without running
it with `--dry-run`.

## Materializations

| `materialization.type`               | Result                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `view`                               | A view.                                                                                                                                                                        |
| `table`                              | A table, rebuilt on every run.                                                                                                                                                 |
| `incremental`                        | A table that is updated, not rebuilt. `strategy` is `merge` (default, needs `unique_key`), `delete_insert` or `append`. `incremental_filter` limits the rows read on each run. |
| `ephemeral`                          | Not created. Models that use it inline it as a common table expression.                                                                                                        |
| `snapshot`                           | A slowly changing dimension (type 2): keeps history for `unique_key`, with validity columns.                                                                                   |
| `dynamic_table`, `materialized_view` | Snowflake dynamic tables and materialized views.                                                                                                                               |

An incremental model updates each day's revenue in place instead of rebuilding the
table.

Create `models/daily_revenue.yml`:

```yaml
spec_version: '0.2'
type: model
name: daily_revenue
description: Revenue per order day.
grain: [order_day]
source:
  ref: warehouse.orders
columns:
  - name: order_day
    expr: CAST(ordered_at AS DATE)
  - name: revenue
    expr: SUM(amount)
group_by: [order_day]
materialization:
  type: incremental
  strategy: merge
  unique_key: order_day
```

```bash
dogsled model run daily_revenue --integration warehouse
dogsled query "SELECT * FROM analytics.daily_revenue ORDER BY order_day" --db-path .dogsled/dogsled.duckdb
```

```text
order_day	revenue
2026-01-03T00:00:00.000Z	120.5
2026-01-04T00:00:00.000Z	80
2026-01-09T00:00:00.000Z	42.25
2026-02-01T00:00:00.000Z	300
2026-02-11T00:00:00.000Z	15.75
```

Other model fields include `joins`, `having`, `qualify`, `dedupe`, `order_by`,
`windows`, `union`, `pivot`, `unpivot`, `flatten_json`, `pre_hook` and
`post_hook`. The [model reference](../reference/project-files.md#models) lists them
all.

## Seeds

Seeds are small CSV files that Dogsled loads as tables, such as mappings and
reference lists.

Create `seeds/data/regions.csv`:

```csv
customer,region
ada,north
grace,south
linus,north
```

Create `seeds/regions.yml`:

```yaml
spec_version: '0.2'
type: seed
name: regions
description: Customer to sales region.
payload:
  format: csv
  path: data/regions.csv
schema:
  columns:
    - { name: customer, type: STRING }
    - { name: region, type: STRING }
materialization:
  type: table
  target_schema: analytics
  on_conflict: replace
```

`dogsled model seed load` compiles the seed to SQL. To run it, it needs a small
runner module that executes SQL in your warehouse.

Create `runner.mjs`. It uses Dogsled's DuckDB connection:

```js
import { buildDuckDbRunner } from '@bobsled-inc/bobsled-core/connections';

async function withRunner(method, sql) {
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: { schema: 'analytics' },
    auth: { type: 'file', path: '.dogsled/dogsled.duckdb' },
  });
  try {
    return await runner[method](sql);
  } finally {
    await runner.close?.();
  }
}

export const run = (sql) => withRunner('run', sql);
export const query = (sql) => withRunner('query', sql);
```

```bash
dogsled model seed validate
dogsled model seed load --dialect duckdb --runner ./runner.mjs
dogsled query "SELECT * FROM analytics.regions ORDER BY customer" --db-path .dogsled/dogsled.duckdb
```

```text
customer	region
ada	north
grace	south
linus	north
```

To use a seed in a model, declare its table as a source, like any other table.
`dogsled model seed diff` compares the loaded table with the CSV; it needs
`unique_columns` or primary-key columns in the seed's schema.

## Test your models

Columns marked `primary_key: true` or `not_null: true`, and the `tests:` list, become
data tests. `dogsled model test` prints their SQL:

```bash
dogsled model test customer_revenue --integration warehouse
```

```text
-- customer_revenue: customer_not_null
SELECT * FROM "analytics"."customer_revenue" WHERE customer IS NULL;
...
✔ Generated 2 test(s).
```

Expectations check a built model and report violations. Add them under `expect:`,
for example to `models/customer_revenue.yml`:

```bash
cat >> models/customer_revenue.yml <<'EOF'
expect:
  - kind: row_count_between
    min: 1
    max: 100
  - kind: accepted_values
    column: customer
    values: [ada, grace, linus]
EOF
dogsled model expect run --integration warehouse --runner ./runner.mjs
```

```text
✔ customer_revenue: row_count_between row_count
✔ customer_revenue: accepted_values customer
```

Without `--runner`, `model expect run` prints the SQL instead of running it. With a
runner, it exits with code 2 when an expectation fails. The expectation kinds are `primary_key`, `non_null`, `unique`, `in_range`, `regex`,
`accepted_values`, `row_count_between`, `schema_contains`, `expression` and
`custom`.

## Lineage

```bash
dogsled model lineage top_customers --integration warehouse
```

```text
top_customers [bronze]
← customer_revenue (model)
```

`--column <model.column>` traces one column back to its sources, and `--json`
prints the full graph.

## Other model commands

- `dogsled model compile -o build/` writes the SQL to files; `--include-metadata`
  adds metrics, relationships and verified queries as JSON.
- `dogsled model dry-run` runs the compiled `SELECT`s without creating anything:
  `--mode parse`, `limit0` (default) or `sample` with `--row-limit`.
- `dogsled model profile <table> --integration <name>` samples a table and reports
  column types, formats, keys and anomalies; `profile suggest cleaning <table>`
  proposes cleaning expressions.
- `dogsled model generate --fromsql query.sql --sources sources/` turns a Snowflake
  `SELECT` statement into model files; each common table expression becomes an
  ephemeral model.
- `dogsled model init` scaffolds a model project with example files.
- `dogsled model models list` lists prebuilt model packages, and
  `model models install <package>` copies one into your project.
- `dogsled model ossie import` and `export` exchange models with the Open Semantic
  Interchange format. See [Semantic model](semantic-model.md).

## Models across warehouses

A model can join sources from different warehouses. `execution.engine` names the
integration that runs the join; Dogsled copies the other inputs into it first.
`DOGSLED_XWH_STAGING_FORMAT` (`jsonl` or `parquet`) and
`DOGSLED_XWH_SOURCE_TIMEOUT_S` control that copy.
