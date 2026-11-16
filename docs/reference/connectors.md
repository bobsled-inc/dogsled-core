# Connectors

This page lists what Bobsled Core can read from and write to. Each section links to the
guide that shows how to use it.

## Library integrations

Bobsled Core ships 83 ready-made integrations. Run `bobsled integrations list` for the
current list with resource counts, and `bobsled integrations show <name>` for the
resources and credentials of one. See
[Use library integrations](../guides/use-library-integrations.md).

| Category        | Integrations                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| analytics       | `amplitude`, `bigquery`, `google_analytics`, `google_search_console`, `mixpanel`, `posthog`, `segment`, `snowflake`                                                                                                             |
| cloud-infra     | `cloudflare`, `datadog`, `pagerduty`, `vantage`, `vercel`                                                                                                                                                                       |
| communication   | `front`, `gong`, `pylon`, `slack`, `twilio`, `zoom`                                                                                                                                                                             |
| crm             | `apollo`, `close_crm`, `datagma`, `findymail`, `freshsales`\*, `greenhouse`, `hubspot`, `hunter`, `intercom`, `leadmagic`, `lever`, `outreach`, `peopledatalabs`, `pipedrive`, `salesforce`                                     |
| developer-tools | `bobsled_api`, `circleci`, `exa`, `github`, `gitlab`, `langsmith`, `launchdarkly`, `linear`, `sentry`                                                                                                                           |
| finance         | `brex`, `chargebee`, `quickbooks`, `recurly`, `stripe`, `xero`, `zuora`                                                                                                                                                         |
| marketing       | `customer_io`, `facebook_ads`, `facebook_pages`, `google_ads`, `instagram`, `klaviyo`, `linkedin_ads`, `mailchimp`, `marketo`, `pinterest_ads`\*, `sendgrid`, `shopify`, `smartlead`, `snapchat_ads`, `tiktok_ads`\*, `twitter` |
| productivity    | `airtable`, `bamboohr`, `calendly`, `confluence`, `fieldroutes`, `google_drive`, `google_sheets`, `jira`, `notion`, `typeform`                                                                                                  |
| support         | `freshdesk`, `helpscout`, `servicenow`, `zendesk`                                                                                                                                                                               |
| task-management | `asana`, `clickup`, `monday`                                                                                                                                                                                                    |

\* Marked "untested with the live API": the integration validates and passes its
recorded fixtures, but has not been run against the provider.

`bobsled_api` reads the data shares of a data-sharing account (its `shares`
resource). Run `bobsled integrations show bobsled_api` for its settings.

`bigquery` and `snowflake` read through local MCP servers and `google_drive`
through an MCP server over HTTP; `linear` and `notion` offer MCP next to their
GraphQL or REST API. Seven integrations call paid
APIs and run only through a plan: see [Paid enrichment APIs](../guides/billable-extracts.md).

## Source types

| Kind                     | `source_type`                                                          | Guide                                                                                |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| REST and GraphQL APIs    | `api` (or a `type: source` integration with `http` transports)         | [Extract from an API](../guides/extract-from-an-api.md)                              |
| Files                    | `local`, `s3`, `gcs`, `sftp`, `vercel_blob`                            | [Extract from files](../guides/extract-from-files.md)                                |
| Databases and warehouses | `postgres`, `mysql`, `redshift`, `clickhouse`, `snowflake`, `bigquery` | [Extract from databases](../guides/extract-from-databases.md)                        |
| Lakehouse tables         | `iceberg`, `delta`                                                     | [Extract from databases](../guides/extract-from-databases.md#iceberg-and-delta-lake) |
| MCP servers              | `type: source` with `mcp_http` (or reviewed `mcp_stdio`) transports    | [Extract from MCP servers](../guides/extract-from-mcp.md)                            |

File formats: `csv`, `jsonl` and `parquet` (CSV and JSON Lines also gzip-compressed),
and documents: `pdf`, `docx`, `pptx`, `html`, `md`, `txt` and `eml`.

## Destinations

`bobsled load run --dest` accepts:

| Destination                                   | Value                  | Driver package                                |
| --------------------------------------------- | ---------------------- | --------------------------------------------- |
| Local files (JSON Lines, CSV, Parquet, Arrow) | `local`                | —                                             |
| Amazon S3, Google Cloud Storage               | `s3`, `gcs`            | `@aws-sdk/client-s3`, `@google-cloud/storage` |
| DuckDB, DuckLake                              | `duckdb`, `ducklake`   | —                                             |
| SQLite                                        | `sqlite`               | `better-sqlite3`                              |
| PostgreSQL, pgvector                          | `postgres`, `pgvector` | `pg` (installed with Bobsled Core)                 |
| Snowflake                                     | `snowflake`            | `snowflake-sdk`                               |
| BigQuery                                      | `bigquery`             | `@google-cloud/bigquery`                      |
| MySQL                                         | `mysql`                | `mysql2`                                      |
| SQL Server                                    | `mssql`                | `tedious`                                     |
| Databricks                                    | `databricks`           | `@databricks/sql`                             |
| ClickHouse                                    | `clickhouse`           | `@clickhouse/client`                          |
| Elasticsearch                                 | `elasticsearch`        | —                                             |
| Chroma                                        | `chroma`               | `chromadb`                                    |
| Turbopuffer                                   | `turbopuffer`          | `@turbopuffer/turbopuffer`                    |

For a service that is compatible with PostgreSQL or MySQL, use that destination.
`bobsled.yml` pipelines accept a subset: `duckdb`, `bigquery`, `snowflake`,
`postgres`, `mysql`, `databricks`, `clickhouse`, `turbopuffer`, `local`, `gcs` and
`s3` (see [Run pipelines](../guides/run-pipelines.md#destination-types)). The flags
for each destination are in the [CLI reference](cli.md#bobsled-load-run).

## Model warehouses

SQL models run on DuckDB, PostgreSQL, Snowflake, BigQuery, Databricks and
ClickHouse (`source_type` of the model integration). `bobsled model compile` and
`seed load --dialect` also produce SQL for MySQL, Redshift and pgvector. See
[Build models](../guides/build-models.md).

## AI providers

`amazon-bedrock`, `openai`, `anthropic`, `google`, `openrouter`, `ai-gateway`,
`ollama`, and `typesafe` for classification. See
[Embeddings and AI providers](../guides/embeddings-and-ai.md).
