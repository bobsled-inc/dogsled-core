# Model Spec

This workspace is bundled inside `@bobsled-inc/dogsled` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Declarative data modeling and entity resolution that compiles to warehouse SQL.

Define your sources, transformations, joins, materializations, and entity resolution pipelines in YAML. Model Spec compiles them into deterministic, target-aware DDL for Snowflake, BigQuery, Postgres, pgvector, Redshift, Databricks, MySQL, or DuckDB.

```text
YAML specs  ──>  Model Spec compiler  ──>  CREATE VIEW / TABLE / MERGE SQL
```

> **CLI:** Use `dogsled model <command>` / `dogsled model <command>` for data modeling and `dogsled entity-graph <command>` / `dogsled entity-graph <command>` for entity graph workflows. The standalone package binary here is `model` for modeling only. Standalone Entity Graph commands now live in the `@bobsled-inc/entity-graph` package and its `entity-graph` binary.
>
> **Install note:** The `dogsled entity-graph` examples below use the unified CLI from `@bobsled-inc/dogsled`. The standalone compiler package does not install a separate Entity Graph command.

## Why Model Spec?

Data warehouses accumulate complexity. Hundreds of tables, thousands of relationships, scattered SQL files. Model Spec gives you a single declarative layer to manage it:

- **Several warehouses.** Model Spec compiles one model to SQL for Snowflake, BigQuery, PostgreSQL, Databricks, ClickHouse and DuckDB, and runs it there. It also compiles, without running, for MySQL, Redshift and pgvector. Expressions use ANSI SQL; the compiler handles target-specific quoting, function mapping and DDL differences.
- **Agent-authored, human-reviewed.** The YAML format is designed for AI agents to read, generate, and modify programmatically. Each spec is self-contained and easy for humans to review — one file per model, plain YAML, no hidden state.
- **Dependency-aware.** Models reference other models. The compiler builds a DAG, resolves refs, and compiles in topological order.
- **Entity resolution built in.** Match and merge duplicate records across data sources with a declarative pipeline — standardize, block, score, threshold, review, cluster — all from YAML.

## Install

Install `@bobsled-inc/dogsled`; this code ships inside it.

## Quick Start

### 1. Scaffold a project

```sh
dogsled model init my-project
cd my-project
```

This creates:

```text
my-project/
├── model-spec.yml                                      # Project directories and checkpoint storage
├── integrations/example.yml                     # DuckDB integration (credentials-free, local)
├── sources/example/raw_users.yml                # Source definition
├── models/stg_users.yml                         # Model definition
├── metrics/users_total.yml                      # First-class metric (JSON-emitted)
├── relationships/README.md                      # Relationship spec template (markdown)
└── vqs/users_created_this_month.yml             # Verified query (NLQ → SQL)
```

### 2. Look at the source spec

`sources/example/raw_users.yml` registers a warehouse table:

```yaml
spec_version: '0.2'
name: raw_users
type: source
source_type: warehouse_table
connection: example
table: raw.raw_users
schema:
  columns:
    - name: id
      type: INTEGER
    - name: email
      type: VARCHAR
    - name: created_at
      type: TIMESTAMP
```

A source tells the compiler: "this table exists in the warehouse, and here are its columns."

### 3. Look at the model spec

`models/stg_users.yml` defines a transformation:

```yaml
spec_version: '0.2'
name: stg_users
type: model
description: Staged users with cleaned fields
grain: user_id
source:
  ref: example.raw_users
columns:
  - name: user_id
    expr: id
    primary_key: true
  - name: email
    expr: LOWER(email)
  - name: created_at
    expr: created_at
materialization:
  type: view
```

A model reads from a source (or another model), defines output columns as expressions, and specifies how to materialize the result.

### 4. Compile to SQL

```sh
dogsled model compile --integration example
```

Output:

```sql
CREATE OR REPLACE VIEW PUBLIC.stg_users AS
SELECT
  t0."id" AS "user_id",
  LOWER(t0."email") AS "email",
  t0."created_at" AS "created_at"
FROM raw.raw_users AS t0;
```

`--integration` is always optional. Omit it to fan the command out over **every** integration declared under `integrations/` — Model Spec emits a per-integration block (or writes under `target/<handle>/`) and skips integrations that no model references. Pass `--integration <handle>` to narrow the run to one integration.

### 5. Target a different dialect via a second integration

Drop a second file under `integrations/`:

```yaml
# integrations/bigquery_dev.yml
spec_version: '1'
type: integration
name: bigquery_dev
source_type: bigquery
connection:
  project_id: my-dev-project
auth:
  type: adc
```

```sh
dogsled model compile --integration bigquery_dev
```

```sql
CREATE OR REPLACE VIEW PUBLIC.stg_users AS
SELECT
  t0.`id` AS `user_id`,
  LOWER(t0.`email`) AS `email`,
  t0.`created_at` AS `created_at`
FROM raw.raw_users AS t0;
```

Same YAML specs, different SQL dialect. Quoting, casing, and function calls adapt automatically.

When a project declares multiple integrations, each source pins itself to one via `connection: <handle>` (matching the `name` of a `type: integration` file, wherever it lives). Running `dogsled model compile` without `--integration` fans out: every declared integration compiles its own subgraph in the correct dialect, and integrations that no model references are skipped with a warning. A model that joins or unions sources from two different handles is rejected by default; add `publish: <target-handle>` when the model should be staged by Dogsled and landed in a specific warehouse. `dogsled model run` keeps per-integration state under `<handle>.<model>` keys in `.dogsled/model-spec/run-state.json`.

### Cross-Warehouse Publish

Use `publish:` when one model needs to read warehouse-table sources from multiple integrations and land the result in one target warehouse:

```yaml
spec_version: '0.2'
name: customer_event_revenue
type: model
description: Customer events enriched with Snowflake account metadata.
grain: event_id
publish:
  target: databricks
  target_schema: analytics
source:
  ref: databricks.events
joins:
  - ref: snowflake.accounts
    type: left
    on: databricks.events.account_id = snowflake.accounts.account_id
columns:
  - { name: event_id, expr: databricks.events.event_id, type: integer, primary_key: true }
  - { name: account_id, expr: databricks.events.account_id, type: integer }
  - { name: account_name, expr: snowflake.accounts.account_name, type: string }
  - { name: event_value, expr: databricks.events.event_value, type: number }
materialization:
  type: table
```

`dogsled model run --integration databricks` stages the referenced source columns into destination-side temporary tables, evaluates the model SELECT in the destination warehouse, and applies the requested destination materialization.

Current scope:

- `materialization.type: table`, `incremental`, and `snapshot` are supported. `view`, `materialized_view`, `dynamic_table`, and `ephemeral` are rejected because they imply zero data movement.
- If the destination integration sets `cross_warehouse_staging.uri`, sources with native UNLOAD support write Parquet to that shared URI and the destination loads from it. Sources without UNLOAD, Postgres sources, and failed UNLOAD attempts fall back to streaming.
- Incremental published models can set `cursor_field` to prune the driving source after the first successful run.
- Incremental and snapshot published models honor `materialization.on_schema_change` before writing.
- Sources for published models must use long-lived credentials (Snowflake `rsa_key` or `pat`, Databricks `pat`, Postgres `password` / `iam`). `oauth` / `oauth_m2m` are rejected at validation time because token TTLs (default 1h on Snowflake) cannot cover multi-hour publishes.
- Single publish target per model. Multi-target fan-out and per-environment publish targets are roadmap items.
- Publish-specific row caps, minimum rerun intervals, restart/resume, and cost estimation are intentionally deferred.

See `../../examples/cross-warehouse/` for a Snowflake + Databricks fixture and `../../docs/reference/advanced/cross-warehouse-cookbook.md` for the full production walkthrough including the Postgres + Snowflake → Databricks scenario at scale.

### Mixed Models: `execution.engine` and live/lazy API sources

`execution.engine: <handle>` names the integration the model runs in, and is what relaxes the "no two-handle joins" rule for a model that intentionally mixes sources from different integrations. `publish: <handle>` is the equivalent alias when the engine is a warehouse. The engine's `source_type` selects one of two paths:

- **Warehouse engine** (Snowflake/BigQuery/Postgres/Databricks/DuckDB-as-warehouse) with a **persisted** materialization (`table` / `incremental` / `snapshot`) → the cross-warehouse publish path above: foreign leaves stage into the engine, then the model materializes there.
- **DuckDB engine** with a **`view`** → the live recompute path: foreign warehouse leaves are staged into that DuckDB and the view recomputes on every run.

A mixed model can also join a **live/lazy API source** (an `api_resource` with `mode: live` or `lazy`) with warehouse tables — e.g. live API issues enriched with a warehouse `teams` table:

```yaml
spec_version: '0.2'
name: team_issues_live
type: model
grain: issue_id
execution:
  engine: lake # a DuckDB integration: stage crm.teams into it, recompute the view
source:
  ref: lake.linear_issues_live # api_resource, mode: live
joins:
  - ref: crm.teams # warehouse_table in a separate integration
    type: left
    on: lake.linear_issues_live.team_key = crm.teams.team_key
columns:
  - { name: issue_id, expr: lake.linear_issues_live.id, primary_key: true }
  - { name: team_name, expr: crm.teams.team_name }
materialization:
  type: view
```

Rules that keep the two axes (source freshness vs. where the model runs) from colliding:

- **API leaves always stream** into the engine — there is no source warehouse to `UNLOAD` from, so the GCS/Parquet substrate applies only to warehouse leaves.
- **A persisted model cannot root on a `live` source** (it must be a `view`). A live source has no persistent home, so freezing it into a table would contradict "live"; use a `lazy` source if you want to materialize a snapshot.
- **A published model's engine must not be the live source cache's own DuckDB file.** Publishing into the cache file corrupts it (the live orchestrator and the publisher open it as two uncoordinated handles); point persisted mixed models at a separate warehouse / DuckDB file.

See `../../examples/mixed-models/` for a runnable API + Snowflake + BigQuery fixture.

### 6. Run models against the warehouse

`dogsled model run` constructs the runner itself from the active integration file — no hand-written runner module required for the supported dialects. Credentials flow in via `${{ env.VAR }}` tokens (or legacy `_env` suffix fields) that Model Spec resolves through an `EnvSecretResolver` at runtime.

Preview the execution plan (dry run):

```sh
dogsled model run --integration example --dry-run
```

Execute for real:

```sh
dogsled model run --integration example --secrets secrets.env.yml
```

The `--secrets <path>` file is an optional flat YAML map of env-var names to values, layered on top of `process.env` (so test overrides don't require exporting vars). For a Snowflake integration you might set `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD`, etc.

Real built-in runners ship for all five V0 dialects — **DuckDB**, **Snowflake** (`pat` / `rsa_key` / `oauth`), **BigQuery** (`adc` / `wif` / `service_account`), **Postgres** (`password` / `iam`), and **Databricks** (`pat` / `oauth_m2m`). Drivers are dynamically imported and declared as optional peer deps so the package compiles without them installed. The only built-in gap is `(snowflake, sledhouse_oidc)` — hosts (e.g. the host application) plug that in through `@bobsled-inc/connections`'s `CustomRunnerRegistry`.

Model Spec handles compilation, dependency ordering, and incremental state tracking. The runner just executes SQL.

On BigQuery, `model run` checks every model before it runs. Source tables are
checked against `INFORMATION_SCHEMA` up front, and a missing source table fails
the run with its name. Each model's SQL is then dry-run. A model whose inputs
already exist is dry-run before anything executes. A model that reads a table or
view built earlier in the same run is dry-run just before it executes, once that
upstream exists. A failed dry run stops that model and skips its dependents. An
upstream model that the run does not build, for example one outside a `--select`
subset, must already exist. `model validate` never contacts the warehouse.
`model run --json` lists the models whose dry run waited in each integration's
`deferred_models`.

A model whose upstream already exists is checked against that existing upstream.
If one change adds a column to an upstream model and reads it in a downstream
model, the up-front dry run fails because the old upstream has no such column.
Run the upstream first, then the rest:

```sh
dogsled model run stg_orders --integration warehouse
dogsled model run stg_orders+ --integration warehouse
```

A source whose table is built by a model in the same run is ordered after that
model only when the model already runs first. Otherwise Dogsled warns; use
`ref: <model>` instead of the source so the DAG orders them.

### 7. Profile a table or model

Use `model profile` before authoring model metadata, cleaning expressions, or entity graph specs. It samples a warehouse table or Model Spec model and emits confidence-scored type, format, semantic-role, anomaly, primary-key, foreign-key, and cleaning-suggestion evidence.

```sh
dogsled model profile ecom.raw_customers --integration ecom --json
dogsled model profile fct_orders --integration ecom --sample-size 1000 --json
dogsled model profile suggest cleaning ecom.raw_customers --integration ecom --confidence-min 0.9 --json
```

The command resolves Model Spec source refs, Model Spec model names, fuzzy source names, and direct physical table refs. When profiling a model with column `references`, it samples the referenced target model so FK candidates can include observed hit-rate evidence.

For the full workflow, see:

- [Model Profiler Quick Start](docs/profiler-quickstart.md)
- [Model Profiler User Guide](docs/profiler-user-guide.md)

## Programmatic Edit API

Agents and web UIs can make granular, validation-backed edits to Model Spec YAML specs through the package subpath:

```ts
import { addModelColumn, updateModel, updateSourceColumn } from '@bobsled-inc/model-spec/edit';

const result = updateSourceColumn({
  projectDir: '/repo/analytics',
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: {
    description: 'Primary email address for customer communications',
    pii: true,
    semantic_role: 'email',
  },
});

if (!result.ok) throw new Error(result.error);
```

The edit API reads the current YAML file, applies one targeted mutation, validates the serialized result with the same schemas used by the compiler, and writes atomically. Successful edits return `{ filePath, content }` so callers can display diffs without re-reading.

Use `dryRun: true` to preview content without writing:

```ts
const preview = addModelColumn({
  projectDir: '/repo/analytics',
  modelName: 'stg_orders',
  column: {
    name: 'ORDER_YEAR',
    expr: "DATE_PART('year', ORDER_DATE)",
    description: 'Year the order was placed',
  },
  dryRun: true,
});
```

Supported edit functions cover source columns, model columns, model/source metadata, metrics, relationships, and verified queries. See [Programmatic Edit API](docs/programmatic-edit-api.md) for the full reference and the `dogsled-model-spec-edit` skill for agent usage.

## Concepts

### Sources

A **source** registers an existing warehouse table so models can reference it. Sources live in `sources/` organized by connection name.

```yaml
spec_version: '0.2'
name: raw_orders
type: source
source_type: warehouse_table
connection: ecom # Used in refs: ecom.raw_orders
table: RAW.RAW_ORDERS # Fully-qualified table in the warehouse
schema:
  columns:
    - name: ID
      type: NUMBER
    - name: CUSTOMER_ID
      type: NUMBER
    - name: TOTAL
      type: NUMBER
    - name: STATUS
      type: VARCHAR
    - name: ORDERED_AT
      type: TIMESTAMP
```

### Models

A **model** defines a derived relation. It reads from a source or another model, applies column expressions, and materializes as a view, table, or other strategy.

```yaml
spec_version: '0.2'
name: stg_orders
type: model
description: Staging layer for orders
grain: order_id
source:
  ref: ecom.raw_orders # connection.source_name for sources
columns:
  - name: ORDER_ID
    expr: ID
    primary_key: true
  - name: SUBTOTAL
    expr: 'CAST(SUBTOTAL / 100.0 AS NUMERIC(16, 2))'
  - name: ORDER_DATE
    expr: "DATE_TRUNC('day', ORDERED_AT)"
materialization:
  type: view
```

### Source Spec Fields

| Field                            | Required | Description                                                          |
| -------------------------------- | -------- | -------------------------------------------------------------------- |
| `spec_version`                   | Yes      | Must be `"0.2"`                                                      |
| `name`                           | Yes      | Identifier for this source (e.g. `raw_orders`)                       |
| `type`                           | Yes      | Must be `source`                                                     |
| `source_type`                    | Yes      | Must be `warehouse_table`                                            |
| `connection`                     | Yes      | Namespace used in model refs (e.g. `ecom` enables `ecom.raw_orders`) |
| `table`                          | Yes      | Fully-qualified warehouse table name (e.g. `RAW.RAW_ORDERS`)         |
| `schema.columns`                 | Yes      | Array of columns, each with `name` and `type`                        |
| `description`                    | No       | Human-readable description of the source                             |
| `trust_tier`                     | No       | Data quality tier: `bronze`, `silver`, or `gold`                     |
| `quality.freshness.max_age`      | No       | Maximum acceptable data age (e.g. `24h`)                             |
| `quality.row_count.min` / `.max` | No       | Expected row count bounds                                            |

### Model Spec Fields

| Field                    | Required | Description                                                                              |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `spec_version`           | Yes      | Must be `"0.2"`                                                                          |
| `name`                   | Yes      | Identifier for this model (e.g. `fct_orders`)                                            |
| `type`                   | Yes      | Must be `model`                                                                          |
| `description`            | Yes      | Human-readable summary of what this model represents                                     |
| `grain`                  | Yes      | Unique key of the output — a single column name or array for composite keys              |
| `source.ref`             | Yes      | Base relation. `connection.name` for sources, just `name` for model refs                 |
| `source.filter`          | No       | WHERE condition applied to the base relation before joins                                |
| `columns`                | Yes      | Output columns, each with `name` and `expr`. Required unless `include_all_columns: true` |
| `materialization`        | Yes      | How the model is persisted. See [Materializations](#materializations)                    |
| `joins`                  | No       | Array of joins to other sources or models                                                |
| `group_by`               | No       | Column names to GROUP BY — enables aggregate functions in `expr`                         |
| `where`                  | No       | WHERE clause applied after joins                                                         |
| `having`                 | No       | HAVING clause for filtering aggregates. Requires `group_by`                              |
| `qualify`                | No       | Filter on window results. Emulated with a subquery on targets without the clause         |
| `order_by`               | No       | Array of `{ column, direction }` for sorting. Direction: `asc` or `desc`                 |
| `limit`                  | No       | Maximum number of output rows                                                            |
| `offset`                 | No       | Rows to skip. Requires `limit`                                                           |
| `distinct`               | No       | When `true`, emits `SELECT DISTINCT`                                                     |
| `include_all_columns`    | No       | When `true`, selects all source columns (`SELECT *`)                                     |
| `exclude_columns`        | No       | Columns to omit when using `include_all_columns`                                         |
| `flatten_json`           | No       | Flatten a JSON array column into rows. See [Flatten JSON](#flatten-json)                 |
| `hierarchy`              | No       | Walk a parent/child edge. See [Recursion](#recursion)                                    |
| `recurse`                | No       | Bounded fixpoint. See [Recursion](#recursion)                                            |
| `derived_columns`        | No       | Columns computed in an outer SELECT, can reference other computed columns                |
| `variables`              | No       | Key-value map. Use `$var_name` in expressions for substitution                           |
| `tests`                  | No       | Data quality assertions: `not_null`, `unique`, `accepted_values`, `custom`               |
| `pre_hook` / `post_hook` | No       | SQL statements to run before/after materialization                                       |
| `tags`                   | No       | Array of string tags for categorization                                                  |
| `owner`                  | No       | Owner of this model (person or team)                                                     |
| `trust_tier`             | No       | Data quality tier: `bronze`, `silver`, or `gold`                                         |
| `target_schema`          | No       | Override the integration's default schema for this model                                 |
| `target_database`        | No       | Override the integration's default database for this model (non-Postgres only)           |

### Column Fields

| Field           | Required | Description                                                                                                |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | Output column name (valid SQL identifier)                                                                  |
| `expr`          | Yes      | SQL expression that computes this column's value                                                           |
| `description`   | No       | Human-readable description                                                                                 |
| `type`          | No       | Data type hint (e.g. `NUMBER`, `VARCHAR`)                                                                  |
| `primary_key`   | No       | Marks this column as part of the primary key                                                               |
| `not_null`      | No       | Asserts the column must not contain NULLs                                                                  |
| `semantic_role` | No       | One of: `entity_id`, `measure`, `event_timestamp`, `extraction_timestamp`, `time_dimension`, `categorical` |
| `references`    | No       | Foreign key reference (e.g. `stg_customers.CUSTOMER_ID`)                                                   |
| `tags`          | No       | Array of string tags                                                                                       |
| `business_rule` | No       | Documents the business logic behind this column                                                            |

### Join Fields

| Field           | Required | Description                                                                |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `ref`           | Yes      | Source or model to join (e.g. `stg_customers`)                             |
| `type`          | Yes      | Join type: `left`, `inner`, `cross`, or `full`                             |
| `on`            | Yes      | Join condition expression                                                  |
| `description`   | No       | Human-readable description of the join                                     |
| `pre_aggregate` | No       | Aggregate the joined relation before joining. Has `group_by` and `columns` |

### Joins

Models can join other models or sources:

```yaml
source:
  ref: stg_orders
joins:
  - ref: stg_customers
    type: left
    on: 'stg_orders.CUSTOMER_ID = stg_customers.CUSTOMER_ID'
columns:
  - name: ORDER_ID
    expr: stg_orders.ORDER_ID
  - name: CUSTOMER_NAME
    expr: stg_customers.CUSTOMER_NAME
```

Join types: `left`, `inner`, `cross`, `full`.

### Expressions

Column `expr` fields are SQL expressions. The compiler parses them into an AST and transpiles to the target dialect:

```yaml
# Column references
expr: ID
expr: stg_orders.ORDER_ID

# Functions (auto-transpiled across dialects)
expr: LOWER(EMAIL)
expr: "DATE_TRUNC('day', ORDERED_AT)"
expr: "COALESCE(PHONE, 'N/A')"

# Arithmetic and casting
expr: "CAST(AMOUNT / 100.0 AS NUMERIC(16, 2))"

# CASE expressions
expr: "CASE WHEN STATUS = 'active' THEN 1 ELSE 0 END"

# Window functions, including frames and explicit null placement
expr: "ROW_NUMBER() OVER (PARTITION BY CUSTOMER_ID ORDER BY CREATED_AT DESC NULLS LAST)"
expr: "SUM(AMOUNT) OVER (PARTITION BY CUSTOMER_ID ORDER BY ORDER_DATE ROWS UNBOUNDED PRECEDING)"
```

The canonical argument order stays the same across warehouses:

| Function                             | Dialect mapping                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp_diff('unit', start, end)` | SF/DB: `TIMESTAMPDIFF(UNIT, start, end)`; BQ: `TIMESTAMP_DIFF(end, start, UNIT)`; PG: integer interval arithmetic; DuckDB: `date_diff('unit', start, end)` |
| `position(needle, haystack)`         | SF: `CHARINDEX(needle, haystack)`; BQ: `STRPOS(haystack, needle)`; PG/DuckDB: `POSITION(needle IN haystack)`; DB: `LOCATE(needle, haystack)`               |

`position` returns the first character's 1-based index, or `0` when absent.
For PostgreSQL and DuckDB, `timestamp_diff` supports `microsecond`, `millisecond`,
`second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, and `year`.
Use typed timestamp inputs, for example `CAST('1970-01-01' AS TIMESTAMP)`.
PostgreSQL truncates elapsed fixed-length units toward zero and returns `BIGINT`;
month, quarter, and year use completed calendar months from `age(end, start)`.
Unsupported PostgreSQL units fail during compilation. DuckDB returns `BIGINT`
from `date_diff`, which counts unit boundaries: crossing from `00:59:59` to
`01:00:00` is one hour, and January 31 to February 1 is one month. These can differ
from PostgreSQL's elapsed units. Other warehouses retain their native unit limits
and boundary semantics.

The whole window grammar is native: `PARTITION BY`, `ORDER BY` with `NULLS FIRST`/`NULLS LAST`, `ROWS`/`RANGE`/`GROUPS` frames including `INTERVAL` offsets, the frame `EXCLUDE` clause, and model-level named windows. Do not wrap a window expression in `raw_sql()` — that costs cross-dialect mapping and blanks the column's lineage. Constructs a target does not support are rejected at compile time with `[unsupported_feature:<capability>]`; see the [window support table](../../.agents/skills/dogsled-model-spec-expressions/references/model-spec.md#per-dialect-support).

```yaml
# Trailing seven days, bounded by time rather than by row count
expr: "SUM(AMOUNT) OVER (ORDER BY ORDER_DATE RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW)"
```

`INTERVAL <n> <unit>` is a literal usable anywhere an expression is. Both `INTERVAL 7 DAY` and `INTERVAL '7' DAY` parse, and each target gets the spelling it expects.

When the parser cannot handle an expression, it falls back to raw SQL passthrough. Use `raw_sql(...)` to explicitly opt into passthrough. A function with no catalog entry does not need it — an unrecognised function passes through as a function call — so this is for dialect-specific operators and syntax the DSL has no form for:

```yaml
# A dialect-specific operator
expr: "raw_sql(payload ->> 'id')"
```

Declare a named window once and reference it by name; targets with no `WINDOW` clause get it inlined at each use site:

```yaml
windows:
  - name: by_customer
    partition_by: [CUSTOMER_ID]
    order_by:
      - column: ORDER_DATE
        direction: asc
        nulls: last
    frame: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
columns:
  - name: running_total
    expr: SUM(AMOUNT) OVER by_customer
```

> **QUALIFY** is a query-level clause, not a column expression. Use the model-level `qualify:` field instead:
>
> ```yaml
> qualify: 'ROW_NUMBER() OVER (PARTITION BY USER_ID ORDER BY CREATED_AT DESC) = 1'
> ```

> **Do not use `raw_sql()` for LATERAL FLATTEN, UNNEST, EXPLODE, or JSON_TABLE.** These are FROM-clause constructs, not column expressions. Use the [`flatten_json`](#flatten-json) feature instead.

### Flatten JSON

The `flatten_json` field expands a JSON array column into multiple rows using dialect-appropriate LATERAL/UNNEST syntax. This is the correct way to handle LATERAL FLATTEN — it cannot be expressed as a column expression.

#### Basic flatten

```yaml
spec_version: '0.2'
name: stg_events
type: model
description: Events with flattened payload
grain: event_id
source:
  ref: ecom.raw_events
flatten_json:
  column: PAYLOAD
columns:
  - name: event_id
    expr: ID
  - name: item_value
    expr: 'raw_sql(FLATTENED.VALUE::STRING)'
materialization:
  type: view
```

#### Flatten with path

Drill into a nested JSON path before flattening:

```yaml
flatten_json:
  column: JSON
  path: infrastructure.databricks
  alias: f
columns:
  - name: platform
    expr: 'raw_sql(F.VALUE:databricks_cloud_platform::STRING)'
```

#### Outer flatten (LEFT JOIN semantics)

Use `outer: true` to preserve parent rows when the JSON array is empty or NULL (LEFT JOIN semantics instead of INNER):

```yaml
flatten_json:
  column: PAYLOAD
  path: items
  outer: true
```

Supported on Snowflake (`OUTER => TRUE`), BigQuery (`LEFT JOIN UNNEST`), Postgres (`LEFT JOIN LATERAL`), and Databricks (`EXPLODE_OUTER`). DuckDB and MySQL do not support outer flattens and will throw an error.

#### Flatten fields

| Field    | Required | Description                                                    |
| -------- | -------- | -------------------------------------------------------------- |
| `column` | Yes      | Source column containing the JSON array                        |
| `path`   | No       | Dot-separated path into the JSON (e.g. `data.items`)           |
| `alias`  | No       | Alias for the flatten output (default: `flattened`)            |
| `outer`  | No       | Use LEFT JOIN semantics to keep parent rows (default: `false`) |

#### Dialect-specific output

| Dialect    | Generated SQL                                                            |
| ---------- | ------------------------------------------------------------------------ |
| Snowflake  | `, LATERAL FLATTEN(INPUT => T0.COL, PATH => 'items') AS FLATTENED`       |
| BigQuery   | `, UNNEST(JSON_EXTRACT_ARRAY(T0.col, '$.items')) AS flattened`           |
| Postgres   | `, json_array_elements(t0.col -> 'items') AS flattened`                  |
| Databricks | `LATERAL VIEW EXPLODE(T0.col) AS flattened`                              |
| MySQL      | `, JSON_TABLE(T0.col, '$[*]' COLUMNS(value JSON PATH '$')) AS flattened` |
| DuckDB     | `, UNNEST(t0.col) AS flattened`                                          |

#### Referencing flatten output in columns

Flatten output is accessed via dialect-specific JSON accessors. Use `raw_sql()` in column expressions:

```yaml
# Snowflake: semi-structured access with type cast
expr: 'raw_sql(FLATTENED.VALUE:workspace:id::STRING)'

# BigQuery
expr: 'raw_sql(JSON_VALUE(flattened))'

# Postgres
expr: "raw_sql(flattened ->> 'name')"
```

### Filtering on window results (`qualify`, `dedupe`)

`qualify` filters on window function results, after `WHERE` and `GROUP BY` but
before `ORDER BY` and `LIMIT`. `dedupe` is the common case stated directly, and
compiles to `QUALIFY ROW_NUMBER() ... = 1`.

```yaml
dedupe:
  keys: [ORDER_ID]
  strategy: keep_last
  order_by:
    - column: UPDATED_AT
      direction: asc
      nulls: last
```

Snowflake, BigQuery, Databricks, Redshift and DuckDB have the clause and get it
verbatim. Postgres and MySQL do not, so the predicate's window expressions are
hoisted into the SELECT list and filtered from a wrapping subquery, which makes
both operators work there rather than failing to compile.

The window expression stays in the original SELECT, so it still reads columns the
model does not project: ordering a dedupe by a timestamp you do not output works
the same on every target. One restriction does come with the rewrite. It adds a
helper column, and neither target has a `SELECT * EXCEPT` to remove it again, so
`include_all_columns` together with `qualify` or `dedupe` is refused there. List
the columns explicitly.

### Recursion

Some transformations are fixpoints: a hierarchy walk, a reachability closure, a
cycle audit. SQL expresses these with `WITH RECURSIVE`, and Model Spec expresses them
with two operators rather than a raw SQL body, so the output schema stays
declared, column lineage still resolves, and the same YAML compiles for every
target.

Recursion lives inside one model. `prior` names the previous iteration, which is
not a model, so the model DAG stays acyclic and a recursive model is still an
ordinary node with ordinary upstream refs.

#### hierarchy

Most recursive SQL walks a parent/child edge. `hierarchy` says that directly:

```yaml
spec_version: '0.2'
name: company_tree
type: model
description: Corporate hierarchy walked from the ultimate parents.
grain: company_id
source:
  ref: enrichment_vendor.companies
columns:
  - { name: company_id, expr: company_id }
  - { name: company_name, expr: name }
hierarchy:
  parent_key: parent_id
  child_key: company_id
  max_depth: 20
  seed: roots
  emit:
    root: root_id
    depth: depth
    path: id_path
materialization:
  type: table
```

Each declared column travels with the row it belongs to. `emit` adds the walk's
own facts under names you choose: the row the walk started from, how many hops
in it is, and the delimited chain of keys that got there.

**Seeding decides what you can find.** `seed: roots` starts at rows with no
parent, which is what an ordinary hierarchy wants. A cycle has no parentless
row, so a root-seeded walk never reaches an isolated one and reports only the
entry row of a reachable one. A cycle audit therefore needs `seed: all_nodes`,
which starts a walk at every row and costs proportionally more:

```yaml
hierarchy:
  parent_key: parent_id
  child_key: company_id
  max_depth: 20
  seed: all_nodes
  emit: { path: id_path, cycle: is_cycle }
```

Cycle detection carries the visited keys as delimited text and flags the row
that revisits a key. Both sides of every key are delimited, so `/5/` cannot
match inside `/51/`. Keys must not contain the delimiter; change it with
`path_delimiter` if `/` occurs in yours.

#### recurse

`hierarchy` compiles to `recurse`, the general bounded fixpoint, the same way
`dedupe` compiles to `QUALIFY ROW_NUMBER()`. Reach for it when the step is not a
parent/child walk — accumulating a running value down a chain, or expanding a
graph over an edge table:

```yaml
columns:
  - { name: company_id, expr: company_id }
  - { name: level, expr: '0' }
where: parent_id IS NULL
recurse:
  max_depth: 20
  step:
    source:
      join_on: source.parent_id = prior.company_id
    columns:
      - { name: company_id, expr: company_id }
      - { name: level, expr: prior.level + 1 }
```

The model's own clauses are the anchor that seeds the walk: `columns` is the
output schema and `where` filters the seed rows. The step names an expression
for every one of those columns, so both halves of the union line up.

In a step expression `prior.` reads the previous iteration and an unqualified
column reads the row being joined in, which is why a step column can often be
the same expression as the anchor's. `step.source.ref` defaults to the model's
own source; naming a different one turns it into an ordinary dependency edge.

#### Rules

- `max_depth` is required. BigQuery aborts a recursive CTE at 500 iterations and
  asks for an explicit guard, an unbounded walk over a cyclic graph does not
  terminate, and a future dataframe backend can only run the step as a bounded
  loop. It is a real predicate in the emitted SQL, not a hint.
- Materialization is `view` or `table`. Ephemeral is excluded because a folded
  CTE cannot carry `WITH RECURSIVE` into every dialect, and incremental because
  a fixpoint over changed rows has no defined semantics yet.
- Clauses that reshape the FROM clause or run after aggregation — `group_by`,
  `having`, `qualify`, `dedupe`, `distinct`, `pivot`, `unpivot`, `union`,
  `flatten_json`, `derived_columns` — belong in a downstream model that reads
  the closure. `order_by`, `limit` and `offset` apply to the closure and are
  allowed.
- The anchor and the step are combined with `UNION ALL`, not `UNION`: Snowflake
  rejects the distinct form between the two clauses. Termination comes from the
  depth bound and the cycle guard.
- The `__bms_` prefix is reserved for columns the compiler generates. A declared
  column, emitted name, named window or derived column in that namespace is
  rejected, because it would otherwise become a duplicate alias.

#### Dialect support

| Target     | `WITH RECURSIVE`                     |
| ---------- | ------------------------------------ |
| Snowflake  | yes                                  |
| BigQuery   | yes, 500-iteration cap               |
| Postgres   | yes                                  |
| Redshift   | yes                                  |
| DuckDB     | yes                                  |
| MySQL      | yes                                  |
| Databricks | rejected at compile time — see below |

Databricks gained recursive CTEs in DBSQL 2025.20 and Runtime 17.0, still in
preview, and the compiler cannot see a connection's runtime version. That target
fails closed with `[unsupported_feature:recursiveCte]` rather than emitting SQL
an older workspace rejects.

### Materializations

```yaml
# View (default) — lightweight, always fresh
materialization:
  type: view

# Table — full refresh on every run
materialization:
  type: table

# Incremental merge — upsert new/changed rows
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  incremental_filter: "created_at > DATEADD(day, -3, CURRENT_DATE)"

# Ephemeral — inlined as CTE, no DDL emitted
materialization:
  type: ephemeral

# Snapshot — SCD Type 2 historical tracking
materialization:
  type: snapshot
  unique_key: customer_id
  tracked_columns: [status, email, tier]

# Dynamic table (Snowflake) — warehouse-managed always-fresh output
materialization:
  type: dynamic_table
  target_lag: '1 hour'
  warehouse: TRANSFORMING_WH

# Materialized view (Snowflake / BigQuery / Postgres / Databricks / Redshift)
materialization:
  type: materialized_view
  max_staleness: '1 hour' # BigQuery only — 30 min to 3 day range
```

See `docs/materializations-reference.md` for the dialect capability matrix, transition rules, `on_schema_change` semantics, hooks, and snapshot SCD-2 details.

### DAG Resolution

Models reference other models via `source.ref` and `joins[].ref`. The compiler builds a directed acyclic graph, topologically sorts it, and compiles in dependency order. Circular references are rejected.

```sh
dogsled model lineage              # View the full dependency graph
dogsled model lineage fct_orders   # View subgraph for a specific model
dogsled model lineage --json       # Emit model + column lineage JSON for agents
dogsled model lineage --yaml       # Emit the same envelope as YAML for agent review notes
dogsled model lineage --column fct_orders.ORDER_ID --json
```

## Entity Resolution

Entity resolution identifies and merges duplicate records across sources. You define a resolution pipeline in YAML, Model Spec compiles it to warehouse SQL, and the unified CLI runs a composable workflow:

```text
validate → compile/run → review export/apply → cluster
```

See [`docs/reference/advanced/entity-graph-authoring-guide.md`](../../docs/reference/advanced/entity-graph-authoring-guide.md) for the current operator workflow, agent-task guidance, and runner requirements. Proposed commands such as `entity-graph quickstart` or `entity-graph scaffold` are roadmap items until they are registered in the CLI.

### When to use it

- Merge accounts or companies across CRM, ecommerce, and enrichment systems
- Deduplicate provider data before downstream modeling
- Produce a stable crosswalk from source-system IDs to unified entity IDs

### Best walkthrough

Start with the repo example:

```text
packages/model-spec/examples/entity-graph-b2b-company-master/
```

It models a wholesale company master across Salesforce accounts, Shopify B2B companies, and Enrichment vendor.

### Quick Start

#### 1. Define source specs

Create standard source specs for each input table in `sources/<connection>/`.

#### 2. Create a resolution spec in `entity-graph/`

```yaml
# entity-graph/company_resolution.yml
spec_version: '0.2'
name: company_resolution
type: resolution
description: Resolve company entities across internal and provider sources.

inputs:
  - ref: revops.salesforce_accounts
    role: internal
    trust_tier: gold
    id_fields: [salesforce_account_id]
  - ref: marketing.enrichment_vendor_companies
    role: provider
    trust_tier: bronze
    id_fields: [enrichment_vendor_company_id]

standardize:
  - field: company_name
    transforms: [lowercase, strip_legal_suffixes, collapse_whitespace]
  - field: domain
    transforms: [lowercase, strip_www, strip_protocol]

blocking:
  rules:
    - name: exact_domain
      key: standardized_domain
    - name: name_prefix
      key: 'LEFT(standardized_company_name, 6)'

deterministic_rules:
  - name: duns_match
    conditions:
      - field: duns_number
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: standardized_company_name
      algorithm: jaro_winkler
      weight: 0.45
    - field: standardized_domain
      algorithm: exact
      weight: 0.25
    - field: standardized_phone
      algorithm: exact
      weight: 0.15

thresholds:
  auto_merge: 0.93
  review: 0.6
  auto_reject: 0.6

entity_id_policy:
  strategy: stable
  new_id: component_id
  merge: oldest_entity_id
  split: preserve_anchor

outputs:
  target_schema: ENTITY_GRAPH
```

#### 3. Validate and compile

```sh
dogsled entity-graph resolve validate company
dogsled entity-graph resolve validate company --json
dogsled entity-graph resolve compile company -o ./sql
dogsled entity-graph resolve compile company --json
```

#### 4. Run stages 1-4

```sh
# Show the execution plan and emitted SQL
dogsled entity-graph resolve run company --dry-run

# Execute against the warehouse
dogsled entity-graph resolve run company --runner ./runner.js

# Emit a machine-readable execution summary
dogsled entity-graph resolve run company --runner ./runner.js --json
```

`resolve run` builds:

- `company__standardized`
- `company__candidate_pairs`
- `company__pair_scores`
- `company__review_queue`

#### 5. Export the review queue

```sh
# With a query-capable runner, write real CSV
dogsled entity-graph review export company --format csv --runner ./runner.js --output ./review/company_queue.csv

# Without --runner, emit the SQL query you should run in the warehouse
dogsled entity-graph review export company --format csv

# For agents, emit structured JSON instead of CSV/SQL stdout
dogsled entity-graph review export company --runner ./runner.js --json
```

#### 6. Apply decisions and cluster

```sh
dogsled entity-graph review apply --input ./review/company_queue.csv --entity company --runner ./runner.js
dogsled entity-graph resolve cluster company --runner ./runner.js
dogsled entity-graph resolve cluster company --runner ./runner.js --json
```

### Resolution Spec Fields

| Field                   | Required | Description                                                                                                                           |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `spec_version`          | Yes      | Must be `"0.2"`                                                                                                                       |
| `name`                  | Yes      | Resolution identifier, usually `{entity}_resolution`                                                                                  |
| `type`                  | Yes      | Must be `resolution`                                                                                                                  |
| `description`           | Yes      | Human-readable summary                                                                                                                |
| `inputs`                | Yes      | Input sources with `ref` and optional metadata                                                                                        |
| `standardize`           | No       | Ordered field transforms                                                                                                              |
| `blocking`              | No       | Candidate-pair generation rules. Omit for an unbounded full cross join, or set `rules: []` with `candidate_limit` to cap the fallback |
| `deterministic_rules`   | No       | Exact-match auto-merge rules                                                                                                          |
| `scoring`               | No       | Weighted fuzzy matching features                                                                                                      |
| `thresholds`            | Yes      | Score routing bands                                                                                                                   |
| `agent_policy`          | No       | Optional LLM-review settings                                                                                                          |
| `entity_id_policy`      | No       | Stable serving-ID policy. Defaults to `stable` with component IDs for first assignment, oldest-ID merge survival, and anchor splits   |
| `pair_count_warn_limit` | No       | Warn when candidate-pair generation exceeds this count                                                                                |
| `outputs`               | No       | Overrides like `target_schema`                                                                                                        |

To cap the no-blocking fallback, use `blocking` with an empty `rules` array and a `candidate_limit`, for example `blocking: { rules: [], candidate_limit: 5000 }`.

At least one of `deterministic_rules` or `scoring` is required.

### Thresholds

```text
auto_merge > review >= auto_reject
```

Pairs at or above `auto_merge` are merged automatically. Pairs between `review` and `auto_merge` are routed into `__review_queue`.

### Output Tables

The main tables are named from the derived entity name, not the full spec name. `company_resolution` therefore creates tables like `company__pair_scores`, not `company_resolution__pair_scores`.

| Table                    | DDL strategy         | Purpose                                                    |
| ------------------------ | -------------------- | ---------------------------------------------------------- |
| `__standardized`         | create or replace    | Normalized input rows                                      |
| `__candidate_pairs`      | create or replace    | Candidate pairs after blocking                             |
| `__pair_scores`          | create or replace    | Deterministic and fuzzy pair scores                        |
| `__review_queue`         | create or replace    | Ambiguous pairs awaiting review                            |
| `__review_decisions`     | create if not exists | Append-only decision log                                   |
| `__components`           | create or replace    | Current connected-component topology                       |
| `__entity_id_events`     | create if not exists | Append-only stable-ID assignment events                    |
| `__entity_id_record_map` | create if not exists | Latest-ever record to stable entity map                    |
| `__entity_id_current`    | create if not exists | Current active record membership                           |
| `__entity_id_aliases`    | create if not exists | Retired IDs that resolve to active IDs                     |
| `__clusters`             | create or replace    | Stable entity assignments; `cluster_id` equals `entity_id` |
| `__crosswalks`           | create or replace    | Source record to stable entity mapping                     |
| `__golden_record`        | create if not exists | Survivorship: best attribute per cluster                   |
| `__golden_history`       | create if not exists | Attribute change history                                   |
| `__not_match_edges`      | create if not exists | Explicit rejections that block rematches                   |
| `__survivorship_audit`   | create if not exists | Field-level provenance audit trail                         |
| `__split_events`         | create if not exists | Reserved for future cluster split events                   |

### Standardize Functions

Each `standardize` entry specifies a `field` (resolution field name) and a `transforms` list. Transforms are applied in the listed order. The output column is named `standardized_<field>`.

```yaml
standardize:
  - field: company_name
    transforms: [strip_legal_suffixes, lowercase, collapse_whitespace]
  - field: domain
    transforms: [strip_www, lowercase]
  - field: phone
    transforms: [digits_only, strip_country_code]
```

| Transform                | Effect                                                         | Model Spec function equivalent                |
| ------------------------ | -------------------------------------------------------------- | --------------------------------------------- |
| `lowercase`              | Lowercase all characters                                       | `lower(col)`                                  |
| `uppercase`              | Uppercase all characters                                       | `upper(col)`                                  |
| `trim`                   | Remove leading/trailing whitespace                             | `trim(col)`                                   |
| `collapse_whitespace`    | Collapse runs of whitespace into one space                     | `collapse_whitespace(col)`                    |
| `nullif_empty`           | Convert blank strings to `NULL`                                | `nullif_empty(col)`                           |
| `normalize_email`        | Trim and lowercase emails                                      | `normalize_email(col)`                        |
| `extract_email_domain`   | Extract the domain from an email address                       | `extract_email_domain(col)`                   |
| `strip_email_subaddress` | Remove plus-addressing                                         | `strip_email_subaddress(col)`                 |
| `strip_accents`          | Remove common accents and diacritics                           | `strip_accents(col)`                          |
| `strip_legal_suffixes`   | Remove terminal Inc., LLC, Ltd., Corp., Co., etc.              | `strip_legal_suffixes(col)`                   |
| `strip_trading_as`       | Remove d/b/a, dba, trading as, and t/a aliases                 | `strip_trading_as(col)`                       |
| `normalize_company`      | Company-name convenience cleanup                               | `normalize_company(col)`                      |
| `strip_www`              | Remove `http://`, `https://`, and `www.` prefixes              | `strip_www(col)`                              |
| `strip_protocol`         | Remove `http://` or `https://` prefixes                        | `strip_www(col)` (same function handles both) |
| `extract_domain`         | Extract host/domain from full URLs                             | `extract_domain(col)`                         |
| `digits_only`            | Keep only `0–9` digits                                         | `digits_only(col)`                            |
| `strip_country_code`     | Remove leading US/Canada `1` from 11-digit phone strings       | `strip_country_code(col)`                     |
| `strip_phone_extension`  | Remove extension suffixes from phone strings                   | `strip_phone_extension(col)`                  |
| `normalize_phone`        | Phone convenience cleanup                                      | `normalize_phone(col)`                        |
| `normalize_state`        | Normalize US state names and abbreviations to two-letter codes | `normalize_state(col)`                        |
| `remove_punctuation`     | Remove punctuation, leaving letters, digits, and spaces        | `remove_punctuation(col)`                     |
| `fingerprint`            | Build a sorted/deduped token key for matching                  | `fingerprint(col)`                            |
| `parse_number`           | Parse formatted currency/number strings                        | `parse_number(col)`                           |

> **`parse_dates` is not a valid standardize transform.** It is a profiler-only suggestion name. Use `parse_date(col, 'iso8601')` in a Model Spec staging model column `expr` instead, then reference the cleaned column in the resolution field.

**Recommended transform ordering** for common field types:

- Company name: `[strip_legal_suffixes, lowercase, collapse_whitespace]`
- Domain: `[strip_www, strip_protocol, lowercase]`
- Phone: `[digits_only, strip_country_code]`
- Email: `[lowercase, trim]`
- State: `[uppercase]` (or `normalize_state` once implemented)

Transforms are applied in order.

### Fuzzy Algorithms

| Algorithm          | Best for                   |
| ------------------ | -------------------------- |
| `exact`            | IDs, domains, hard keys    |
| `jaro_winkler`     | Company or person names    |
| `edit_distance`    | Short strings with typos   |
| `soundex`          | Phonetic name matching     |
| `numeric_distance` | Numeric proximity          |
| `date_proximity`   | Dates within a known range |

Fuzzy helpers use native-safe mappings only. Unsupported functions fail during compilation instead of silently passing through raw SQL. Today `soundex` is the broadest portable phonetic helper; `metaphone` is limited to PostgreSQL-family targets with the required extension support, and MySQL/Redshift continue to reject unsupported similarity helpers such as `jaro_winkler` or `edit_distance`.

### Review Workflow

- `review export` with `--runner` plus `query()` gives you real CSV/JSON/YAML output.
- `review export` without `--runner` prints the SQL query you should run manually.
- `review export --json` returns a machine-readable envelope with row counts, output path, and in-memory rows when materialized to stdout.
- `review apply` accepts either `company` or `company_resolution` and writes to the normalized entity tables.
- `review apply --json` returns counts plus per-statement execution status.
- `resolve cluster` turns merge decisions into `__clusters` and `__crosswalks`.

### Seed Data

```sh
dogsled model seed validate
dogsled model seed validate --json
dogsled model seed load
dogsled model seed load --runner ./runner.js
dogsled model seed diff --runner ./runner.js --json
```

Without `--runner`, `seed load` prints compiled SQL. With `--runner`, it executes it.
The runner receives one statement per call: the `CREATE TABLE`, then one
`INSERT` per 1000-row batch. This suits drivers that reject multi-statement
scripts, such as BigQuery and Snowflake.

Seed column types map to each `--dialect`:

| Seed type                   | BigQuery    | Snowflake        | Postgres           | DuckDB             | MySQL                   | Databricks       | ClickHouse                 |
| --------------------------- | ----------- | ---------------- | ------------------ | ------------------ | ----------------------- | ---------------- | -------------------------- |
| `STRING`                    | `STRING`    | `VARCHAR`        | `VARCHAR(4096)`    | `VARCHAR`          | `VARCHAR(4096)`         | `STRING`         | `Nullable(String)`         |
| `VARCHAR`, `TEXT`           | `STRING`    | as written       | as written         | as written         | `VARCHAR(4096)`, `TEXT` | `STRING`         | `Nullable(String)`         |
| `INTEGER`, `INT`            | `INT64`     | `INTEGER`        | `INTEGER`          | `INTEGER`          | `INTEGER`               | `INTEGER`        | `Nullable(Int64)`          |
| `FLOAT`, `DOUBLE`, `NUMBER` | `FLOAT64`   | `FLOAT`          | `DOUBLE PRECISION` | `DOUBLE PRECISION` | `DOUBLE`                | `DOUBLE`         | `Nullable(Float64)`        |
| `DECIMAL`                   | `NUMERIC`   | `DECIMAL(38, 9)` | `DECIMAL`          | `DECIMAL(38, 9)`   | `DECIMAL(38, 9)`        | `DECIMAL(38, 9)` | `Nullable(Decimal(38, 9))` |
| `BOOLEAN`, `BOOL`           | `BOOL`      | `BOOLEAN`        | `BOOLEAN`          | `BOOLEAN`          | `BOOLEAN`               | `BOOLEAN`        | `Nullable(Bool)`           |
| `DATE`                      | `DATE`      | `DATE`           | `DATE`             | `DATE`             | `DATE`                  | `DATE`           | `Nullable(Date)`           |
| `TIMESTAMP`                 | `TIMESTAMP` | `TIMESTAMP`      | `TIMESTAMP`        | `TIMESTAMP`        | `DATETIME`              | `TIMESTAMP`      | `Nullable(DateTime64(3))`  |

A bare `DECIMAL` gets scale 9 where the dialect's default would round
fractions (scale 0 on Snowflake, MySQL and Databricks; 3 on DuckDB). `NUMBER`
is a float, as in seed validation. Snowflake's bare `NUMBER` has scale 0, so it
becomes `FLOAT`. For exact values, use `DECIMAL` or `NUMBER(p, s)`.

Common aliases and parameterized types are also accepted. On BigQuery they map
to its types, for example `BIGINT` to `INT64`, `NUMERIC(10, 2)` stays as it is,
and `VARCHAR(50)` becomes `STRING(50)`. On other dialects they are kept as
written. The aliases are:

- text: `CHAR`, `CHARACTER`, `NVARCHAR`;
- integer: `BIGINT`, `SMALLINT`, `TINYINT`, `INT64`;
- float: `REAL`, `FLOAT64`, `DOUBLE PRECISION`;
- exact: `NUMERIC(p, s)`, `NUMBER(p, s)`;
- temporal: `DATETIME`, `TIMESTAMP_NTZ`, `TIME`.

Any other type name fails `seed validate` and `seed load` with the seed, column
and type named.

Values are written as literals of the column type. Integers, floats and
booleans are written bare. Dates, timestamps and decimals use `CAST('…' AS
type)`, and a value that does not parse is cast as quoted text, so the warehouse
rejects it. A blank cell is `NULL`. Each `INSERT` holds up to 1000 rows and
about 512 KB of SQL.

`seed diff` compares values by type: `1.50` matches `1.5`, `yes` matches
`true`, and a timestamp matches the same instant in the warehouse's format.

If a load fails partway, the seed table may hold only some rows. Fix the error
and rerun `seed load`, which rebuilds the table (`on_conflict: replace`) or
inserts only missing keys (`on_conflict: skip`).

All resolve/review/seed subcommands that perform operator workflows also accept `--json` for machine-readable summaries.

### Survivorship

After clustering, survivorship rules choose the winning attribute value per cluster and produce a golden record. Define a survivorship spec in `entity-graph/`:

```yaml
# entity-graph/company_survivorship.yml
spec_version: '0.2'
name: company_survivorship
type: survivorship
description: Golden-record rules for company.
resolution_ref: company_resolution

entity_id_policy:
  strategy: stable_uuid

default_timestamp_field: updated_at
```

```sh
dogsled entity-graph survivorship validate [name...] [--json]
dogsled entity-graph survivorship compile [name...] [-o dir] [--json]
dogsled entity-graph survivorship run [name...] [--runner ./r.js] [--json]
dogsled entity-graph survivorship inspect <name> [--cluster-id id] [--runner ./r.js] [--json]
dogsled entity-graph survivorship init <entity>
```

`survivorship run` populates `__golden_record`, `__golden_history`, and `__survivorship_audit`. Use `survivorship inspect` to verify output for a specific cluster.

### Truthsets

Truthsets are labeled pair CSVs used to measure and tune threshold quality. Define a truthset spec in `entity-graph/`:

```yaml
# entity-graph/company_truthset.yml
spec_version: '0.2'
name: company_truthset
type: truthset
description: Regression labels for company matching.
resolution_ref: company_resolution

labels:
  format: csv
  path: data/company_truthset.csv

targets:
  min_auto_merge_precision: 0.98
```

The CSV requires `pair_id,label` columns with labels in `{merge, not_match}`.

```sh
dogsled entity-graph truthset validate [name...] [--json]
dogsled entity-graph truthset score [name...] --runner ./r.js [--json]
dogsled entity-graph truthset tune [name...] --runner ./r.js [--json]
dogsled entity-graph truthset init <entity>
```

`truthset score` reports precision and recall at the current thresholds. `truthset tune` recommends new thresholds from labeled scores — treat recommendations as inputs to a reviewed spec change, not an automatic rewrite.

### Agent Tasks

Agent commands are bounded one-shot orchestration wrappers for coding agents and unattended routines. They wrap the lower-level `resolve`, `review`, `survivorship`, and `truthset` primitives. Start from `agent triage` to get one recommended next action per entity, default `agent review-batch` to `--mode propose`, and only move to `--mode apply` when policy allows writes. All agent commands accept `--profile <path>` to read entity names, mode, and output paths from a task profile YAML.

See the [agent CLI reference](#agent) for the full command list.

## CLI Reference

### compile

Generate SQL from model specs. Dialect and target schema come from the active integration file.

```sh
dogsled model compile --integration duckdb                                 # All models to stdout
dogsled model compile stg_customers --integration snowflake                # Single model
dogsled model compile -o target/ --integration bigquery                    # Write each model to target/<integration>/MODEL.sql
dogsled model compile -o target/ --include-metadata --integration duckdb   # Also emit metrics.json / relationships.json / vqs.json
dogsled model compile --strict --integration duckdb                        # Reject implicit raw_sql fallbacks
```

### run

Compile and execute models against a warehouse. `dogsled model run` constructs the runner from the active integration via `@bobsled-inc/connections` — no hand-written runner module needed.

```sh
dogsled model run --integration duckdb --dry-run                # Show execution plan without running
dogsled model run --integration snowflake --secrets env.yml     # Execute — all 5 dialects ship real built-in runners
dogsled model run --secrets env.yml                             # Fan out — run every declared integration in sequence
dogsled model run --integration duckdb --full-refresh           # Force full table rebuild
```

Hosts that need custom runner construction (e.g. the host application for `sledhouse_oidc`) register via `@bobsled-inc/connections`'s `CustomRunnerRegistry`.

### test

Generate test SQL from model test definitions.

```sh
dogsled model test --integration duckdb                # All models
dogsled model test stg_orders --integration duckdb     # Single model
```

Define tests in your model spec:

```yaml
tests:
  - type: not_null
    column: customer_id
  - type: unique
    column: order_id
  - type: accepted_values
    column: status
    values: [pending, shipped, delivered]
  - type: custom
    sql: 'SELECT * FROM {name} WHERE amount < 0'
```

For the complete quality-gate contract surface, including field metadata, semantic checks, executable expectations, and clean specs, see [Data Tests And Contracts](../../docs/reference/advanced/data-tests-and-contracts.md).

### expect

Compile or execute model expectation sentinels. Expectations differ from `tests:` blocks: each expectation query returns a `violation_count`, and with `--runner` the command produces pass, warn, and fail statuses for agents and CI.

```sh
dogsled model expect run --integration duckdb                         # Compile all expectation SQL
dogsled model expect run --integration duckdb --model stg_customers   # Scope to one model
dogsled model expect run --integration duckdb --runner ./runner.js --json
```

Define expectations in your model spec:

```yaml
expect:
  - kind: primary_key
    columns: [customer_id]
  - kind: non_null
    column: email
  - kind: accepted_values
    column: status
    values: [active, inactive]
    severity: warn
  - kind: custom
    sql: |
      SELECT COUNT(*) AS violation_count
      FROM {model}
      WHERE lifetime_value < 0
```

Supported expectation kinds are `primary_key`, `non_null`, `unique`, `in_range`, `regex`, `schema_contains`, `row_count_between`, `accepted_values`, `expression`, and `custom`. Custom expectations must select a column aliased as `violation_count`.

### validate

Check specs + metric / relationship / VQ cross-references without compiling.

```sh
dogsled model validate --integration duckdb                # All models + entities (strict by default)
dogsled model validate --no-strict --integration duckdb    # Allow raw_sql fallbacks
dogsled model validate --integration duckdb --semantic-check=strict
```

### lineage

Display the model dependency graph and column-level upstream references.

```sh
dogsled model lineage --integration duckdb                 # Full graph
dogsled model lineage fct_orders --integration duckdb      # Subgraph
dogsled model lineage --integration duckdb --json          # JSON envelope with columnLineage
dogsled model lineage --integration duckdb --yaml          # YAML envelope with columnLineage
dogsled model lineage --integration duckdb --column fct_orders.ORDER_ID --json
dogsled model lineage --integration duckdb --column fct_orders.ORDER_ID --yaml
```

Column lineage traces parsed expressions, `include_all_columns` passthrough when source schemas are known, join predicates for joined-table outputs, and filter predicates that constrain row membership. Opaque boundaries such as `raw_sql`, subqueries, `flatten_json`, `pivot`, and `unpivot` are emitted with `isComplete=false` rather than guessed through. See [Model Spec Lineage Quick Start](./docs/lineage-quickstart.md) and the cross-project [Dogsled Lineage Guide](../../docs/reference/advanced/lineage-guide.md).

### profile

Profile a warehouse table, Model Spec source, or Model Spec model with confidence-scored inferences.

```sh
dogsled model profile ecom.raw_customers --integration ecom --json
dogsled model profile fct_orders --integration ecom --sample-size 1000 --json
dogsled model profile raw_customers --integration ecom --confidence-min 0.8
```

Emit only cleaning suggestions:

```sh
dogsled model profile suggest cleaning ecom.raw_customers --integration ecom --confidence-min 0.9 --json
```

Options:

| Option                      | Description                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--integration <handle>`    | Select one integration; required when the project has more than one.                                         |
| `--runner <path>`           | Use a custom module with `query(sql)` instead of constructing a runner from the integration.                 |
| `--secrets <path>`          | YAML secret overlay for integration runner construction.                                                     |
| `--sample-size <rows>`      | Rows to sample. Defaults to `500`; maximum is `100000`.                                                      |
| `--confidence-min <number>` | Filter inferences, candidates, and suggestions to a confidence from `0` to `1`.                              |
| `--json`                    | Emit a JSONL-compatible payload. Also auto-activates in CI, non-TTY output, or `DOGSLED_OUTPUT_FORMAT=json`. |
| `--quiet`                   | Suppress human status logs.                                                                                  |

Read [Model Profiler User Guide](docs/profiler-user-guide.md) for output shape, runner requirements, and limitations.

### init

Scaffold a new project with example files.

```sh
dogsled model init my-project
```

### resolve

Entity resolution pipeline commands.

```sh
dogsled entity-graph resolve init <entity>                                          # Scaffold a new resolution spec
dogsled entity-graph resolve validate [entity...] [--json]                          # Validate resolution specs
dogsled entity-graph resolve compile [entity...] [-o dir] [--json]                  # Compile to SQL
dogsled entity-graph resolve run [entity...] [--runner ./r.js] [--dry-run] [--json] # Run through threshold routing or print the plan
dogsled entity-graph resolve cluster [entity...] [--runner ./r.js] [--json]         # Cluster after review
dogsled entity-graph resolve report [entity...] [--json]                            # Spec summary
dogsled entity-graph resolve status [entity...] [--runner ./r.js] [--json]          # Row counts across runtime tables
dogsled entity-graph resolve estimate [entity...] [--runner ./r.js] [--json]        # Threshold-band volume estimates
dogsled entity-graph resolve inspect pair --entity <name> --pair-id <id> [--runner ./r.js] [--json]
dogsled entity-graph resolve inspect cluster --entity <name> --cluster-id <id> [--runner ./r.js] [--json]
```

### review

Review queue management for entity resolution.

```sh
dogsled entity-graph review export <entity...> [--format csv|json|yaml] [--template] [--all] [--limit n] [--runner ./r.js] [--json]
dogsled entity-graph review apply --input <file|"-"> --entity <name> [--batch-id id] [--runner ./r.js] [--json]
dogsled entity-graph review list <entity...> [--limit n] [--threshold-band review|agent_review|human_review] [--runner ./r.js] [--json]
dogsled entity-graph review show --entity <name> --pair-id <id> [--runner ./r.js] [--json]
dogsled entity-graph review decide --entity <name> --pair-id <id> --decision merge|not_match|defer [--runner ./r.js] [--json]
```

### seed

Reference data loading.

```sh
dogsled model seed validate [--json]               # Validate seed specs
dogsled model seed load [--runner ./r.js] [--json] # Load seed data or print SQL
dogsled model seed diff [--runner ./r.js] [--json]  # Compare warehouse state vs local CSV
```

### survivorship

Golden-record survivorship rules.

```sh
dogsled entity-graph survivorship init <entity>                                             # Scaffold a survivorship spec
dogsled entity-graph survivorship validate [name...] [--json]                               # Validate survivorship specs
dogsled entity-graph survivorship compile [name...] [-o dir] [--json]                       # Compile to SQL
dogsled entity-graph survivorship run [name...] [--runner ./r.js] [--json]                  # Run survivorship or print SQL
dogsled entity-graph survivorship inspect <name> [--cluster-id id] [--runner ./r.js] [--json] # Inspect golden record
```

### truthset

Threshold regression with labeled pairs.

```sh
dogsled entity-graph truthset init <entity>                                   # Scaffold a truthset spec and CSV
dogsled entity-graph truthset validate [name...] [--json]                     # Validate truthset specs
dogsled entity-graph truthset score [name...] --runner ./r.js [--json]        # Measure precision/recall
dogsled entity-graph truthset tune [name...] --runner ./r.js [--json]         # Recommend new thresholds
```

### agent

Agent-native Entity Graph task orchestration.

```sh
dogsled entity-graph agent triage [entity...] --runner ./r.js [--profile path] [--json]
dogsled entity-graph agent review-batch --entity <name> --runner ./r.js [--mode propose|apply] [--profile path] [--output-bundle path] [--json]
dogsled entity-graph agent survivorship-refresh [entity...] --runner ./r.js [--profile path] [--json]
dogsled entity-graph agent truthset-regress [entity...] --runner ./r.js [--profile path] [--json]
dogsled entity-graph agent init-profile <name> [--entity name] [--operation review_batch] [--mode propose|apply]
```

### Global Options

```text
--integration <handle>   Active integration (the integration file with this name; required when >1 declared)
-v, --verbose            Verbose output
-q, --quiet              Suppress non-error output
```

The legacy `--dialect` and `--schema` flags have been removed from the Model Spec CLI. Dialect, target schema, and target database now flow from the active integration file. Per-model `target_schema` / `target_database` overrides live on individual model YAMLs.

## Configuration

Create a `model-spec.yml` in your project root for optional settings. All fields are optional — warehouse dialect, schema, database, and credentials live entirely in the integration file. Sources, models, metrics, relationships, VQs, and integrations are found by their declared `type` anywhere in the project, so their directory keys are accepted but no longer limit where files live; `seeds_dir`, `entity_graph_dir`, and `targets_dir` still locate seeds, Entity Graph specs, and load targets. A `model-spec.yml` stored anywhere other than the project root declares `type: model_spec_config`:

```yaml
type: model_spec_config # Required only when the file is not the root model-spec.yml
sources_dir: sources # Where source specs live
models_dir: models # Where model specs live
seeds_dir: seeds # Where seed specs live
entity_graph_dir: entity-graph # Where entity graph specs live
integrations_dir: integrations # Where integration specs live
targets_dir: targets # Where load-target specs live (consumed by loader)
metrics_dir: metrics # First-class named measures
relationships_dir: relationships # Multi-column join descriptions
vqs_dir: vqs # Verified NLQ-to-SQL pairings
```

Top-level `dialect:` / `schema:` are removed and fail validation. Legacy `mdm_dir:` is still accepted as an alias for `entity_graph_dir:` so existing Model Spec project configs keep loading.

## Library API

Use the compiler programmatically in your own tools:

```ts
import {
  buildDag,
  buildSourceRegistry,
  buildModelRegistry,
  parseTransformSpecFromParsed,
  generateSql,
  collectYamlFiles,
} from '@bobsled-inc/model-spec';

const { registry } = buildSourceRegistry('./sources');
const modelFiles = collectYamlFiles('./models');
const { order } = buildDag(modelFiles);

const modelReg = buildModelRegistry(
  order.map((n) => n.name),
  'PUBLIC',
  'snowflake'
);

for (const node of order) {
  const { spec } = parseTransformSpecFromParsed(node.parsedSpec, registry, modelReg);
  const sql = generateSql(spec, 'PUBLIC', 'snowflake');
  console.log(sql);
}
```

### Dialect Introspection

Query supported compiler targets and their capabilities at runtime:

```ts
import {
  SUPPORTED_DIALECTS,
  CANONICAL_DIALECTS,
  resolveDialectProfile,
  supportsDialectCapability,
  supportsFuzzyAlgorithm,
  isSupportedDialect,
} from '@bobsled-inc/model-spec';

// All compiler targets (snowflake, bigquery, postgres, pgvector, redshift, ...)
console.log(SUPPORTED_DIALECTS);

// Inspect a target's profile
const profile = resolveDialectProfile('redshift');
console.log(profile.canonicalDialect); // 'postgres'
console.log(profile.capabilities.flattenJson); // false

// Capability queries
supportsDialectCapability('redshift', 'qualify'); // true
supportsFuzzyAlgorithm('redshift', 'jaro_winkler'); // false

// Validate user input
isSupportedDialect('redshift'); // true
isSupportedDialect('oracle'); // false
```

### Custom SQL Runner

For custom orchestration, resolve a runner directly from an integration via `@bobsled-inc/connections`:

```ts
import { executeSqlStatements } from '@bobsled-inc/model-spec';
import {
  loadIntegration,
  resolveRunner,
  EnvSecretResolver,
  interpolateSecrets,
} from '@bobsled-inc/connections';

const integration = await loadIntegration(process.cwd(), 'duckdb');
const secretResolver = new EnvSecretResolver();
const interpolated = await interpolateSecrets(integration, secretResolver);
const runnerModule = await resolveRunner(interpolated, { secretResolver });

const results = await executeSqlStatements(statements, runnerModule.run, {
  onInfo: (msg) => console.log(msg),
  onError: (msg) => console.error(msg),
});

await runnerModule.close?.();
```

Hosts can plug custom runners in via `CustomRunnerRegistry.register(sourceType, authType, factory)` before calling `resolveRunner(integration, { customRunners })`. The host application uses this to wire `sledhouse_oidc`.

### Metadata entities

```ts
import {
  loadMetadataRegistry,
  validateMetadataReferences,
} from '@bobsled-inc/model-spec';

const registry = await loadMetadataRegistry(process.cwd(), {
  metricsDir: 'metrics',
  relationshipsDir: 'relationships',
  vqsDir: 'vqs',
});

validateMetadataReferences(registry, {
  modelNames: new Set([...]),
  sourceKeys: new Set([...]),
  integrationHandles: new Set([...]),
});
```

## Dialects

| Dialect      | Quoting     | Case  | Example          |
| ------------ | ----------- | ----- | ---------------- |
| `snowflake`  | `"COL"`     | UPPER | `"ORDER_ID"`     |
| `bigquery`   | `` `col` `` | lower | `` `order_id` `` |
| `postgres`   | `"col"`     | lower | `"order_id"`     |
| `databricks` | `` `col` `` | lower | `` `order_id` `` |
| `mysql`      | `` `col` `` | lower | `` `order_id` `` |
| `duckdb`     | `"col"`     | lower | `"order_id"`     |

Function calls are automatically mapped across dialects (e.g., `DATEDIFF` on Snowflake becomes `DATE_DIFF` on BigQuery).

## Examples

See [Build models](../../docs/guides/build-models.md) for a step-by-step project with sources, staging models and a fact table.

See [`examples/entity-graph-b2b-company-master/`](./examples/entity-graph-b2b-company-master/) for a B2B company master across Salesforce, Shopify B2B, and Enrichment vendor demonstrating the full entity resolution, survivorship, and truthset workflow.

## Further Reading

- [Project files reference](../../docs/reference/project-files.md): every model, source and integration field
- [Materializations reference](./docs/materializations-reference.md)
- [Lineage Quick Start](./docs/lineage-quickstart.md) — model and column lineage commands for agents and reviewers

## License

Apache-2.0

## Agentic contracts

The [agentic contract guide](docs/agentic-contracts.md) documents the public
`@bobsled-inc/model-spec/agentic` schemas and callable executor interface.
The [execution state guide](docs/agentic-state.md) covers durable local checkpoints,
supplied stores and explicit start/resume calls. [Database publication](docs/agentic-publication.md) confirms atomic output and receipts. CLI
execution uses a supplied executor or the built-in TypeSafe classifier. Start with
the [user guide](../../docs/guides/agentic-models.md), then use the
[YAML reference](../../docs/reference/advanced/agentic-model-reference.md),
[operations guide](../../docs/reference/advanced/agentic-model-operations.md), or
[host integration guide](docs/agentic-hosts.md).

### Incremental agentic inputs

Declare a cursor on an agentic model input:

```yaml
sources:
  pairs:
    ref: candidate_pairs
    incremental:
      cursor_field: updated_at
```

The first batch reads all input rows. Later batches read rows whose cursor is
strictly greater than the last published batch's cursor. Dogsled freezes these
inputs and their maximum cursor values in the execution checkpoint. It advances
the shared cursor only after publication is confirmed. A successful input that
returns zero output rows still advances progress. Output metadata timestamps do
not control this cursor.

Use a non-null timestamp, date, integer, or number column. Timestamps returned by
hosts must be UTC ISO strings; fractional seconds are retained. Inputs that arrive
late with older or equal cursor values are not selected. Deletions require an
explicit input record. Cursor fields must belong to prepared inputs, not tool-only
sources. Each configured input is filtered independently; design grouped/reduce
inputs accordingly when a group requires unchanged context rows.

Storage follows the execution configuration:

- Local file checkpoints share one `agentic_cursors` index in `.dogsled/model-spec/run-state.json`.
- The default DuckDB publisher shares one `_dogsled_agentic_publication.cursors`
  table across models when no separate checkpoint store is supplied.
- A configured warehouse checkpoint store shares one `__dogsled_cursors` table in
  its system schema. PostgreSQL, Snowflake, BigQuery, and Databricks are supported.
  Databricks requires catalog-managed transactions, as for publication.
- Library hosts can supply `agentic.cursorStore`, or expose `cursors` on their
  checkpoint store. Dogsled does not silently use local cursors for a supplied store.

A cursor record belongs to a scope, model, and target and holds each input's
bookmark. It reserves the unfinished batch's run ID. Resume that ID to reuse saved work. A fresh start can take over an unpublished
batch only after exclusive acquisition and durable retirement of the old run.
Prepared or confirmed publication must be resumed first; see
[fresh-start recovery](docs/agentic-state.md#starting-fresh-after-a-failed-incremental-run). Changing input references or cursor
fields conflicts with existing progress; migrate/reset that progress explicitly.
`fullRefresh` does not reset agentic cursors and is rejected for incremental agentic
models.

Large backlogs are processed in batches. A run takes the oldest new rows that fit
in one batch (1,000 rows and 1 MiB), in cursor order, and leaves the rest for the
next run; the CLI then warns that more rows are waiting. The run saves this with
the batch, so a resumed run warns too. Rows that share the cursor
value at the cut are never split across batches. If more rows share one cursor value
than fit in a batch, the run fails and asks for a cursor with more distinct values.

Hosts receive `prepare(context).incremental` with `cursor_field` and optional
`after`. Apply the filter **before** the input row limit. Dogsled checks returned
rows again. Hosts that set `incrementalBatches` also receive `batch: true` and must
order rows by the cursor; other hosts keep failing when the backlog does not fit. Existing hosts remain valid for bounded inputs, but must implement
filter pushdown to process large upstream tables efficiently. Agentic input
cursors require durable publication; the experimental publication callback is
not supported.

## OSI import and export

Dogsled supports importing and exporting semantic models in the Open Semantic
Interchange (OSI) format. Use [OSI import and export](docs/ossie-interchange.md)
to convert between OSI documents and native source, model, metric, and relationship
YAML, and verified queries (with `0.2.0.dev0`). The guide covers the CLI and SDK, incomplete imports, DOGSLED extensions,
metadata preservation, export limitations, and migration from older raw OSI
project files.
