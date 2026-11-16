---
name: bobsled-model-spec
description: Define sources, models, joins, materializations, and use the Model
  Spec CLI. Use when writing YAML data model specs, configuring materialization
  strategies, or running compile/run/test/lineage commands.
---

# Model Spec — Data Model Reference

Compile YAML data model specs into warehouse SQL. Define sources, transformations, joins, and materializations declaratively.

> **CLI:** Use `bobsled model <command>`. The public CLI entry point is `bobsled`.

## Quick Reference

```bash
bobsled model compile --integration snowflake           # All models -> stdout (dialect derived from integration)
bobsled model compile stg_customers --integration duckdb  # Single model
bobsled model compile -o target/ --integration bigquery # Write to target/<integration>/MODEL.sql
bobsled model compile --strict --integration snowflake  # Reject implicit raw_sql fallbacks

bobsled model run --integration snowflake --secrets secrets.yml   # Execute via @bobsled-inc/connections resolveRunner
bobsled model run --integration duckdb --full-refresh             # Force table rebuild

bobsled model test --integration duckdb                 # Generate test SQL
bobsled model validate --integration duckdb             # Check specs + cross-refs (no compile)

bobsled model lineage --integration duckdb              # Full dependency graph
bobsled model lineage fct_orders --integration duckdb   # Subgraph from a model

bobsled model init my-project                           # Scaffold new project
```

`--integration <handle>` is always optional. Omit it to fan out over **every** declared integration — `compile`/`run`/`validate`/`test`/`lineage` each emit a per-integration block (or write under `target/<handle>/`) and skip integrations that no model references with a warning. Pass `--integration <handle>` to narrow the run to that one integration. The legacy `--dialect` / `--schema` / `--runner` flags are **removed** — dialect and target schema now come from `integrations/<handle>.yml`, and the SQL runner is constructed automatically from the integration via `@bobsled-inc/connections`.

## Multi-integration projects

Each source pins itself to its owning warehouse via `connection: <handle>`, where the handle matches an `integrations/<handle>.yml` file. A model that joins or unions sources from two different handles is rejected at validation (`CommandError(2)`) — UNLESS the model declares `publish: <handle>` (see "Cross-warehouse publishing" below). `bobsled model run` keeps per-integration state under `<handle>.<model>` keys in `.bobsled/model-spec/run-state.json`; legacy single-handle keys migrate automatically, while leftover unscoped keys in multi-integration projects clear state with a warning and behave as `--full-refresh` on the next run.

## Cross-warehouse publishing (`publish:`)

A model that joins sources across multiple integrations can publish the materialized result to one warehouse by setting `publish: <handle>`:

```yaml
spec_version: '0.2'
name: customer_event_revenue
type: model
publish:
  target: databricks # which integration owns the destination table
  target_schema: analytics
source:
  ref: postgres.events
joins:
  - ref: snowflake.accounts
    type: left
    on: postgres.events.account_id = snowflake.accounts.account_id
columns:
  - { name: event_id, expr: postgres.events.event_id, type: integer, primary_key: true }
  - { name: revenue, expr: postgres.events.amount, type: number }
materialization:
  type: table # publish also supports incremental and snapshot
```

Run with:

```bash
bobsled model run customer_event_revenue --secrets secrets.yml
bobsled model run customer_event_revenue --dry-run         # show plan, don't stage
bobsled model run customer_event_revenue --full-refresh    # clear run state before rewriting
```

**Environment flags**:

- `BOBSLED_CORE_XWH_STAGING_FORMAT=parquet` — streaming fallback stages source rows as Parquet (preserves Decimal/Timestamp/Binary fidelity that JSONL loses). Default `jsonl`.
- `BOBSLED_CORE_XWH_SOURCE_TIMEOUT_S=14400` — abort source streaming after N seconds. Default unset.
- `BOBSLED_CORE_ALLOW_PRIVATE_OAUTH_HOSTS=1` — allow OAuth token endpoints on private/loopback hosts (escape hatch for internal IdPs behind VPN). Default off (SSRF guard rejects).

Set `cross_warehouse_staging.uri` on the publish target integration to enable native source UNLOAD into a shared Parquet staging location. Sources without UNLOAD support automatically use streaming fallback.

**v1 limits** — see `docs/reference/advanced/cross-warehouse-limitations.md`:

- `materialization.type` must be `table`, `incremental`, or `snapshot`. `view`, `materialized_view`, `dynamic_table`, and `ephemeral` are rejected because they imply zero data movement.
- Source auth must be long-lived (Snowflake `rsa_key`/`pat`, Databricks `pat`, Postgres `password`/`iam`). OAuth is rejected at validation time because tokens can't cover multi-hour publishes.
- Single publish target per model (no fan-out).
- MySQL destinations are not supported (no `MySQLDestination` in `@bobsled-inc/loader`).
- Incremental publishes honor `materialization.cursor_field` for source-side pruning (`SELECT MAX(cursor) FROM <target>` rewrites the source SQL with a `WHERE cursor > <watermark>` predicate). Publish-level skip (short-circuiting an unchanged-input run) and minimum-rerun intervals are deferred; every live run still re-stages every source.
- No publish-level row caps. Use warehouse-native cost controls (Snowflake warehouse limits, BigQuery reservations/quotas, Databricks SQL warehouse auto-stop) — see `docs/reference/advanced/cross-warehouse-limitations.md#cost-controls`.
- Concurrent runs against the same published model can race (no destination-side lock yet). Serialize per model in CI/cron.

For the full Postgres + Snowflake → Databricks worked example, see `docs/reference/advanced/cross-warehouse-cookbook.md`. For data-flow / residency / audit-trail, see `docs/reference/advanced/cross-warehouse-data-flow.md`.

## Project Structure

```text
my-project/
├── model-spec.yml                   # Project config (directory overrides; all optional)
├── integrations/
│   └── <handle>.yml          # Connection + auth per warehouse (see "Integrations" below)
├── targets/
│   └── <handle>.yml          # Optional — references an integration + narrows it
├── sources/
│   └── <connection>/         # Group by connection name (matches source.connection)
│       └── raw_table.yml
├── models/
│   └── model_name.yml
├── metrics/                  # Optional — metric definitions
├── relationships/            # Optional — relationship definitions
└── vqs/                      # Optional — verified queries
```

## Project config (`model-spec.yml`)

`model-spec.yml` holds optional settings. Bobsled Core finds sources, models, metrics, relationships, VQs, and integrations by their declared `type` anywhere in the project, so those directory keys are accepted but no longer limit where files live. Bobsled Core discovers CSV seeds below any `seeds/` directory; `seeds_dir` remains an explicit legacy override. `entity_graph_dir` and `targets_dir` still locate Entity Graph specs and load targets. A `model-spec.yml` moved out of the project root declares `type: model_spec_config`. The accepted keys are exactly:

```yaml
type: model_spec_config # required only when the file is not the root model-spec.yml
sources_dir: sources # default: sources
models_dir: models # default: models
seeds_dir: seeds # optional legacy override; default discovery uses every `seeds/` directory
entity_graph_dir: entity-graph # default: entity-graph; legacy `mdm_dir` still accepted
integrations_dir: integrations # default: integrations
targets_dir: targets # default: targets
metrics_dir: metrics # default: metrics
relationships_dir: relationships # default: relationships
vqs_dir: vqs # default: vqs
```

**Not model-spec.yml keys** (common authoring mistakes): `connection:`, `integration:`, `defaults:`, `dialect:`, `schema:`. Warehouse connection / auth / dialect live in `integrations/<handle>.yml`. Setting any of these in model-spec.yml produces `[UNKNOWN_MODEL_SPEC_CONFIG_KEY]` with a fuzzy-match suggestion.

## Spec versions

Each YAML file declares a `spec_version:` literal. Values are kind-specific — not all `0.2`.

| File kind                                              | `spec_version:` | Where                                                                |
| ------------------------------------------------------ | --------------- | -------------------------------------------------------------------- |
| Model Spec source / model / metric / relationship / VQ | `'0.2'`         | `sources/`, `models/`, `metrics/`, `relationships/`, `vqs/`          |
| Bobsled Core integration                               | `'2'`           | `integrations/<handle>.yml` (when using the new Bobsled Core schema) |
| Bobsled Core warehouse/file resource                   | `'1'`           | extractor `resources/*.yml` for warehouse and file source kinds      |

The Bobsled Core integration shape shown under "Integrations" below uses `spec_version: '1'` for the legacy Model Spec-managed integration schema; the platform-managed `2` shape is documented in `packages/bobsled-core`. Pick the one your project uses.

## Integrations

`integrations/<handle>.yml` declares a connection to one warehouse. Model Spec reads it, interpolates `${{ env.VAR }}` tokens through a `SecretResolver`, and dispatches to the matching built-in runner in `@bobsled-inc/connections`. Secrets come from `process.env` by default; `--secrets <path>` overlays a flat YAML map on top.

Shape (discriminated on `source_type`):

```yaml
spec_version: '1'
type: integration
name: snowflake # matches the filename <handle>.yml
source_type: snowflake # snowflake | bigquery | postgres | databricks | duckdb
connection: { … } # dialect-specific
auth:
  type: … # dialect-specific
  … # dialect-specific
```

Interpolation: use `${{ env.VAR }}` for secret/identifier fields. The legacy `<field>_env: VAR` shape still works but emits a deprecation warning — migrate when touching the file.

### Snowflake

```yaml
spec_version: '1'
auth_env_vars:
  [
    SF_CLIENT_ID,
    SF_CLIENT_SECRET,
    SF_KEY_PASSPHRASE,
    SF_KEY_PATH,
    SNOWFLAKE_ACCOUNT,
    SNOWFLAKE_PAT,
    SNOWFLAKE_USER,
    SNOWFLAKE_WAREHOUSE,
  ]
type: integration
name: snowflake
source_type: snowflake
connection:
  account_identifier: ${{ env.SNOWFLAKE_ACCOUNT }}
  warehouse: ${{ env.SNOWFLAKE_WAREHOUSE }}
  user: ${{ env.SNOWFLAKE_USER }}
  role: SYSADMIN # required
  database: ANALYTICS # optional default — models can override
  schema: PUBLIC # optional default
auth:
  type: pat # pat | rsa_key | oauth | sledhouse_oidc
  token: ${{ env.SNOWFLAKE_PAT }}
  # rsa_key variant:
  # private_key_path: ${{ env.SF_KEY_PATH }}
  # private_key_passphrase: ${{ env.SF_KEY_PASSPHRASE }}  # optional
  # oauth variant:
  # client_id: ${{ env.SF_CLIENT_ID }}
  # client_secret: ${{ env.SF_CLIENT_SECRET }}
  # token_url: https://<account>.snowflakecomputing.com/oauth/token-request
```

`sledhouse_oidc` is accepted by the schema but has **no built-in runner** — hosts supply one via `CustomRunnerRegistry`. OSS users should never need it.

### BigQuery

```yaml
spec_version: '1'
auth_env_vars: [GCP_PROJECT_ID, GCP_SA_KEY, WIF_SA_EMAIL]
type: integration
name: bigquery
source_type: bigquery
connection:
  project_id: ${{ env.GCP_PROJECT_ID }} # or project_ids: [a, b] for multi-project
  default_location: US # optional
  dataset: analytics # optional default
auth:
  type: adc # adc | wif | service_account
  # service_account variant:
  # credentials: ${{ env.GCP_SA_KEY }}      # JSON payload OR file path
  # wif variant:
  # service_account_email: ${{ env.WIF_SA_EMAIL }}
```

### Postgres

```yaml
spec_version: '1'
auth_env_vars: [PG_CA, PG_HOST, PG_PASSWORD, PG_USER]
type: integration
name: postgres
source_type: postgres
connection:
  host: ${{ env.PG_HOST }}
  port: 5432 # optional (default 5432)
  database: analytics # required
  schema: public # optional default
  # ssl: { mode: verify-full, ca_cert: ${{ env.PG_CA }} }  # optional
auth:
  type: password # password | iam
  user: ${{ env.PG_USER }}
  password: ${{ env.PG_PASSWORD }}
  # iam variant (AWS RDS/Aurora — password minted by AWS SDK at connect time):
  # type: iam
  # user: ${{ env.PG_USER }}
  # region: us-east-1
```

### ClickHouse

Reaches ClickHouse Cloud from the host and credentials alone. TLS is on unless
disabled, and the port follows the scheme, so a Cloud service needs no transport
settings. ClickHouse has no schema level — `database` is the whole namespace,
and models address tables as `database.table`.

```yaml
spec_version: '1'
auth_env_vars: [CLICKHOUSE_HOST, CLICKHOUSE_PASSWORD, CLICKHOUSE_USER]
type: integration
name: clickhouse
source_type: clickhouse
connection:
  host: ${{ env.CLICKHOUSE_HOST }} # e.g. example.us-central1.gcp.clickhouse.cloud
  database: analytics # required
  # port: 8443                      # optional (8443 with TLS, 8123 without)
  # statement_timeout_ms: 300000    # optional (max 24h)
  # ssl: { mode: disable }          # opt out of TLS for a plain local server
auth:
  type: password # the only mode the HTTP interface supports
  user: ${{ env.CLICKHOUSE_USER }} # ClickHouse Cloud's default user is `default`
  password: ${{ env.CLICKHOUSE_PASSWORD }}
```

Materializations are `table` and `view`. `incremental` with the `merge`
strategy, `snapshot`, `materialized_view`, and `dynamic_table` fail with an
unsupported-feature error: ClickHouse has no `MERGE`, and its `MATERIALIZED
VIEW` is an insert trigger rather than a refreshable snapshot, so it would
silently omit every row written before the view was created.

### Databricks

```yaml
spec_version: '1'
auth_env_vars: [DATABRICKS_TOKEN, DB_CLIENT_ID, DB_CLIENT_SECRET, DB_HTTP_PATH, DB_WORKSPACE_HOST]
type: integration
name: databricks
source_type: databricks
connection:
  workspace_url: https://${{ env.DB_WORKSPACE_HOST }}
  http_path: ${{ env.DB_HTTP_PATH }}
  catalog: main # optional default
  schema: default # optional default
auth:
  type: pat # pat | oauth_m2m
  token: ${{ env.DATABRICKS_TOKEN }}
  # oauth_m2m variant:
  # client_id: ${{ env.DB_CLIENT_ID }}
  # client_secret: ${{ env.DB_CLIENT_SECRET }}
```

### DuckDB

DuckDB is embedded — the `auth` variant selects between a file-backed persistent DB and a transient in-memory one. There are no credentials.

```yaml
spec_version: '1'
type: integration
name: duckdb
source_type: duckdb
connection:
  schema: main # optional default
auth:
  type: file # file | memory
  path: ./warehouse.duckdb # required for file
  # read_only: true         # optional (default false)
  # memory variant:
  # type: memory
```

### Secrets overlay

`--secrets secrets.yml` reads a flat YAML map and overlays it on `process.env`:

```yaml
# secrets.yml (gitignore this!)
SNOWFLAKE_PAT: abc123...
GCP_SA_KEY: /Users/me/.gcp/key.json
```

Then:

```bash
bobsled model run --integration snowflake --secrets secrets.yml
```

## Source Spec Schema

Sources declare warehouse tables that models read from.

```yaml
spec_version: '0.2' # Required, must be "0.2"
name: raw_customers # Required, valid identifier [a-zA-Z_]\w*
type: source # Required, must be "source"
source_type: warehouse_table # Required, must be "warehouse_table"
connection: ecom # Required, connection name
table: RAW.RAW_CUSTOMERS # Required, dotted identifier (schema.table)
description: Raw customer data # Optional
trust_tier: bronze # Optional: bronze (default) | silver | gold
quality: # Optional quality checks
  freshness:
    max_age: '24h'
  row_count:
    min: 1
    max: 1000000
schema: # Required
  columns: # Required, at least one column
    - name: ID # Required, column name
      type: NUMBER # Required, column data type
      description: Primary key # Optional
```

### Source Field Rules

| Field                   | Type   | Required | Constraint                                   |
| ----------------------- | ------ | -------- | -------------------------------------------- |
| `spec_version`          | string | Yes      | Must be `"0.2"`                              |
| `name`                  | string | Yes      | `/^[a-zA-Z_]\w*$/`                           |
| `type`                  | string | Yes      | Must be `"source"`                           |
| `source_type`           | string | Yes      | Must be `"warehouse_table"`                  |
| `connection`            | string | Yes      | Non-empty                                    |
| `table`                 | string | Yes      | Dotted identifier (e.g. `RAW.RAW_CUSTOMERS`) |
| `trust_tier`            | enum   | No       | `bronze` \| `silver` \| `gold`               |
| `schema.columns`        | array  | Yes      | Min 1 column                                 |
| `schema.columns[].name` | string | Yes      | Non-empty                                    |
| `schema.columns[].type` | string | Yes      | Non-empty                                    |

### Embedding columns (`type: VECTOR`)

`VECTOR` is a first-class Model Spec column type for embedding columns. The
compiler maps it to native warehouse types at compile time: Snowflake
`VECTOR(FLOAT, N)`, BigQuery `ARRAY<FLOAT64>`, DuckDB `FLOAT[N]`,
pgvector `vector(N)`; fallback dialects map to a JSON/array type. When
`type: VECTOR`, a sibling `dimension: <positive integer>` is required.
`embedded_from` carries provenance so the host agent can generate a
matching query embedding.

```yaml
- name: description_embedding
  type: VECTOR
  dimension: 1536
  description: Vector embedding of description (openai/text-embedding-3-small)
  embedded_from:
    column: description # source field that was embedded
    provider: openai # provider id
    model: text-embedding-3-small # model id
    # distance_metric: cosine     # optional, reserved: cosine | l2 | dot
```

For source models, `bobsled pipeline … --emit-model-spec-source` pre-fills this
shape from the pipeline's `embed:` block. For derived (silver/gold)
models, re-author `embedded_from` on the re-projected column.

## Refs — bare vs qualified

A `ref:` string in `source:`, `joins[].ref`, or `union[].ref` resolves by shape:

| Shape                                | Resolves to                          | Example                            |
| ------------------------------------ | ------------------------------------ | ---------------------------------- |
| Bare name (`stg_orders`)             | **Model** by name (case-insensitive) | `source: { ref: stg_orders }`      |
| Qualified (`<integration>.<source>`) | **Source** in that integration       | `source: { ref: ecom.raw_orders }` |

The integration prefix is the integration's `name:` field (the value declared inside `integrations/<handle>.yml`), **not the filename slug**. They are usually the same, but only `name:` is authoritative — if you renamed `name:` without renaming the file, qualified refs use the new `name:`.

If a bare ref doesn't match a model but matches some source's tail name, the compiler now suggests the qualified form: `[UNRESOLVED_REF_WITH_HINT] Unknown ref "orders". Did you mean source "ecom.orders"? Sources need the integration prefix; bare names resolve only to models.`

## Pipelines (extract vs models)

Bobsled Core pipelines are declared per-project in `bobsled.yml` (or equivalent). Two pipeline kinds:

```yaml
pipelines:
  # An extract pipeline — pulls raw data from a source into a destination
  raw_ecom:
    type: extract # one of: extract | models
    source: ecom
    destination: warehouse
    resources: [orders, customers]
    schedule: '0 * * * *' # cron; or 'manual' to opt out of auto-firing

  # A models pipeline — runs Model Spec models against one warehouse
  warehouse_analytics:
    type: models # one of: extract | models
    connection: snowflake # MUST match a destination key in this project
    schedule: '0 6 * * *'
    models: '*' # wildcard scopes to derived models on THIS connection
    warehouse: large # optional stable ID from the connection's warehouses map
```

**`type:` enum** — pipelines are `extract` or `models` only. Anything else now
hard-errors with `[UNKNOWN_PIPELINE_TYPE]` and a fix-suggesting message.
`managed` belongs in the `runner:` field, not `type:`.

**`models: "*"` semantics** — the wildcard expands to every derived model on the pipeline's `connection`, **not** every model in the repo. Models pinned to other connections (via their source's `connection:` or via cross-warehouse `publish:`) are skipped.

**`connection:` on a models pipeline** — must match the key of a declared destination block. If it doesn't, validation fails before the pipeline runs.

**`warehouse:` on a models pipeline** — optional pipeline-scoped session selector.
Use a declared warehouse-map **ID** (for example `large`), never the concrete
provider warehouse name (for example `BIG_WH`). A selector is rejected for a
connection that does not expose a warehouse-ID map.

## Model/Transform Spec Schema

Models define transformations as column expressions.

```yaml
spec_version: '0.2'
name: stg_customers
type: model
description: Staged customers with consistent naming # Required
grain: customer_id # Required (string or array of strings)
tags: [staging, customers] # Optional
owner: data-team # Optional
trust_tier: bronze # Optional: bronze | silver | gold
trust_config: # Optional
  promotion_tests:
    - type: backtest # backtest | canary | semantic_rule
      query: 'SELECT COUNT(*) FROM ...'
      expected: 100
    - type: canary
      mode: delta # delta | range | monotonic | row_count
    - type: semantic_rule
      rule: 'revenue > 0' # Rule expression for semantic validation
      columns: [TOTAL, AMOUNT] # Columns to validate
  demotion_triggers:
    - source_schema_change
    - test_failure
    - canary_failure

source:
  ref: ecom.raw_customers # Required, source or model name
  filter: "STATUS != 'deleted'" # Optional, WHERE clause filter

joins: # Optional
  - ref: stg_customers
    type: left # left | inner | cross | full
    on: 'stg_orders.CUSTOMER_ID = stg_customers.CUSTOMER_ID' # Required
    description: Enrich with customer data # Optional
    pre_aggregate: # Optional - aggregate joined table before joining
      group_by: [CUSTOMER_ID]
      columns:
        - name: ORDER_COUNT
          expr: 'count(*)'

columns: # Required, at least one
  - name: CUSTOMER_ID # Required, valid identifier
    expr: ID # Required, Expression DSL (see bobsled-model-spec-expressions skill)
    description: Unique customer ID
    type: NUMBER # Optional, data type hint
    primary_key: true # Optional
    not_null: true # Optional
    semantic_role: entity_id # Optional (see Semantic Roles below)
    references: stg_customers.customer_id # Optional, FK reference
    tags: [pii] # Optional
    business_rule: Mapped from source ID # Optional
    quality_notes: Never null # Optional
    owner: data-team # Optional
    deprecated: false # Optional

group_by: [CUSTOMER_ID] # Optional, for aggregate models

derived_columns: # Optional, computed after main columns
  - name: FULL_NAME
    expr: "FIRST_NAME || ' ' || LAST_NAME"
    description: Concatenated name
    type: VARCHAR

flatten_json: # Optional, JSON flattening
  column: PAYLOAD
  path: 'data.attributes'
  alias: attrs

pivot: # Optional
  column: STATUS
  values: [active, churned]
  aggregate:
    count # Allowed: sum, count, avg, min, max, listagg, array_agg,
    #   string_agg, group_concat, median, stddev, variance,
    #   any_value, approx_count_distinct, count_if, hll_count.merge
  value_column: USER_ID

hierarchy: # Optional, walk a parent/child edge (compiles to WITH RECURSIVE)
  parent_key: PARENT_ID
  child_key: COMPANY_ID
  max_depth: 20 # Required, 1-100
  seed: roots # roots | all_nodes — all_nodes is required to find a rootless cycle
  emit: { root: ROOT_ID, depth: DEPTH, path: ID_PATH, cycle: IS_CYCLE }
  path_delimiter: '/' # Keys must not contain this character

recurse: # Optional, general bounded fixpoint; hierarchy compiles to this
  max_depth: 20 # Required, 1-100
  step:
    source:
      ref: edges # Optional, defaults to the model's own source
      join_on: source.PARENT_ID = prior.COMPANY_ID
      where: source.ACTIVE # Optional extra step filter
    columns: # Must name exactly the model's columns
      - { name: COMPANY_ID, expr: COMPANY_ID }
      - { name: LEVEL, expr: prior.LEVEL + 1 }
  cycle: # Optional
    on: COMPANY_ID
    emit: IS_CYCLE
    delimiter: '/'

union: # Optional, UNION ALL branches
  - ref: stg_orders_v1
    filter: 'version = 1'
    columns:
      - name: ORDER_ID
        expr: ID

materialization: # Required (see Materialization Types below)
  type: view

# Passthrough fields — preserved in parsed output for agent consumption, not compiled to SQL
metrics: ... # Optional, arbitrary metrics metadata
unit_tests: ... # Optional, unit test definitions
access: ... # Optional, access control metadata
audit: ... # Optional, audit trail metadata
related_models: ... # Optional, related model references
environments: ... # Optional, environment-specific config

pre_hook: # Optional, SQL to run before model
  - "ALTER SESSION SET TIMEZONE = 'UTC'"
post_hook: # Optional, SQL to run after model
  - 'ANALYZE {schema}.{name}'

tests: # Optional, data quality tests
  - type: not_null
    column: CUSTOMER_ID
  - type: unique
    column: CUSTOMER_ID
  - type: accepted_values
    column: STATUS
    values: [active, inactive, churned]
  - type: custom
    sql: 'SELECT COUNT(*) FROM {name} WHERE TOTAL < 0'
```

## Semantic Roles

| Role                   | Meaning                      | Example                    |
| ---------------------- | ---------------------------- | -------------------------- |
| `entity_id`            | Primary/natural key          | `CUSTOMER_ID`, `ORDER_ID`  |
| `measure`              | Numeric fact for aggregation | `TOTAL`, `QUANTITY`        |
| `event_timestamp`      | When the event occurred      | `ORDER_DATE`, `CREATED_AT` |
| `extraction_timestamp` | When data was extracted      | `ETL_LOADED_AT`            |
| `time_dimension`       | Date/time for grouping       | `ORDER_MONTH`              |
| `categorical`          | Discrete category            | `STATUS`, `COUNTRY`        |

## Trust Tiers

| Tier     | Meaning                      | Typical Use              |
| -------- | ---------------------------- | ------------------------ |
| `bronze` | Raw, unvalidated             | Sources, initial staging |
| `silver` | Validated, tested            | Cleaned staging models   |
| `gold`   | Production-grade, SLA-backed | Mart/fact tables         |

## Materialization Types

| Type                | DDL                        | Notes                     |
| ------------------- | -------------------------- | ------------------------- |
| `view`              | `CREATE OR REPLACE VIEW`   | Default, always fresh     |
| `table`             | `CREATE OR REPLACE TABLE`  | Full refresh each run     |
| `incremental`       | `MERGE` / `INSERT`         | Requires `strategy`       |
| `ephemeral`         | None (inlined as CTE)      | No DDL emitted            |
| `snapshot`          | `MERGE` (SCD Type 2)       | Tracks historical changes |
| `dynamic_table`     | Warehouse-specific         | Snowflake dynamic tables  |
| `materialized_view` | `CREATE MATERIALIZED VIEW` | Warehouse-managed refresh |

### Snapshot (SCD Type 2)

```yaml
# Track historical changes with valid_from/valid_to columns
materialization:
  type: snapshot
  unique_key: customer_id # Required, business key
  tracked_columns: [status, email, tier] # Optional, columns to track (default: all non-key)
  valid_from_column: valid_from # Optional (default: valid_from)
  valid_to_column: valid_to # Optional (default: valid_to)
```

### Snapshot Validation Rules

- `unique_key` is **required**
- `tracked_columns` must not overlap with `unique_key`
- Generates `valid_from`, `valid_to`, `is_current` columns automatically
- Uses `IS DISTINCT FROM` for null-safe change detection (MySQL: `<=>`)

### Per-Model Schema/Database Override

**Rule:** `target_schema` and `target_database` are **top-level** model fields — peers of `materialization:`, not keys inside it.

```yaml
# Right — top-level peers of materialization
target_schema: ANALYTICS # Optional, overrides default
target_database: PROD_DW # Optional, overrides default
materialization:
  type: table

# Wrong — rejected with [MISPLACED_TARGET_SCHEMA]
materialization:
  type: table
  target_schema: ANALYTICS # ❌ silently ignored historically; now hard error
  target_database: PROD_DW # ❌
```

Why: nesting them under `materialization:` used to validate cleanly and then fail at pipeline runtime. The compiler now rejects this placement at parse time with a fix-suggesting message.

### Incremental Strategies

```yaml
# Merge (default) — requires unique_key
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id # Required for merge
  incremental_filter: "created_at > DATEADD('day', -3, CURRENT_DATE)"

# Delete+Insert — requires unique_key
materialization:
  type: incremental
  strategy: delete_insert
  unique_key: [order_id, line_item_id] # Can be composite

# Append — requires incremental_filter (prevents full duplication)
materialization:
  type: incremental
  strategy: append
  incremental_filter: "created_at > DATEADD('day', -1, CURRENT_DATE)" # Required
```

### Incremental Validation Rules

- `merge` and `delete_insert` strategies **require** `unique_key`
- `append` strategy **requires** `incremental_filter` (without it, every row duplicates on every run)

## Materialization Strategy

When authoring a model, choose materialization based on freshness, cost, source mutability, and dialect support. The full reference (with dialect capability matrix, transition rules, and validation details) lives at `docs/materializations-reference.md`. This section is the agent-facing distillation.

### When to choose which type

- **`view`** — exploratory or always-fresh queries; no storage cost.
- **`table`** — curated outputs read by many consumers; full refresh per run.
- **`incremental`** — source data is large or append-mostly and full refresh is too expensive. Pick a strategy:
  - `merge` (default) for upserts on a stable `unique_key`.
  - `append` for pure-insert sources (event streams, audit logs).
  - `delete_insert` for batched updates that fully replace a slice.
- **`ephemeral`** — internal staging logic with no persistence requirement; inlined as CTE in downstream models.
- **`snapshot`** — slowly-changing dimensions where history matters (SCD-2). Only `on_schema_change: fail` is allowed.
- **`dynamic_table`** — Snowflake-managed always-fresh outputs with a target lag.
- **`materialized_view`** — warehouse-managed cached query (Snowflake / BigQuery / Postgres / Databricks / Redshift).

### Dialect capability matrix

| Materialization     | Snowflake | BigQuery | Postgres | Databricks | MySQL | DuckDB | Redshift |
| ------------------- | :-------: | :------: | :------: | :--------: | :---: | :----: | :------: |
| `view`              |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `table`             |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `incremental`       |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `ephemeral`         |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `snapshot`          |    Yes    |   Yes    |   Yes    |    Yes     |  Yes  |  Yes   |   Yes    |
| `dynamic_table`     |    Yes    |    No    |    No    |     No     |  No   |   No   |    No    |
| `materialized_view` |    Yes    |   Yes    |   Yes    |    Yes     |  No   |   No   |   Yes    |

Choosing an unsupported combination raises `CommandError(2)` at compile time with a `bestMaterializationAlternative` suggestion.

### Recursion (`hierarchy` / `recurse`)

Recursion lives inside one model. `prior` names the previous iteration, so it is
never a model ref and the DAG stays acyclic; `source` names the row being joined
in, and an unqualified column in a step expression resolves to it.

| Construct               | Snowflake | BigQuery | Postgres | Databricks | MySQL | DuckDB | Redshift |
| ----------------------- | :-------: | :------: | :------: | :--------: | :---: | :----: | :------: |
| `hierarchy` / `recurse` |    Yes    |   Yes    |   Yes    |     No     |  Yes  |  Yes   |   Yes    |

Databricks gained recursive CTEs in DBSQL 2025.20 / Runtime 17.0 and it is still
preview; the compiler cannot read a connection's runtime version, so it fails
closed with `[unsupported_feature:recursiveCte]`. BigQuery aborts at 500
iterations regardless of `max_depth`.

Rules the schema enforces:

- `max_depth` is required (1-100) and becomes a real predicate, not a hint.
- `recurse.step.columns` must name exactly the model's `columns`; the emitted
  step reorders them to match, because a set operation matches by position.
- At least one step column must read `prior.`, or it is a join, not a recursion.
- Materialization must be `view` or `table`. Ephemeral cannot carry
  `WITH RECURSIVE` into a folding CTE on every dialect; incremental has no
  defined fixpoint semantics yet.
- `group_by`, `having`, `qualify`, `dedupe`, `distinct`, `pivot`, `unpivot`,
  `union`, `flatten_json` and `derived_columns` cannot be combined with either
  operator — read the closure from a downstream model. `order_by`, `limit` and
  `offset` apply to the closure and are allowed.
- `seed: all_nodes` requires `emit.cycle`: it starts a walk at every row, which
  only a cycle audit pays for. `seed: roots` cannot see a cycle that has no
  parentless row, and reports only the entry row of one reachable from a root.
- The `__bms_` prefix is reserved. Recursion generates depth, path and node
  columns under it, and QUALIFY emulation generates a hoisted predicate column,
  all alongside the model's own; a declared name in that namespace is rejected
  rather than allowed to become a duplicate alias.

### `on_schema_change`

Controls how schema drift between runs is handled. Set on the materialization (incremental and snapshot only).

```yaml
materialization:
  type: incremental
  strategy: merge
  unique_key: ORDER_ID
  on_schema_change: full_refresh # rebuild on drift; warn in CI
```

- **`fail`** (default) — drift aborts the run with `CommandError(3)`. State is preserved.
- **`full_refresh`** — drift triggers automatic table rebuild. Prior data is discarded. Issues a warning at the integration level.
- Snapshots only support `fail` (the schema parser literally rejects `full_refresh`). Rebuilding a snapshot loses history.

### Transitions between materialization types

- `view` ↔ `table` — auto-recreate. Model Spec emits `DROP` + `CREATE`. On Snowflake, includes `COPY GRANTS` to preserve privileges.
- All other transitions (e.g. `incremental` → `table`) — abort with `CommandError(3)` and a remediation message including the exact `DROP` to run. Prevents accidental data / history loss.

### Hooks

- `pre_hook` and `post_hook` are SQL string arrays on the materialization spec.
- Template substitution: `{schema}` and `{name}` resolve at run time.
- `dangerousHookRegex` rejects semicolons and any hook starting with `DROP` / `ALTER` / `TRUNCATE` / `DELETE` / `GRANT` / `REVOKE`. Use stored procedures (`CALL`) or admin tooling for those operations.

```yaml
materialization:
  type: table
  pre_hook:
    - "CALL ops.set_session_tag('build:{name}')"
  post_hook:
    - 'ANALYZE {schema}.{name}'
```

### `dynamic_table` options (Snowflake-only)

```yaml
materialization:
  type: dynamic_table
  target_lag: '1 hour' # required; either DOWNSTREAM or a duration ≥ 60s
  warehouse: TRANSFORMING_WH # required if not on the integration
```

`target_lag` and `warehouse` raise `CommandError(2)` on non-Snowflake dialects.

### `materialized_view` options

```yaml
# BigQuery — supports max_staleness
materialization:
  type: materialized_view
  max_staleness: '1 hour' # 30 min – 3 day range, BigQuery only
```

Plain `materialization: { type: materialized_view }` works on Snowflake / Postgres / Databricks / Redshift. `max_staleness` raises `CommandError(2)` on non-BigQuery dialects.

### Common mistakes

- ❌ Setting `materialization: dynamic_table` on a non-Snowflake integration — hard fails with a fallback suggestion.
- ❌ Setting `on_schema_change: full_refresh` on a snapshot — schema parser rejects.
- ❌ Expecting `incremental → table` to auto-transition — returns `CommandError(3)`.
- ❌ Using `GRANT` / `REVOKE` / `DROP` in `pre_hook` / `post_hook` — `dangerousHookRegex` rejects them.
- ❌ Using `{{this}}` in hooks — the actual template tokens are `{schema}` and `{name}`.
- ❌ Adding `target_lag` to a non-Snowflake model — Snowflake-only option.
- ❌ Adding `max_staleness` to a non-BigQuery materialized view — BigQuery-only option.

### Materialization Strategy Validation Rules

- `dynamic_table.target_lag` — required (defaults to `DOWNSTREAM`); duration form must be ≥ 60 seconds.
- `dynamic_table.warehouse` — required unless inherited from `connection.warehouse` on the Snowflake integration.
- `materialized_view.max_staleness` — BigQuery-only; range 30 minutes to 3 days inclusive.
- `snapshot.on_schema_change` — must be `fail` (parser-enforced).
- Unsupported (materialization × dialect) combinations fail at compile time with `CommandError(2)`.

## Validation Rules

### Identifiers

- Pattern: `/^[a-zA-Z_]\w*$/`
- Must start with letter or underscore, then letters/digits/underscores

### Dotted Identifiers (table names)

- Pattern: `/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)+$/`
- At least two segments: `schema.table` or `project.dataset.table`

### Expression Safety

- Quoted semicolons are allowed, for example `listagg(t0.company_id, '; ')` or a CASE label. Statement separators outside quoted literals are rejected.
- Prohibited command prefixes, including `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `INSERT`, `UPDATE`, `DELETE`, `GRANT`, and `REVOKE`, and unquoted `UNION`/`EXCEPT`/`INTERSECT SELECT` operations are rejected. Comments cannot hide them; quoted keywords remain literal data.
- Unterminated strings, quoted identifiers, and comments fail validation. Nested block comments and executable comments are conservatively rejected.
- Ordinary expressions and explicit `raw_sql()` share these checks. Native SQL fallback still requires valid quoting/comments and valid SQL for the compiler dialect; it does not guarantee that every expression will compile.

## Examples

### Source

```yaml
spec_version: '0.2'
name: raw_customers
type: source
source_type: warehouse_table
connection: ecom
table: RAW.RAW_CUSTOMERS
schema:
  columns:
    - name: ID
      type: NUMBER
      description: Primary key
    - name: NAME
      type: VARCHAR
    - name: EMAIL
      type: VARCHAR
    - name: CREATED_AT
      type: TIMESTAMP
    - name: COUNTRY
      type: VARCHAR
```

### Staging Model

```yaml
spec_version: '0.2'
name: stg_customers
type: model
description: Staged customers with consistent naming
grain: customer_id
source:
  ref: ecom.raw_customers
columns:
  - name: CUSTOMER_ID
    expr: ID
    primary_key: true
    semantic_role: entity_id
  - name: CUSTOMER_NAME
    expr: NAME
  - name: EMAIL
    expr: LOWER(EMAIL)
materialization:
  type: view
```

### Fact Table with Joins

```yaml
spec_version: '0.2'
name: fct_orders
type: model
description: Order fact table enriched with customer details
grain: order_id
source:
  ref: stg_orders
joins:
  - ref: stg_customers
    type: left
    on: 'stg_orders.CUSTOMER_ID = stg_customers.CUSTOMER_ID'
columns:
  - name: ORDER_ID
    expr: stg_orders.ORDER_ID
    primary_key: true
    semantic_role: entity_id
  - name: CUSTOMER_NAME
    expr: stg_customers.CUSTOMER_NAME
  - name: TOTAL
    expr: stg_orders.TOTAL
    semantic_role: measure
  - name: ORDER_DATE
    expr: stg_orders.ORDER_DATE
    semantic_role: event_timestamp
materialization:
  type: view
```

## Common Patterns

### Correct

```yaml
# Source ref with connection prefix
source:
  ref: ecom.raw_customers

# Model ref (no connection prefix needed)
source:
  ref: stg_orders

# Qualified column in joins
columns:
  - name: ORDER_ID
    expr: stg_orders.ORDER_ID

# Expression with function
columns:
  - name: EMAIL
    expr: LOWER(EMAIL)
```

### Incorrect

```yaml
# Missing spec_version
name: my_model
type: model
# ^ Missing spec_version: "0.2"

# Invalid identifier (starts with number)
name: 1_bad_name
# ^ Must start with letter or underscore

# Missing description on model
spec_version: '0.2'
name: my_model
type: model
grain: id
# ^ description is required for models

# Incremental merge without unique_key
materialization:
  type: incremental
  strategy: merge
# ^ unique_key is required for merge strategy

# Append without incremental_filter
materialization:
  type: incremental
  strategy: append
# ^ incremental_filter is required (prevents full duplication)

# SQL injection in expression
columns:
  - name: BAD
    expr: 'ID; DROP TABLE users'
# ^ Statement separators outside quoted literals are rejected
```

## Troubleshooting

| Error                                                                                                                                               | Cause                                               | Fix                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Must be a valid identifier`                                                                                                                        | Name contains invalid chars                         | Use only `[a-zA-Z_]\w*`                                                                                                                   |
| `Must be a dotted identifier`                                                                                                                       | Table missing schema prefix                         | Use `SCHEMA.TABLE` format                                                                                                                 |
| `unique_key is required for incremental strategy "merge"`                                                                                           | Missing unique_key                                  | Add `unique_key` field                                                                                                                    |
| `incremental_filter is required for append strategy`                                                                                                | Missing filter                                      | Add `incremental_filter`                                                                                                                  |
| `Expression must have terminated SQL quoting/comments and must not contain statement separators, DDL/command statements, or UNION/EXCEPT/INTERSECT` | Malformed quoting/comments or prohibited SQL syntax | Close quoted contents and comments; remove statement separators and prohibited operations from SQL syntax. Quoted semicolons are allowed. |
| `At least one column is required`                                                                                                                   | Empty columns array                                 | Add at least one column                                                                                                                   |
| `Description is required`                                                                                                                           | Missing model description                           | Add `description` field                                                                                                                   |
