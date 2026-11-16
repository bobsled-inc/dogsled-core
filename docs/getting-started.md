# Get started

This page takes you from an empty folder to a SQL model you can query. You load a
small CSV file into a local DuckDB database, build a model on top of it, and then
add a second source from a public API. It takes about ten minutes and needs no
account, API key, or warehouse.

To set up your own data with an agent, use the `bobsled-get-started` skill. It
guides connections, sources, pipelines and models in a new or existing project.
The `bobsled-tutorials` skill is the separate entry point for example lessons.

For a guided experience with your coding agent and a local data explorer, try [TV Night](guides/tv-night.md). Connect to TVmaze, build your ETL and models, then improve your TV recommendations together.

You need Node.js 24 or later and npm.

## Install Dogsled

Create a folder and install the `@bobsled-inc/bobsled-core` package into it:

```bash
mkdir bobsled-quickstart
cd bobsled-quickstart
npm init -y > /dev/null
npm install @bobsled-inc/bobsled-core
npx dogsled --version
```

Dogsled installs into the folder's `node_modules`, so you run it with `npx dogsled`.
Installing Dogsled into each project keeps its version and warehouse drivers with
the project. You can also install it globally with
`npm install -g @bobsled-inc/bobsled-core` and run `dogsled` directly; then install any
warehouse drivers globally too.
Warehouse drivers are optional: you install them later, next to Dogsled, only for the
warehouses you use. See [Load data](guides/load-data.md#install-a-warehouse-driver).

## Create a project

```bash
npx dogsled init shop --duckdb
cd shop
```

`init` creates a project folder with a `bobsled.yml`, a `.bobsled/` folder for local
settings and data, and empty `integrations/` and `sources/` folders. `--duckdb`
makes a single DuckDB file, `.bobsled/bobsled.duckdb`, the default destination.
Without the flag, Dogsled uses a [DuckLake](https://ducklake.select/) catalog.

## Add some data

Create `data/orders.csv`:

```csv
order_id,customer,amount,ordered_at
1,ada,120.50,2026-01-03
2,grace,80.00,2026-01-04
3,ada,42.25,2026-01-09
4,linus,300.00,2026-02-01
5,grace,15.75,2026-02-11
```

## Describe the source

Dogsled reads data through an _integration_ (how to connect) and one or more
_resources_ (what to read). The built-in `local` source type reads files from a
folder.

Create `integrations/local_files.yml`:

```yaml
spec_version: '1'
type: integration
name: local_files
source_type: local
connection:
  base_directory: data
auth:
  type: none
```

Create `resources/local_files/orders.yml`:

```yaml
spec_version: '1'
type: resource
name: orders
integration: local_files
source:
  path: orders.csv
  format: csv
  options:
    header: true
replication:
  method: full_refresh
extract:
  table:
    primary_key: [order_id]
    load_strategy: full_refresh
output:
  order_id: { type: integer }
  customer: { type: string }
  amount: { type: number }
  ordered_at: { type: timestamp }
```

Check both files:

```bash
npx dogsled extract validate local_files
```

## Extract and load

`dogsled extract run` reads the resource and writes records to standard output.
`dogsled load run` reads those records and writes them to a destination. Pipe one
into the other:

```bash
npx dogsled extract run --integration local_files orders --log-format pretty \
  | npx dogsled load run --dest duckdb --db-path .bobsled/bobsled.duckdb --target-schema raw
```

```text
ℹ Starting extraction: local_files/orders
...
ℹ Extraction complete: 5 total records
[loader] orders: strategy=full_refresh
[loader] orders: loaded 5 rows stream=orders batchId=1 rowsAffected=5 loadMs=3
{"_v":1,"type":"STATE","stream":"orders","value":{"record_count":5,"last_run_at":"2026-10-21T23:04:43.579Z"}}
```

Extraction logs go to standard error. They are JSON lines unless you pass
`--log-format pretty`. The last line is a `STATE` message: the loader passes it on
to standard output so that a scheduler can store where the extraction stopped. The
[protocol reference](reference/protocol.md) describes every message type.

Query the new `raw.orders` table:

```bash
npx dogsled query "SELECT order_id, customer, amount FROM raw.orders ORDER BY order_id" \
  --db-path .bobsled/bobsled.duckdb
```

```text
order_id	customer	amount
1	ada	120.5
2	grace	80
3	ada	42.25
4	linus	300
5	grace	15.75
```

Dogsled adds two columns to every loaded table: `_time_extracted` and
`_bobsled_loaded_at`.

## Build a model

A model is a YAML file that Dogsled compiles to SQL for your warehouse. Models read
from _sources_: tables that already exist in the warehouse. To build one, you tell
Dogsled which database to run in, which table to read, and what to compute.

Create `integrations/warehouse.yml`. It points the models at the DuckDB file and
puts their output in an `analytics` schema:

```yaml
spec_version: '1'
type: integration
name: warehouse
source_type: duckdb
connection:
  schema: analytics
auth:
  type: file
  path: .bobsled/bobsled.duckdb
```

Create `sources/orders.yml`. Sources and models use `spec_version: '0.2'`, while
integrations and resources use `'1'`; each kind of file has its own version.

```yaml
spec_version: '0.2'
type: source
name: orders
source_type: warehouse_table
connection: warehouse
table: raw.orders
schema:
  columns:
    - { name: order_id, type: INTEGER }
    - { name: customer, type: VARCHAR }
    - { name: amount, type: DOUBLE }
    - { name: ordered_at, type: TIMESTAMP }
```

Create `models/customer_revenue.yml`:

```yaml
spec_version: '0.2'
type: model
name: customer_revenue
description: Order count and total amount per customer.
grain: [customer]
source:
  ref: warehouse.orders
columns:
  - name: customer
    expr: customer
    primary_key: true
  - name: order_count
    expr: count(*)
  - name: total_amount
    expr: sum(amount)
group_by: [customer]
materialization:
  type: table
```

Validate the model, look at the SQL it compiles to, then run it:

```bash
npx dogsled model validate --integration warehouse
npx dogsled model compile --integration warehouse
npx dogsled model run --integration warehouse
```

```text
✓ customer_revenue (3 columns)
Validated 1 model(s): 1 passed
...
CREATE OR REPLACE TABLE "analytics"."customer_revenue" AS (
SELECT customer AS customer, COUNT(*) AS order_count, SUM(amount) AS total_amount FROM raw.orders GROUP BY customer
);
...
✓ customer_revenue: executed.
✓ Executed 1 model operation(s).
```

Query the model:

```bash
npx dogsled query "SELECT * FROM analytics.customer_revenue ORDER BY total_amount DESC" \
  --db-path .bobsled/bobsled.duckdb
```

```text
customer	order_count	total_amount
linus	1	300
ada	2	162.75
grace	2	95.75
```

## Add a public API

API sources use the same integration and resource files. This one reads the users
from [JSONPlaceholder](https://jsonplaceholder.typicode.com), a free test API with
fictional data and no authentication.

Create `integrations/jsonplaceholder.yml`:

```yaml
spec_version: '1'
type: integration
name: jsonplaceholder
transport:
  type: http
  base_url: https://jsonplaceholder.typicode.com
  auth:
    type: none
```

Create `resources/jsonplaceholder/users.yml`. `input` lists the parameters the
resource accepts (none here), and each `path` is a JSONPath into one item of the
response:

```yaml
spec_version: '1'
type: resource
name: users
description: Fictional users from the JSONPlaceholder test API.
integration: jsonplaceholder
input: {}
api:
  endpoint: /users
  method: GET
output:
  id: { type: integer, path: $.id }
  name: { type: string, path: $.name }
  email: { type: string, path: $.email }
  city: { type: string, path: $.address.city }
extract:
  record_path: $
  table:
    primary_key: [id]
```

Extract, load and query it the same way:

```bash
npx dogsled extract validate jsonplaceholder
npx dogsled extract run --integration jsonplaceholder users --quiet \
  | npx dogsled load run --dest duckdb --db-path .bobsled/bobsled.duckdb --target-schema raw
npx dogsled query "SELECT id, name, city FROM raw.users ORDER BY id LIMIT 3" \
  --db-path .bobsled/bobsled.duckdb
```

```text
[loader] users: loaded 10 rows stream=users batchId=1 rowsAffected=10 loadMs=6
...
id	name	city
1	Leanne Graham	Gwenborough
2	Ervin Howell	Wisokyburgh
3	Clementine Bauch	McKenziehaven
```

## Check the project

`dogsled doctor` checks the files in the project and reports problems:

```bash
npx dogsled doctor
```

## What you built

```text
shop/
  bobsled.yml                     project settings
  .bobsled/bobsled.duckdb         the local warehouse
  data/orders.csv                 the CSV source data
  integrations/local_files.yml    file integration
  integrations/jsonplaceholder.yml  HTTP integration
  integrations/warehouse.yml      where models run
  resources/local_files/orders.yml
  resources/jsonplaceholder/users.yml
  sources/orders.yml              a warehouse table models can read
  models/customer_revenue.yml     a SQL model
```

## Next steps

- [Concepts](concepts.md) explains how integrations, resources, sources and models fit together.
- [Extract from an API](guides/extract-from-an-api.md) covers authentication, pagination and incremental loads.
- [Use library integrations](guides/use-library-integrations.md) starts from one of 83 ready-made integrations.
- [Load data](guides/load-data.md) moves the same pipeline to Postgres, Snowflake or BigQuery.
- [Build models](guides/build-models.md) covers views, incremental models, seeds and tests.
- [Run pipelines](guides/run-pipelines.md) puts extract and load into `bobsled.yml`.
