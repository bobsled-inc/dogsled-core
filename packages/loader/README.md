# @bobsled-inc/loader

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Reads the Dogsled protocol from standard input and loads it into a destination: local files, S3, GCS, DuckDB, DuckLake, SQLite, PostgreSQL, pgvector, Snowflake, BigQuery, MySQL, SQL Server, Databricks, ClickHouse, Elasticsearch, Chroma or Turbopuffer.

## Installation

Install `@bobsled-inc/bobsled-core`; this code ships inside it.

## Quick Start

```bash
# 1. Local dev — load into DuckDB (strategy auto-resolved from resource config)
dogsled pipeline --integration github --resource issues --dest duckdb --db-path ./dev.duckdb

# 2. Query loaded data
dogsled load query "SELECT COUNT(*) FROM main.issues" --db-path ./dev.duckdb

# 3. Preview strategy resolution before loading
dogsled extract run --integration github | dogsled load run --dest bigquery --dataset-id raw_github --dry-run

# 4. Verify connectivity before production
dogsled load check --dest bigquery --dataset-id raw_github

# 5. Production — same pipeline, different flags
dogsled pipeline --integration github --resource issues --dest bigquery --dataset-id raw_github
```

## Vector Columns

The loader now understands protocol `vector` columns when the upstream extractor or embedder supplies a `dimension`.

Supported native mappings:

- `duckdb` and `ducklake` -> `FLOAT[N]`
- `bigquery` -> repeated `FLOAT64`
- `snowflake` -> `VECTOR(FLOAT, N)`
- `postgres` and `pgvector` -> `vector(N)` (Postgres requires the `pgvector` extension)
- `clickhouse` -> `Array(Float32)` (optional `vector_similarity` index with `--clickhouse-vector-index`)
- `turbopuffer` -> `[N]f32` attributes with ANN indexing; attribute-only namespaces are supported
- `elasticsearch` -> `dense_vector` with explicit `dims`
- `chroma` -> collection embeddings stored from a column named `embedding` or `vector`

Destinations that still reject protocol `vector` columns with validation errors include:

- `mysql`
- `sqlite`
- `mssql`
- `databricks`

If you are enabling embeddings in a pipeline, validate destination compatibility before the first load with `dogsled load check` or a focused smoke test.

## CLI Commands

### `dogsled load run` (default)

Reads protocol from stdin, writes to destination.

| Option                                   | Description                                                                                                                                      | Default                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `--dest <type>`                          | Destination: `duckdb`, `ducklake`, `bigquery`, `snowflake`, `postgres`, `mysql`, `databricks`, `clickhouse`, `turbopuffer`, `s3`, `gcs`, `local` | `local`                         |
| `--format <fmt>`                         | Output format for `local`/`gcs`: `jsonl`, `csv`, `parquet`, `arrow`                                                                              | required for file destinations  |
| `--db-path <path>`                       | DuckDB database file path                                                                                                                        | required for duckdb             |
| `--ducklake-catalog-url <url>`           | DuckLake catalog URL                                                                                                                             | required for ducklake           |
| `--target-schema <name>`                 | DuckDB or DuckLake target schema                                                                                                                 | `main`                          |
| `--dataset-id <id>`                      | BigQuery dataset ID                                                                                                                              | required for bigquery           |
| `--project-id <id>`                      | BigQuery project ID                                                                                                                              | auto-detect                     |
| `--location <loc>`                       | BigQuery location                                                                                                                                | —                               |
| `--key-filename <path>`                  | BigQuery service account key file                                                                                                                | —                               |
| `--load-strategy <strat>`                | Override per-stream strategy: `append`, `merge`, or `full_refresh`                                                                               | from SCHEMA                     |
| `--schema-behavior <mode>`               | Override per-stream schema contract: `evolve`, `strict`, or `freeze`                                                                             | from SCHEMA                     |
| `--stream-schema-behavior <stream:mode>` | Override schema contract for one stream (repeatable)                                                                                             | from `--schema-behavior`/SCHEMA |
| `--load-file <path>`                     | Load using a load-block YAML file (ops escape hatch) — see [Load configuration](#load-configuration)                                             | —                               |
| `--dry-run`                              | Print strategy table and exit without loading                                                                                                    | —                               |
| `--buffer-size <n>`                      | Records buffered before flushing                                                                                                                 | `10000`                         |

### `dogsled load check`

Validate destination connectivity before running a pipeline.

```bash
dogsled load check --dest duckdb --db-path ./test.duckdb
dogsled load check --dest ducklake --ducklake-catalog-url ducklake:./catalog.db
dogsled load check --dest bigquery --dataset-id my_dataset
dogsled load check --dest gcs --gcs-bucket my-bucket
```

### `dogsled load query`

Run SQL against a DuckDB or BigQuery database (TSV output).

```bash
# DuckDB
dogsled load query "SELECT * FROM main.issues LIMIT 10" --db-path ./dev.duckdb

# BigQuery
dogsled load query "SELECT * FROM raw_github.issues LIMIT 10" --dest bigquery --project-id my-project
```

## Load configuration

A resource can carry load defaults and overrides alongside its source contract. The destination integration is selected separately:

```yaml
# resources/snowflake_source/orders.yml
spec_version: '1'
type: resource
name: orders

extract:
  integration: snowflake_source
  source:
    table: ORDERS
    database: ANALYTICS
    schema: PUBLIC
  replication:
    method: incremental_merge
    cursor_field: updated_at
    cursor_type: timestamp

load:
  overrides:
    role: LOADER_ROLE
    database: BOBSLED_CORE_RAW
  defaults:
    load_strategy: merge
    schema_behavior: evolve

schema:
  primary_key: [order_id]
  columns:
    order_id: { type: integer }
    updated_at: { type: timestamp }
```

### Destination selection

For the standalone loader, use `--load-integration <handle>` to select an
integration directly, or `--load-file <path>` for a separate file with the shape
below. A data pipe carries protocol messages, so the loader does not automatically
read the extractor's resource YAML.

```bash
dogsled extract run --integration snowflake_source orders | \
  dogsled load run --load-file load-orders.yml
```

Project pipelines can bind a destination in `bobsled.yml` or use
`extractor.yml`'s `default_load.integration`. A resource's `load:` block contains
only `overrides` and `defaults`; it must not contain `integration`.

Files inside a project should declare `spec_version: '1'`, `type: target` and
`name` so project discovery recognizes them. External operations files may omit
those headers and carry only `integration`, `overrides` and `defaults`.

### Load block shape

```yaml
# load-orders.yml
spec_version: '1'
type: target
name: orders_load
integration: snowflake_prod # required -- references integrations/<handle>.yml
overrides: # optional -- narrow integration defaults for this load
  role: LOADER_ROLE
  database: BOBSLED_CORE_RAW
  schema: PUBLIC
defaults: # optional -- per-load behaviour
  load_strategy: merge
  schema_behavior: evolve
  buffer_size: 100000
```

Rules:

- `integration:` is required in a standalone load file. Inline `warehouse`/`connection`/`auth` fields are rejected.
- `overrides.role` / `database` / `schema` / `warehouse` replace the integration's default for this load only; extract-side usage is unaffected.
- Snowflake database, schema, role and warehouse, and BigQuery project, dataset and location accept `${{ env.NAME }}` templates. Target overrides accept the same templates; for BigQuery use `overrides.schema` to select the dataset. An unset referenced variable fails validation before loading.
- Capability validation rejects load blocks that reference API-only integrations (`source_type: api` etc.) before any credentials are resolved.

For Snowflake, an existing destination schema needs no database-level
`CREATE SCHEMA` grant. The loader checks the configured schema's metadata first
and creates it only when absent; ordinary table privileges still apply.
See [Snowflake's access-control requirements](https://docs.snowflake.com/en/sql-reference/sql/create-schema#access-control-requirements).

### Snowflake — three auth types (full dbt parity)

Auth lives on the integration, so both extract and load use the same setup. All three variants below work for load:

**PAT (Programmatic Access Token):**

```yaml
# integrations/snowflake_prod.yml (recommended — ${{ env.X }} interpolation)
auth:
  type: pat
  token: '${{ env.SF_PAT }}'
# Legacy shape (deprecated, still accepted):
# auth:
#   type: pat
#   token_env: SF_PAT
```

The loader passes a PAT through the Snowflake SDK `password` field and leaves
`authenticator` unset; Snowflake accepts PATs through this password-auth path.

**RSA key-pair (dbt default):**

```yaml
auth:
  type: rsa_key
  private_key_path: '${{ env.SF_PRIVATE_KEY_PATH }}'
  # Optional — only set when the private key is passphrase-protected.
  private_key_passphrase: '${{ env.SF_PRIVATE_KEY_PASSPHRASE }}'
# Legacy shape (deprecated, still accepted):
# auth:
#   type: rsa_key
#   private_key_path_env: SF_PRIVATE_KEY_PATH
#   private_key_passphrase_env: SF_PRIVATE_KEY_PASSPHRASE
```

- `private_key_path` uses `${{ env.X }}` to reference an env var that resolves to the path of the RSA private key file on disk. The key file itself is never referenced from YAML.

**OAuth 2.0 (client_credentials grant):**

```yaml
auth:
  type: oauth
  client_id: '${{ env.SF_OAUTH_CLIENT }}'
  client_secret: '${{ env.SF_OAUTH_SECRET }}'
  token_url: https://<your-identity-provider>/oauth/token
# Legacy shape (deprecated, still accepted):
# auth:
#   type: oauth
#   client_id_env: SF_OAUTH_CLIENT
#   client_secret_env: SF_OAUTH_SECRET
#   token_url: https://<your-identity-provider>/oauth/token
```

- Loader fetches an access token at connection time and passes it to `snowflake-sdk` via `authenticator: 'OAUTH'` + `token`.
- Token URL must be `https://` (credentials are in the Basic auth header).

**Pre-minted OIDC / access-token auth (Dogsled destination fields):**

- `credentials_access_token` resolves to loader flag `--sf-access-token` and forces `authenticator: 'OAUTH'`.
- `credentials_token_command` resolves to loader flag `--sf-token-command`, takes precedence over the static token, and reconnects with a fresh token before expiry.
- URI batches re-check the token and reacquire the Snowflake connection before each `COPY`, so later files in a long-running load do not reuse an expired session.

**Workload identity (OIDC):**

Pass the pre-minted JWT through a quoted environment variable reference with
`--sf-workload-identity-token '$SNOWFLAKE_WIF_TOKEN'`. The loader stores the
resolved value as `workloadIdentityToken` and passes the following options to
`snowflake-sdk`:

Workload identity requires `snowflake-sdk >=3.4.0`.

```ts
{
  authenticator: 'WORKLOAD_IDENTITY',
  workloadIdentityProvider: 'OIDC',
  token: workloadIdentityToken,
}
```

The loader checks that the value has three JWT segments and that its Base64URL
payload contains a future safe-integer `exp` claim before it creates a
connection. Dogsled does not verify the signature; Snowflake verifies the token.
The token is valid for one Dogsled attempt: the loader does not refresh or
reconnect with it, and an expired token or closed connection fails the attempt
so the next attempt can provide a current token. WIF cannot be combined with
OAuth, PAT, or RSA fields. The token is treated as a known secret and is
redacted from connection errors, logs, and results.

Username is required for all Snowflake auth variants; set `connection.user_env` on the integration.

### Snowflake reserved staging tables

An orchestrator that reserves a Snowflake staging table can pass one
`tableOwnershipMarker` through `EnsureTableOptions` for that stream. The
Snowflake destination stores the marker in the table `COMMENT` at creation
time and verifies the exact value before schema changes, full-refresh table
replacement, truncation, or loading. A collision with an unrelated table
fails without mutating that table.

Reserved staging schemas must already exist. When an ownership marker is
present, the loader never issues `CREATE SCHEMA`; it reports a validation
error if the configured schema is missing. `CREATE TABLE IF NOT EXISTS` with
the marker and the follow-up metadata check make concurrent table creation
safe. A replacement preserves the marker and existing grants.

The standalone loader accepts the same contract as a repeatable
`--stream-table-ownership-marker <stream>:<marker>` option. Programmatic
callers can set `streamTableOwnershipMarkers` in the Snowflake loader config;
the map is keyed by the input stream name and is resolved after any exact
`streamTables` override.

### BigQuery

```yaml
# integrations/bigquery_prod.yml
spec_version: '1'
auth_env_vars: [BIGQUERY_SA_JSON]
type: integration
name: bigquery_prod
source_type: bigquery
connection:
  project_id: my-gcp-project
  dataset: raw
  location: us-central1
auth:
  type: service_account # or `adc` for Application Default Credentials
  credentials: '${{ env.BIGQUERY_SA_JSON }}'
  # Legacy shape (deprecated): credentials_env: BIGQUERY_SA_JSON
```

```yaml
# resources/github/issues.yml — the `load:` block lives inline on the resource
spec_version: '1'
type: resource
name: issues

extract:
  integration: github
  source: { endpoint: /repos/{owner}/{repo}/issues }
  # ...

load:
  integration: bigquery_prod
  overrides:
    schema: raw_github
  defaults:
    load_strategy: merge

schema:
  primary_key: [id]
  columns:
    id:    { type: integer }
    title: { type: string }
```

For projects where every resource shares one destination, declare it once in `extractor.yml.default_load:` instead of repeating on each resource.

```yaml
# extractor.yml
default_load:
  integration: bigquery_prod
  defaults:
    load_strategy: merge
```

### Invocation

```bash
# Normal operation -- load block is resolved from the resource or project config
dogsled extract run --integration snowflake_source orders | dogsled load run

# Ops escape hatch -- override with a load-file
dogsled load run --load-file ./overrides/staging-load.yml
```

When `--load-file` or `--load-integration` is set, explicit connection and authentication flags (such as `--dest` and `--sf-account`) are rejected. Configure those values in the selected integration or load file. Runtime overrides such as `--table-prefix` and `--load-strategy` still apply.

## Load Strategies

The extractor resolves the load strategy for each stream based on resource config and emits it in the SCHEMA message. The loader uses this per-stream strategy automatically — no `--load-strategy` flag needed for normal operation.

| Strategy       | Behavior                                                                                                               | Auto-resolved when                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `append`       | Insert new records                                                                                                     | Incremental resource without primary keys          |
| `merge`        | Upsert by key columns (from SCHEMA `key_properties`)                                                                   | Incremental resource with primary keys             |
| `full_refresh` | Truncate on first flush, then append; Snowflake's default `evolve` behavior can replace a drifted table before loading | Non-incremental resource, or `--full-refresh` flag |

**Strategy resolution order:**

1. CLI `--load-strategy` flag (overrides all streams — emergency escape hatch)
2. SCHEMA `load_strategy` field (per-stream, set by extractor)
3. Fallback: `append`

Schema behavior follows the same precedence, with repeatable
`--stream-schema-behavior <stream:mode>` overrides taking priority over the
global `--schema-behavior` flag and the SCHEMA message. When no override is
provided, the loader's default is `evolve`.

Use `--dry-run` to preview resolved strategies without loading:

```bash
dogsled extract run --integration github | dogsled load run --dest bigquery --dataset-id test --dry-run
```

`full_refresh` truncates destination rows once on the first flush. For
Snowflake, the default `schema_behavior: evolve` also inspects the existing
table and replaces it only when drift is detected, preserving grants with
`COPY GRANTS` and reapplying clustering. `strict` fails on drift and `freeze`
leaves the physical schema unchanged; other destinations retain their own
schema behavior.

Output:

```text
Stream               Strategy        Keys                 Cursor          Cluster
issues               merge           ["id"]               updated_at      ["updated_at","id"]
events               append          []                   —               []
users                full_refresh    ["id"]               —               ["id"]
```

## System Columns

| Column               | Type      | Description                          |
| -------------------- | --------- | ------------------------------------ |
| `_time_extracted`    | TIMESTAMP | When the extractor pulled the record |
| `_dogsled_loaded_at` | TIMESTAMP | When the loader wrote the record     |

## BigQuery Auto-Optimization

Tables are automatically optimized for the access patterns the pipeline produces:

**Partitioning** — New tables are partitioned by `DATE(<column>)`, using `partition_by` when set, otherwise a timestamp `cursor_field`, otherwise `_time_extracted`. Partitioning speeds up time-range queries. MERGE matches existing rows on `key_properties` alone, never on the partition column, because a key's partition value can change between loads.

**Clustering** — Up to 4 cluster columns are derived automatically:

| Priority | Source           | Why                                                                 |
| -------- | ---------------- | ------------------------------------------------------------------- |
| 1        | `cursor_field`   | Data arrives sorted by this — tight clusters for time-range queries |
| 2        | `key_properties` | MERGE ON clause uses these — cluster-level join pruning             |

**Existing tables** — Clustering is updated automatically when it changes (safe, non-destructive). Partitioning cannot be changed after creation.

## BigQuery Setup

### Authentication

The loader uses Google Cloud Application Default Credentials. Choose one:

```bash
# Option 1: User credentials (local dev)
gcloud auth application-default login

# Option 2: Service account key file
dogsled load run --dest bigquery --key-filename ./sa-key.json --dataset-id raw_github

# Option 3: Workload Identity Federation (CI/CD)
# Set GOOGLE_APPLICATION_CREDENTIALS or configure WIF — no flags needed
```

### Dataset

The loader creates both the dataset and tables automatically on first load. To pre-create a dataset manually:

```bash
bq mk --dataset --location=US my-project:raw_github
```

### Full Example

```bash
# 1. Verify connectivity
dogsled load check --dest bigquery --dataset-id raw_github --project-id my-project

# 2. Preview resolved strategies
dogsled extract run --integration github | dogsled load run --dest bigquery --dataset-id raw_github --dry-run

# 3. Run a pipeline (strategy auto-resolved per stream)
dogsled pipeline github issues \
  --dest bigquery \
  --dataset-id raw_github \
  --project-id my-project

# 4. Verify table optimization
bq show --format=prettyjson raw_github.issues | jq '.timePartitioning, .clustering'

# 5. Override strategy for all streams if needed
dogsled pipeline github issues \
  --dest bigquery \
  --dataset-id raw_github \
  --load-strategy full_refresh
```

If `--project-id` is omitted, the loader auto-detects from `gcloud config get-value project` or the service account key file.

## DuckDB Setup

No cloud credentials needed — just provide a file path:

```bash
# Create or append to a local database (strategy auto-resolved per stream)
dogsled pipeline github issues --dest duckdb --db-path ./dev.duckdb

# Query it
dogsled load query "SELECT * FROM main.issues LIMIT 10" --db-path ./dev.duckdb

# Use a custom schema
dogsled pipeline github issues --dest duckdb --db-path ./dev.duckdb --target-schema raw_github
```

## PostgreSQL Setup

```bash
dogsled load run --dest postgres \
  --postgres-host your-host.example.com \
  --postgres-port 5432 \
  --postgres-database mydb \
  --postgres-user myuser \
  --postgres-password "$DB_PASSWORD" \
  --postgres-ssl
```

Use it for services that are compatible with PostgreSQL; see the [connector reference](../../docs/reference/connectors.md).

## MySQL Setup

```bash
dogsled load run --dest mysql \
  --mysql-host your-host.example.com \
  --mysql-port 3306 \
  --mysql-database mydb \
  --mysql-user myuser \
  --mysql-password "$DB_PASSWORD" \
  --mysql-ssl
```

Use it for services that are compatible with MySQL. See [Connectors](../../docs/reference/connectors.md).

## ClickHouse Setup

```bash
dogsled load run --dest clickhouse \
  --clickhouse-host your-clickhouse-host.example.com \
  --clickhouse-port 8443 \
  --clickhouse-database analytics \
  --clickhouse-username default \
  --clickhouse-password "$CLICKHOUSE_PASSWORD" \
  --clickhouse-ssl
```

ClickHouse uses the HTTP interface and keeps `MergeTree` tables. Merge loads use
a staging table, a winners table, and synchronous mutations. Set
`--clickhouse-vector-index` only when the server supports ClickHouse 25.8 or
later.

## Turbopuffer Setup

```bash
dogsled load run --dest turbopuffer \
  --turbopuffer-api-key "$TURBOPUFFER_API_KEY" \
  --turbopuffer-region gcp-us-central1
```

Turbopuffer creates one namespace per destination table. Document IDs are
derived from key columns for merge loads and are random UUIDs for append loads;
merge is an upsert, and `full_refresh` deletes the namespace once per run.

## Schema Evolution

- New columns in SCHEMA messages are automatically added via `ALTER TABLE`.
- Column type changes produce an error (must be resolved manually).
- System columns are added to existing tables on first load.
- Snowflake `full_refresh` resources with the default `schema_behavior: evolve`
  replace a drifted table before loading and preserve grants; `strict` fails on
  drift and `freeze` leaves the physical schema unchanged. Other destinations
  must reconcile drift using their own migration tooling.

## Protocol

The loader reads the Dogsled protocol from stdin:

- **SCHEMA** — Declares stream columns, types, key properties, `load_strategy`, and optional `cursor_field`
- **RECORD** — Individual data records (buffered to temp JSONL)
- **BATCH** — Pointers to pre-created batch files (JSONL or Parquet; JSONL remains the default)
- **STATE** — Checkpoint messages, forwarded to stdout after flushing

## Programmatic Usage

```typescript
import { runLoader, runDatabaseLoader } from '@bobsled-inc/loader';

// Strategy auto-resolved from SCHEMA messages (no loadStrategy needed)
const result = await runDatabaseLoader({
  dest: 'duckdb',
  dbPath: './my.duckdb',
  targetSchema: 'main',
  bufferSize: 10000,
});

console.log(result.streamsLoaded); // Map<string, number>

// Override all streams (emergency escape hatch)
const lakeResult = await runDatabaseLoader({
  dest: 'ducklake',
  catalogUrl: 'ducklake:./catalog.db',
  attachAlias: 'lake',
  targetSchema: 'main',
  bufferSize: 10000,
});

console.log(lakeResult.streamsLoaded); // Map<string, number>

// Override all streams (emergency escape hatch)
const result2 = await runDatabaseLoader({
  dest: 'bigquery',
  datasetId: 'raw_github',
  loadStrategy: 'full_refresh', // overrides per-stream strategies
  bufferSize: 10000,
});
```

## Development

```bash
pnpm --filter @bobsled-inc/loader build
pnpm --filter @bobsled-inc/loader typecheck
pnpm --filter @bobsled-inc/loader lint
pnpm --filter @bobsled-inc/loader test
```

Named integrations and load files retain their configured connection, namespace and
authentication. Runtime flags such as `--table-prefix`, `--load-strategy`, buffer
limits and per-stream overrides are accepted. Explicit connection/authentication
flags (including `--target-schema`, `--dataset-id` and `--sf-password`) are rejected
with exit code 2; edit the integration or select another one instead.

### Optional driver security minimums

Install `mysql2 >=3.22.0` for MySQL and `snowflake-sdk >=3.4.0` for Snowflake.
Dogsled checks the installed driver version before loading either SDK, including
connectivity checks. Unsupported versions fail before opening a connection;
upgrade the driver in the project that runs Dogsled.

See [installed dependency security](../../docs/dependency-security.md) for the full
driver minimums and installation contract.
