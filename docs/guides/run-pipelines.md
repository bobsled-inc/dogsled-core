# Run pipelines

A pipeline names a source, the resources to extract, and one or more destinations.
You declare pipelines and destinations once in `bobsled.yml`, check them with
`dogsled runner validate`, and run one with `dogsled runner run`. Dogsled Core has
no scheduler of its own: call `dogsled runner run` from cron, a CI job or your
orchestrator. This release has no GitHub Action; call `dogsled runner run` from a
workflow step. [Run Dogsled in production](run-in-production.md) has a complete
workflow and shows how to keep incremental state between runs.

The examples use the `shop` project from [Get started](../getting-started.md).

## Declare destinations and a pipeline

Add a `destinations` map and a `pipelines` map to `bobsled.yml`. This pipeline
loads the `orders` resource into DuckDB and also writes it to JSON Lines files:

```yaml
destinations:
  warehouse:
    type: duckdb
    db_path: .bobsled/bobsled.duckdb
    schema: raw
  archive:
    type: local
    format: jsonl

pipelines:
  shop_files:
    schedule: daily
    source: local_files
    destinations: [warehouse, archive]
    resources: [orders]
```

Append it to the file that `dogsled init` created:

```bash
cat >> bobsled.yml <<'EOF'

destinations:
  warehouse:
    type: duckdb
    db_path: .bobsled/bobsled.duckdb
    schema: raw
  archive:
    type: local
    format: jsonl

pipelines:
  shop_files:
    schedule: daily
    source: local_files
    destinations: [warehouse, archive]
    resources: [orders]
EOF
dogsled runner validate
```

```text
Pipelines (1):
shop_files: daily -> 0 6 * * *
✓ Configuration is valid
```

`source` is an integration name, from your project or from the
[integration library](use-library-integrations.md). Use `destination: warehouse`
for one destination, or `destinations: [...]` to load the same extraction into
several.

## Run it

```bash
dogsled runner run shop_files --quiet
dogsled query "SELECT count(*) AS orders FROM raw.shop_files__orders" --db-path .bobsled/bobsled.duckdb
ls output/orders
```

```text
orders
5
orders-0.jsonl
```

Tables are named `<pipeline>__<stream>` unless you set `table_prefix`. With several
destinations, Dogsled extracts once to a capture file, loads every destination from
it, and saves the incremental state only after all of them succeed.

`runner run` takes `--full-refresh`, `--resource <name...>` to run part of a
pipeline, and `--json` for machine-readable logs.

## Pipeline fields

| Field                              | Description                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `schedule`                         | Required. When an orchestrator should run the pipeline (see below).           |
| `source`                           | Required. The integration to extract from.                                    |
| `destination` or `destinations`    | Required. One destination name, or a list for fan-out.                        |
| `resources`                        | Required. Resource names, or objects that override settings for one resource. |
| `inputs`                           | Values for the resources' `input` parameters.                                 |
| `enabled`                          | `false` skips the pipeline.                                                   |
| `load_strategy`, `schema_behavior` | Override the destination defaults for this pipeline.                          |
| `table_prefix`                     | Table name prefix. Defaults to `<pipeline>__`.                                |
| `via`                              | Transport to use, for integrations that offer more than one.                  |

Settings apply in this order: destination, then pipeline, then resource.

`schedule` accepts `hourly`, `daily` (06:00), `weekly`, `monthly`, `every 4h`,
`every 30m`, `daily at 2pm`, `15 past hourly`, a five-field cron expression, or
`manual` for a pipeline that only runs when you start it.
`runner validate` prints the cron expression for each schedule.

## Destination types

`bobsled.yml` destinations accept these `type` values: `duckdb`, `bigquery`,
`snowflake`, `postgres`, `mysql`, `databricks`, `clickhouse`, `turbopuffer`,
`local`, `gcs` and `s3`, plus `bobsled_managed`, which only Dogsled Cloud can run
(see [Dogsled Cloud and Core](hosted-runs.md)). For DuckLake, SQLite and the other
`load run` destinations, pipe `extract run` into `load run` instead. The fields of
each type are in the [project file reference](../reference/project-files.md#destinations).

Put secrets in environment variables: `password: $PG_PASSWORD`.

## Models and entity-graph pipelines

A pipeline with `type: models` describes models to build on a schedule, and
`type: entity-graph` does the same for entity resolution:

```yaml
pipelines:
  nightly_models:
    type: models
    connection: warehouse
    models: '*'
    schedule: daily
```

These pipelines are instructions for an orchestrator such as Dogsled Cloud.
`runner validate` checks them, and `runner run` explains how to run them yourself:
`dogsled model run --integration <connection>` builds the same models.

## Split configuration across files

`bobsled.yml` is optional. Any YAML file with `type: pipeline_config` contributes
destinations and pipelines, so a large project can keep each domain's pipelines next
to its integrations. Dogsled merges the fragments by name; a duplicate pipeline or
destination name is an error. Pass `--config <file>` to read only one file, and
`--project-root <dir>` when you run commands from another directory.

`defaults` sets a run `timeout` (default `4h`) and `retry` (`attempts`, `backoff`)
for an orchestrator to apply.

## Check before you write

Each command below catches a different kind of problem without writing to your
destination. Run the narrowest one first:

| Command                                        | Catches                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `dogsled extract validate <integration>`       | YAML shape, resource wiring and environment variable references |
| `dogsled extract verify <integration> --mock`  | Response mapping and pagination, against recorded responses     |
| `dogsled extract scaffold-test <integration>`  | Credentials, with one record per resource from the live API     |
| `dogsled load check --dest <destination> ...`  | Destination connection and permissions                          |
| `dogsled runner validate`                      | Pipelines, destinations and the files they reference            |
| `dogsled model validate`, `dogsled model test` | Model structure, references and the SQL for model tests         |

## Move an existing job

You do not have to replace a working job in one step:

1. Write the integration and resources for the job's source, and run them into a
   separate DuckDB file, schema or `--table-prefix`, so nothing touches the old
   tables.
2. Compare row counts, columns, keys and a sample of rows with the old job's
   output, and keep its tests and checks running.
3. For the first real run, use `--full-refresh` into new tables rather than copying
   the old job's cursor.
4. Pause the old job, run Dogsled, check the data, and keep the old job ready to
   turn back on until the new one has run cleanly for a while.
