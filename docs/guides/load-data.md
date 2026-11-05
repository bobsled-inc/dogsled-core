# Load data

`dogsled load run` reads Dogsled protocol messages from standard input and writes
each stream to a table, or to files. This page shows how to load into the common
destinations, how the load strategies work, and how to check a destination before
you load.

The examples use the `shop` project from [Get started](../getting-started.md).
Save one extraction to a file so that you can load it several times:

```bash
dogsled extract run --integration local_files orders --quiet > orders.jsonl
```

## Destinations

| `--dest`                | Writes to                                                        | Driver to install                             |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `local` (default)       | Files in `--output-dir`, as `jsonl`, `csv`, `parquet` or `arrow` | None                                          |
| `duckdb`, `ducklake`    | A local DuckDB file, or a DuckLake catalog                       | None                                          |
| `sqlite`                | A local SQLite file                                              | `better-sqlite3`                              |
| `postgres`, `pgvector`  | PostgreSQL                                                       | None: `pg` is installed with Dogsled          |
| `snowflake`             | Snowflake                                                        | `snowflake-sdk`                               |
| `bigquery`              | BigQuery                                                         | `@google-cloud/bigquery`                      |
| `mysql`                 | MySQL or MariaDB                                                 | `mysql2`                                      |
| `mssql`                 | SQL Server                                                       | `tedious`                                     |
| `databricks`            | Databricks SQL                                                   | `@databricks/sql`                             |
| `clickhouse`            | ClickHouse                                                       | `@clickhouse/client`                          |
| `gcs`, `s3`             | Files in a bucket                                                | None: both clients are installed with Dogsled |
| `elasticsearch`         | Elasticsearch                                                    | None                                          |
| `chroma`, `turbopuffer` | Vector stores                                                    | `chromadb`, `@turbopuffer/turbopuffer`        |

The [connector reference](../reference/connectors.md#destinations) lists every
destination's flags.

### Install a warehouse driver

Warehouse drivers are optional. Install the ones you need in the same project as
Dogsled, for example the Snowflake driver:

```bash
npm install 'snowflake-sdk@>=3.4.0'
```

PostgreSQL needs no extra step: Dogsled installs `pg`, and if your project already
has `pg` 8.4 or a later 8.x release, Dogsled uses that copy.

Dogsled checks the installed driver version before it connects and stops with a
clear error if the driver is missing or too old. The minimum versions are listed in
[Installed dependency security](../dependency-security.md#driver-security-minimums).

## DuckDB and DuckLake

```bash
dogsled load run --dest duckdb --db-path warehouse.duckdb --target-schema raw < orders.jsonl
```

```text
[loader] orders: strategy=full_refresh
[loader] orders: loaded 5 rows stream=orders batchId=1 rowsAffected=5 loadMs=3
```

[DuckLake](https://ducklake.select/) keeps table metadata in a catalog and the data
in Parquet files. Loading needs the catalog URL. To query, attach the catalog in
DuckDB:

```bash
dogsled load run --dest ducklake --ducklake-catalog-url ducklake:lake.ducklake \
  --target-schema raw < orders.jsonl
dogsled query "LOAD ducklake; ATTACH 'ducklake:lake.ducklake' AS lake; SELECT count(*) AS orders FROM lake.raw.orders" \
  --db-path query.duckdb
```

```text
[loader] orders: loaded 5 rows
...
orders
5
```

DuckDB downloads its DuckLake extension the first time you use it.

## PostgreSQL

Pass connection details as flags. Pass secrets as an environment variable
reference in single quotes, `'$PG_PASSWORD'`, so that Dogsled reads the value
itself and the password never appears in your shell history or the process list:

```bash
export PG_PASSWORD=<password>
dogsled load check --dest postgres --postgres-host db.example.com --postgres-port 5432 \
  --postgres-database analytics --postgres-schema raw --postgres-user loader \
  --postgres-password '$PG_PASSWORD'
dogsled load run --dest postgres --postgres-host db.example.com --postgres-port 5432 \
  --postgres-database analytics --postgres-schema raw --postgres-user loader \
  --postgres-password '$PG_PASSWORD' < orders.jsonl
```

```text
✓ Postgres: connected to db.example.com:5432/analytics
[loader] orders: strategy=full_refresh
[loader] orders: loaded 5 rows
```

Add `--postgres-ssl` for TLS. `load check` connects and creates the schema if it
is missing, so run it before the first load.

## Snowflake

Snowflake supports password, key-pair, OAuth token, token command and workload
identity authentication. With a key pair:

```bash
dogsled load run --dest snowflake \
  --sf-account <account> --sf-username <user> --sf-role <role> \
  --sf-private-key-path ./snowflake_key.p8 \
  --sf-warehouse <warehouse> --sf-database <database> --target-schema <schema> \
  < orders.jsonl
```

```text
[loader] orders: strategy=full_refresh
...
{"_v":1,"type":"STATE","stream":"orders","value":{"record_count":5,
```

Dogsled stages the rows and loads them with `COPY INTO`. The Snowflake driver logs
its own connection messages to standard error.

## BigQuery

BigQuery uses a service-account key file with `--key-filename`, or Application
Default Credentials when you leave it out:

```bash
dogsled load run --dest bigquery --project-id <project> --dataset-id <dataset> \
  --location US < orders.jsonl
dogsled query "SELECT customer, SUM(amount) AS total FROM orders GROUP BY customer ORDER BY total DESC" \
  --dest bigquery --project-id <project> --dataset-id <dataset> --location US
```

```text
[loader] orders: strategy=full_refresh
...
customer	total
linus	300
ada	162.75
grace	95.75
```

## Load strategies

Each stream has a load strategy. The extractor sets it in the stream's `SCHEMA`
message, from the resource's `extract.table.load_strategy`, or from its incremental
settings and primary key. A file Resource with `replication.method: incremental_append`
uses `append`:

| Strategy       | What it does                                                                             |
| -------------- | ---------------------------------------------------------------------------------------- |
| `append`       | Inserts every record.                                                                    |
| `merge`        | Updates rows whose primary key already exists and inserts the rest. Needs a primary key. |
| `full_refresh` | Replaces the table with this run's records.                                              |

Override it for one run with `--load-strategy`, or for one stream with
`--stream-load-strategy orders:append`.

New columns in the source are added to the table. `--schema-behavior` (or
`--stream-schema-behavior`) changes that: `evolve` (the default) adds columns,
`strict` fails when the schema changed, and `freeze` keeps the table as it is.
Every loaded table also gets `_time_extracted` and `_dogsled_loaded_at` columns.

Other useful flags: `--table-prefix` (for example `stripe__`), `--stream-table
stream:table` to rename one table, and `--dry-run` to print the strategy for each
stream without writing.

## Check loaded data

`dogsled load assert` runs SQL checks against a DuckDB or BigQuery destination and
exits with code 1 if any check fails.

Create `checks.yml`:

```yaml
checks:
  - name: all orders loaded
    sql: SELECT count(*) AS n FROM raw.orders
    expect:
      n: { equals: 5 }
  - name: no negative amounts
    sql: SELECT min(amount) AS lowest FROM raw.orders
    expect:
      lowest: { min: 0 }
```

```bash
dogsled load assert --checks checks.yml --db-path warehouse.duckdb
```

```text
ok all orders loaded
ok no negative amounts
```

Each expectation takes `equals`, `min` or `max`.

## Extract and load in one command

`dogsled pipeline` runs `extract run` and `load run` together and saves the
incremental state when the extraction succeeds. It takes the same destination
flags, and ends with a JSON summary of the run:

```bash
dogsled pipeline --integration local_files --resource orders --log-format pretty \
  --dest duckdb --db-path pipeline.duckdb --target-schema raw
```

```text
orders: 5 records, 0 API calls
...
{"_v":1,"type":"PIPELINE_SUMMARY","integration":"local_files","elapsed_seconds":
```

To describe destinations once and reuse them, and to load one extraction into
several destinations, use `dogsled.yml`: see [Run pipelines](run-pipelines.md).
