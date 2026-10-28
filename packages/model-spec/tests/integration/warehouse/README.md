# Warehouse materialization integration tests

These Vitest suites exercise `view`, `table`, and `incremental` merge materializations against real warehouses.

They are skipped unless `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE` is set:

- `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=duckdb`
- `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=snowflake`
- `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=bigquery`
- `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=all`

When a warehouse is enabled, missing credentials are a hard failure inside the worker instead of a silent skip.

Snowflake env:

- `DOGSLED_MODEL_SPEC_SNOWFLAKE_ACCOUNT`
- `DOGSLED_MODEL_SPEC_SNOWFLAKE_USER`
- `DOGSLED_MODEL_SPEC_SNOWFLAKE_PAT`
- `DOGSLED_MODEL_SPEC_SNOWFLAKE_ROLE`
- `DOGSLED_MODEL_SPEC_SNOWFLAKE_WAREHOUSE`
- `DOGSLED_MODEL_SPEC_SNOWFLAKE_DATABASE`

BigQuery env:

- `DOGSLED_MODEL_SPEC_BIGQUERY_PROJECT`
- `DOGSLED_MODEL_SPEC_BIGQUERY_LOCATION` (optional, defaults to `US`)

BigQuery uses Application Default Credentials, so CI should configure `GOOGLE_APPLICATION_CREDENTIALS` through Workload Identity Federation before the tests run.

## Agentic publication

The PostgreSQL suite uses `DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=postgres`. Set
`DOGSLED_MODEL_SPEC_POSTGRES_HOST`, `DOGSLED_MODEL_SPEC_POSTGRES_DATABASE`, `DOGSLED_MODEL_SPEC_POSTGRES_USER`, and
`DOGSLED_MODEL_SPEC_POSTGRES_PASSWORD`. Set `DOGSLED_MODEL_SPEC_POSTGRES_PORT` if the port is not 5432.
Use a dedicated test database. Each test creates and drops a random schema.

The cloud suite tests Snowflake, BigQuery, or Databricks with the same lifecycle:
create a target, recover a committed receipt after local confirmation fails,
then remove one processed key without changing another key.

Set these variables before running the cloud suite:

- `DOGSLED_MODEL_SPEC_AGENTIC_PUBLICATION_INTEGRATION`: absolute path to an external integration YAML file.
- `DOGSLED_MODEL_SPEC_AGENTIC_PUBLICATION_SCHEMA`: existing dedicated test namespace. Use
  `database.schema` for Snowflake, `project.dataset` for BigQuery, or
  `catalog.schema` for Databricks.

The integration file uses the normal connection schema and environment secret
references. Keep credentials outside the repository. Databricks must have the
catalog commits and transaction capabilities required by the publisher.
The test creates a random target and its publication tables. Cleanup drops only
those exact tables; it does not drop the supplied namespace.

From `packages/model-spec`, run:

```sh
pnpm exec vitest run tests/integration/warehouse/cloud-agentic-publication.test.ts
```

Without either cloud variable, the test is skipped. Setting only one variable
fails the test. A skipped test does not prove that the warehouse supports the
publication contract. Configure the integration secrets and both variables in a
credentialed CI job to run this proof for each cloud database.

## Warehouse checkpoints

Run the PostgreSQL checkpoint suite with the same `DOGSLED_MODEL_SPEC_POSTGRES_*` variables and
`DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE=postgres`. It creates and drops random test schemas.

For Snowflake, BigQuery, or Databricks, set:

- `DOGSLED_MODEL_SPEC_CHECKPOINT_INTEGRATION`: external integration YAML path.
- `DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA`: dedicated schema name inside the integration's database or catalog.

Then run `cloud-checkpoint-store.test.ts`. It creates and drops only the exact
run tables for a random test execution. It does not drop the configured schema.
Both settings are required when either is present. Keep credentials outside the
repository. This test checks checkpoint durability and ownership with a fake
executor. It does not call an LLM.
