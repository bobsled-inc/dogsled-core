# Extract from databases

Dogsled reads tables from PostgreSQL, MySQL, Redshift, ClickHouse, Snowflake,
BigQuery, Apache Iceberg and Delta Lake, and loads them anywhere `dogsled load run`
can write. A database resource uses three blocks: `extract` says where to read and
how to replicate, `schema` declares the columns, and an optional `load` block holds
destination overrides.

## Read a PostgreSQL table

The examples read an `app.customers` table:

```sql
CREATE TABLE app.customers (id int PRIMARY KEY, name text, plan text, updated_at timestamptz);
```

Create `integrations/app_db.yml`. Database integrations name the environment
variables that hold the host and credentials:

```yaml
spec_version: '1'
auth_env_vars: [APP_DB_HOST, APP_DB_PASSWORD, APP_DB_USER]
type: integration
name: app_db
source_type: postgres
connection:
  host_env: APP_DB_HOST
  port: 5432
  database: shop
auth:
  type: password
  username_env: APP_DB_USER
  password_env: APP_DB_PASSWORD
```

Create `resources/app_db/customers.yml`:

```yaml
spec_version: '1'
type: resource
name: customers
extract:
  integration: app_db
  source:
    schema: app
    table: customers
  replication:
    method: incremental_merge
    cursor_field: updated_at
schema:
  primary_key: [id]
  columns:
    id: { type: integer }
    name: { type: string }
    plan: { type: string }
    updated_at: { type: timestamp }
```

```bash
export APP_DB_HOST=db.example.com APP_DB_USER=reader APP_DB_PASSWORD=<password>
dogsled extract validate app_db
dogsled extract run --integration app_db customers --advance-state --quiet \
  | dogsled load run --dest duckdb --db-path app.duckdb
dogsled query "SELECT id, name, plan FROM customers ORDER BY id" --db-path app.duckdb
```

```text
[loader] customers: strategy=merge
[loader] customers: loaded 3 rows
...
id	name	plan
1	Ada Labs	pro
2	Grace Corp	free
3	Linus Ltd	pro
```

Dogsled refuses to connect to private and loopback addresses unless you allow it,
which protects shared environments from configuration that points at internal
hosts. To read from a database on your own machine or private network, set
`BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1`.

`source.sql` replaces `source.table` with your own `SELECT`. Use `schema` (or
`dataset` for BigQuery, and `database` where it applies) to qualify the table;
`table` is always a plain name.

## Replication methods

| `replication.method` | What each run reads                                                                                                                                                                                                                                    | Needs                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `full_refresh`       | The whole table                                                                                                                                                                                                                                        | Nothing                              |
| `incremental_append` | Rows with a cursor value above the last run's, appended                                                                                                                                                                                                | `cursor_field`                       |
| `incremental_merge`  | The same rows, merged on the primary key                                                                                                                                                                                                               | `cursor_field`, `schema.primary_key` |
| `change_tracking`    | Changes from the database's change feed: Snowflake streams (`information: default` or `append_only`), BigQuery change history (`appends` or `changes`), PostgreSQL logical replication (`slot_name`, `publication_name`) or the Delta change data feed | `replication.change_tracking`        |

As with APIs, `--advance-state` saves the cursor after a successful extraction.

## Snowflake

```yaml
spec_version: '1'
auth_env_vars:
  [
    SNOWFLAKE_ACCOUNT,
    SNOWFLAKE_DATABASE,
    SNOWFLAKE_PRIVATE_KEY_PATH,
    SNOWFLAKE_ROLE,
    SNOWFLAKE_USER,
    SNOWFLAKE_WAREHOUSE,
  ]
type: integration
name: sf_source
source_type: snowflake
connection:
  account_identifier: ${{ env.SNOWFLAKE_ACCOUNT }}
  user: ${{ env.SNOWFLAKE_USER }}
  role: ${{ env.SNOWFLAKE_ROLE }}
  warehouse: ${{ env.SNOWFLAKE_WAREHOUSE }}
  database: ${{ env.SNOWFLAKE_DATABASE }}
auth:
  type: rsa_key
  private_key_path: ${{ env.SNOWFLAKE_PRIVATE_KEY_PATH }}
```

Create `resources/sf_source/orders.yml`. Snowflake stores unquoted names in
upper case, and Dogsled matches column names exactly, so write them as Snowflake
stores them:

```yaml
spec_version: '1'
type: resource
name: orders
extract:
  integration: sf_source
  source:
    schema: PUBLIC
    table: ORDERS
  replication:
    method: full_refresh
schema:
  primary_key: [ORDER_ID]
  columns:
    ORDER_ID: { type: integer }
    CUSTOMER: { type: string }
    AMOUNT: { type: number }
```

```bash
dogsled extract validate sf_source
dogsled extract run --integration sf_source orders --quiet \
  | dogsled load run --dest duckdb --db-path sf.duckdb
```

```text
[loader] orders: strategy=full_refresh
[loader] orders: loaded 5 rows
```

A column that is not in the table comes through as empty, so if every value is
empty, check the case of the names.

`auth.type` can also be `pat` (programmatic access token), `oauth` or
`workload_identity`. `connection.warehouses` names several warehouses that a
pipeline can choose between.

## BigQuery

```yaml
spec_version: '1'
type: integration
name: bq_source
source_type: bigquery
connection:
  project_ids: [my-project]
  billing_project_id: my-project
  default_location: US
auth:
  type: adc
```

`auth.type` can be `adc` (Application Default Credentials), `service_account`
with `credentials`, `wif`, or `access_token`. BigQuery resources use
`source.dataset` instead of `source.schema`.

## MySQL, Redshift and ClickHouse

These use the same shape as PostgreSQL: `connection.host_env`, `port` and
`database`, and `auth` of type `password` (`username_env`, `password_env`) or
`iam`. Add an `ssl` block with a `mode` and an optional `ca_cert_env`.

## Iceberg and Delta Lake

An `iceberg` integration reads from a REST catalog
(`connection: { mode: rest_catalog, catalog_url }`) or straight from storage
(`{ mode: direct, warehouse_path }`). A `delta` integration reads from
`connection.storage_url`. Both take a `storage` block with S3 or GCS credentials:
`aws_credentials`, `aws_iam`, `gcp_hmac` or `gcp_service_account`.

## Models need their own integration

SQL models connect to the warehouse through an integration as well, but model
integrations use a different set of fields (`connection.host`, `auth.user`). Keep
one integration file for extraction and another for models; see
[Build models](build-models.md#connect-to-the-warehouse).
