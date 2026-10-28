# Examples

Runnable example projects with fictional data. Each folder has a README that walks
through it.

## Showcases

These examples have an automated check (`showcase.mjs`) that runs in CI without any
account or credentials. From a source checkout, with Node.js 24 or later, pnpm and
Docker:

```bash
pnpm run setup
pnpm exec playwright install chromium
pnpm e2e
```

Run one with `pnpm e2e:<name>`, for example `pnpm e2e:golden-path-quickstart`. On
Linux, install `strace` and OpenSSL as well. Docker runs a temporary PostgreSQL
server for the examples that need one.

| Example                                           | What it shows                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [golden-path-quickstart](golden-path-quickstart/) | CSV files loaded into DuckLake, a SQL model, a local API source and `source-query`           |
| [mock-api-pipeline](mock-api-pipeline/)           | An authenticated HTTPS API with pagination, batching and resource selection                  |
| [incremental-cursors](incremental-cursors/)       | A saved cursor and two incremental loads without duplicate rows                              |
| [fan-out](fan-out/)                               | One extraction loaded into DuckDB, PostgreSQL and JSON Lines                                 |
| [models-full](models-full/)                       | Seeds, model dependencies, views, tables, incremental models, expectations and two databases |
| [semantic-layer-vq](semantic-layer-vq/)           | Metrics, relationships and verified queries over an API                                      |
| [doctor-skills](doctor-skills/)                   | Project Skills, the Project guide and `doctor`                                               |
| [osi-roundtrip](osi-roundtrip/)                   | Apache Ossie export and import with equivalent models                                        |
| [postgres-pipeline](postgres-pipeline/)           | Loading into PostgreSQL, timestamps, models and expectations                                 |
| [agentic-mock](agentic-mock/)                     | An agentic model with a test executor, budgets, a crash and a resumed run                    |
| [explorer-smoke](explorer-smoke/)                 | Explorer pages and pipeline-builder export in a browser                                      |
| [multi-warehouse-ecom](multi-warehouse-ecom/)     | A commerce project across DuckDB and PostgreSQL with a cross-engine query                    |
| [secret-redaction](secret-redaction/)             | Secrets never appear in output, errors or saved files                                        |
| [network-audit](network-audit/)                   | The CLI connects only to the services you configure                                          |
| [old-formats](old-formats/)                       | Deprecated field names, conflicts and rejected configuration                                 |

`pnpm e2e:outsider` packs the CLI and installs the tarball in a clean Linux container
with no npm token or workspace, then runs the showcases against that install
(Explorer is not part of the package, so its check is skipped there). Set
`DOGSLED_E2E_CLI` to the absolute path of an installed `bin/cli.mjs` to test another
installation.

## More examples

| Example                                                   | What it shows                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| [first-ingest](first-ingest/)                             | A local PDF and a public API loaded into the same DuckDB file            |
| [agentic-pairs](agentic-pairs/)                           | An agentic model with a real provider executor and a loop executor       |
| [entity-resolution-sdk](entity-resolution-sdk/)           | Entity resolution, document mentions, relationships and a generated SDK  |
| [mixed-models](mixed-models/)                             | One model that joins an API source with tables in two warehouses         |
| [cross-warehouse](cross-warehouse/)                       | Models that read from Databricks and Snowflake and publish to Databricks |
| [multi-connection](multi-connection/)                     | One model project with Snowflake and BigQuery connections                |
| [snowflake-materializations](snowflake-materializations/) | Snowflake views, tables, an incremental model and a dynamic table        |
| [syncs/duckdb-to-webhook](syncs/duckdb-to-webhook/)       | A sync from a DuckDB table to a webhook action                           |
| [fieldroutes](fieldroutes/)                               | Starter models for the FieldRoutes integration                           |

The examples in the second table need your own credentials or warehouses unless
their README says otherwise.
