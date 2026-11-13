# Project files

This page lists the files in a Dogsled project and their fields. The guides show
each file in use; this page is for looking things up. `dogsled doctor` and the
`validate` commands report any field that is missing, misspelled or of the wrong
type.

## How Dogsled finds files

Dogsled reads YAML and Markdown files anywhere under the project root, skipping
hidden folders and `node_modules`. A file's kind comes from its top-level `type`
field or, when there is none, from the nearest conventional folder in its path:
`integrations`, `resources`, `sources`, `models`, `seeds`, `metrics`,
`relationships`, `vqs`, `actions`, `syncs`, `targets`, `agents`, `entity-graph` and
`skills`. A file's identity is its `name`, so a project can nest domains in folders.

Files with fixed names at the root:

| File                                  | Kind                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `dogsled.yml` or `dogsled.yaml`       | Pipelines, destinations, AI model roles. A file elsewhere with `type: pipeline_config` adds to it. |
| `extractor.yml`                       | Extraction folder settings.                                                                        |
| `model-spec.yml` or `model-spec.yaml` | Model folder settings.                                                                             |
| `extract-intents.yml` or `.yaml`      | Plans for paid APIs.                                                                               |
| `AGENTS.md`                           | The Project guide.                                                                                 |
| `skills/<name>/SKILL.md`              | A Project Skill.                                                                                   |

`.dogsled/config.yml` holds local settings and is not a project file.

## dogsled.yml

| Key               | Description                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `destinations`    | Named destinations (below). Required when the file has extract pipelines.                                                                                           |
| `pipelines`       | Named pipelines (below).                                                                                                                                            |
| `defaults`        | `timeout` (default `4h`), `retry.attempts`, `retry.backoff` (`exponential`, `linear`, `fixed`), and `models.schedule`. For orchestrators; Core does not apply them. |
| `platform.models` | [AI roles](../guides/embeddings-and-ai.md): `auth_env_vars` permits custom key names (also in embed configs). Standard names work by default.                       |
| `platform.budget` | `ai_cost_daily_usd`, `per_source_rpm`.                                                                                                                              |

Secrets in `dogsled.yml` must be environment references (`$NAME`). Each destination declares its referenced names in `auth_env_vars`.

### Destinations

| `type`            | Fields                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duckdb`          | `db_path`, `schema`                                                                                                                                                                                                                      |
| `bigquery`        | `project`, `dataset`, `location`, `credentials_secret`, `credentials_access_token`, `credentials_token_command`                                                                                                                          |
| `snowflake`       | `account`, `username`, `warehouse`, `database`, `schema`, `role`, and one of `password`, `private_key_path` (+ `private_key_passphrase`), `credentials_access_token`, `credentials_token_command`, `credentials_workload_identity_token` |
| `postgres`        | `host`, `port`, `database`, `schema`, `username`, `password`, `ssl`                                                                                                                                                                      |
| `mysql`           | `host`, `port`, `database`, `user`, `password`, `ssl`                                                                                                                                                                                    |
| `databricks`      | `server_hostname`, `http_path`, `catalog`, `schema`, and `credentials_access_token` or `oauth_client_id` + `oauth_client_secret`                                                                                                         |
| `clickhouse`      | `host`, `port`, `database`, `username`, `password`, `ssl`, `vector_index`                                                                                                                                                                |
| `turbopuffer`     | `api_key`, `region`, `namespace_prefix`, `distance_metric`, `full_text_columns`                                                                                                                                                          |
| `local`           | `format` (`parquet`, `jsonl`, `csv`), `stream_subfolder`                                                                                                                                                                                 |
| `gcs`, `s3`       | `bucket`, `prefix`, `format`, `stream_subfolder`                                                                                                                                                                                         |
| `dogsled_managed` | `dogsled_connection_ref` (Dogsled Cloud only; see [Dogsled Cloud and Core](../guides/dogsled-cloud.md))                                                                                                                                  |

Every destination also accepts `load_strategy`, `schema_behavior` and
`table_prefix`.

The file destinations `local`, `gcs` and `s3` write each stream to
`<prefix><stream>/<stream>-<n>.<ext>`. The optional `stream_subfolder` field changes
that. It adds a folder inside each stream's folder, so a file lands at
`<prefix><stream>/<stream_subfolder>/<stream>-<n>.<ext>`. With
`stream_subfolder: data/2026-11-20`, the stream `orders` writes
`orders/data/2026-11-20/orders-0.parquet`. It takes a relative path of up to 256
characters. Each segment holds letters, digits, dots, dashes, equals signs or
underscores, and is never `.` or `..`. It can also be an environment placeholder.

Leave it out and the output is unchanged.

### Pipelines

Extract pipelines (`type: extract`, the default) take `schedule`, `source`,
`destination` or `destinations`, `resources`, and optionally `description`,
`inputs`, `enabled`, `load_strategy`, `schema_behavior`, `table_prefix`,
`buffer_size`, `embed`, `via`, `warehouse` and `destination_warehouse`. An entry in
`resources` is a name or an object with `resource` and per-resource overrides:
`load_strategy`, `schema_behavior`, `table`, `inputs`, `input_matrix`, `via`.

`type: models` pipelines take `connection`, `models` (a list or `'*'`) and
`schedule`; `type: entity-graph` pipelines are similar for entity resolution. See
[Run pipelines](../guides/run-pipelines.md).

## extractor.yml

All fields are optional: `integrations_dir` (default `integrations`),
`resources_dir` (`resources`), `state_dir` (`.extractor`), `output_dir` (`output`),
`batch_dir` (`batch`), `default_batch_format` (`jsonl` or `parquet`),
`default_output` (`stdout` or `file`) and `default_load` (an `integration` with
optional `overrides` and `defaults`, used by `load run` when a resource has no
`load` block).

## model-spec.yml

Optional folder settings: `sources_dir`, `models_dir`, `seeds_dir`,
`entity_graph_dir` (default `entity-graph`), `integrations_dir`, `targets_dir`,
`metrics_dir`, `relationships_dir`, `vqs_dir`, and `checkpoint_store`
(`integration`, `schema`, `lease_seconds`, and `retention_days` for DuckDB) for
agentic model checkpoints in a warehouse or DuckDB file.

## Integrations

| Kind                     | Shape                                                                                                                                                             | Guide                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| HTTP API                 | `spec_version: '1'`, `type: integration`, `name`, `transport` with `base_url` (HTTPS), `auth`, `headers`, `optional_headers`, `timeout_ms`, `retry`, `rate_limit` | [Extract from an API](../guides/extract-from-an-api.md)            |
| Several transports, MCP  | `spec_version: '2'`, `type: source`, `name`, `transports` (each with an `id` and a `type`: `http`, `mcp_http` or `mcp_stdio`), `default_transport`                | [Extract from MCP servers](../guides/extract-from-mcp.md)          |
| Files                    | `source_type` (`local`, `s3`, `gcs`, `sftp`, `vercel_blob`), `connection`, `auth`                                                                                 | [Extract from files](../guides/extract-from-files.md)              |
| Databases for extraction | `source_type` (`postgres`, `mysql`, `redshift`, `clickhouse`, `snowflake`, `bigquery`, `iceberg`, `delta`), `connection`, `auth`, `ssl`                           | [Extract from databases](../guides/extract-from-databases.md)      |
| Warehouses for models    | `source_type` (`duckdb`, `postgres`, `snowflake`, `bigquery`, `databricks`, `clickhouse`), `connection`, `auth`                                                   | [Build models](../guides/build-models.md#connect-to-the-warehouse) |

Every integration kind accepts `auth_env_vars`, the names permitted in environment placeholders and `*_env` fields.

Authentication and pagination types are listed in
[Extract from an API](../guides/extract-from-an-api.md#authentication-types).

## Resources

| Kind                | Main fields                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API            | `spec_version`, `type: resource`, `name`, `integration`, `description`, `input`, `api` (`endpoint`, `method`, `query_params`, `headers`, `request_body`), `output`, `extract` (`record_path`, `pagination`, `incremental`, `table`), and optional `lookup`, `query`, `billing`, `load` |
| MCP tool            | `type: resource`, `name`, `via`, `tool` (`tool_name`, `arguments`), `input`, `output`, `extract`                                                                                                                                                                                       |
| Files and documents | `source` (`path`, `format`, `options`, `compression`, `parse`, `chunk`, `embedding`, `ingest`, `permissions`), `replication`, `limits`, `output`, `extract.table`                                                                                                                      |
| Database table      | `extract` (`integration`, `source`, `replication`), `schema` (`primary_key`, `columns`), optional `load`                                                                                                                                                                               |

`output` maps each column to a `type` (`string`, `integer`, `number`, `boolean`,
`timestamp`, `array`, `object`) and, for APIs, a JSONPath `path`.

## Sources

`spec_version: '0.2'`, `type: source`, `name`, `description` and `schema.columns`,
plus either:

- `source_type: warehouse_table` with `connection` (a model integration) and
  `table`; or
- `source_type: api_resource` with `integration`, `resource`, `connection` (the
  model integration that caches it), `mode` (`live`, `lazy`, `extract`), `max_age`,
  `filter` and `refresh`.

Sources and their columns also take `ai_context` and `synonyms`. See
[Semantic model](../guides/semantic-model.md#synonyms).

## Models

`spec_version: '0.2'`, `type: model`, `name`, `description`, `grain`, `source`,
`columns` and `materialization` are the core fields. Columns take `name`, `expr`,
`type`, `primary_key`, `not_null`, `ai_context` and `synonyms`. Models also take
`ai_context` and `synonyms`, and `derived_columns` entries take `synonyms`. Other fields: `joins`, `include_all_columns`,
`exclude_columns`, `distinct`, `group_by`, `where`, `having`, `qualify`, `dedupe`,
`order_by`, `windows`, `limit`, `offset`, `derived_columns`, `flatten_json`,
`pivot`, `unpivot`, `union`, `recurse`, `hierarchy`, `target_schema`,
`target_database`, `pre_hook`, `post_hook`, `tests`, `expect`, `tags`, `owner`,
`trust_tier`, `execution` and `variables`. Agentic models use
`model_kind: agentic` with their own fields: see
[Agentic models](../guides/agentic-models.md).

## Seeds, metrics, relationships, verified queries

| `type`         | Fields                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed`         | `name`, `description`, `payload` (`format`, `path`, `delimiter`), `schema.columns`, `materialization` (`type: table`, `target_schema`, `on_conflict`), `validation` (`max_rows`, `required_columns`, `unique_columns`) |
| `metric`       | `name`, `description`, `model` or `models`, `expression`, `datatype`, `synonyms`, `tags`                                                                                                                               |
| `relationship` | `name`, `left_model`, `right_model`, `join_columns` (`left`, `right`), `relationship_type` (`one_to_one`, `one_to_many`, `many_to_one`, `many_to_many`), `join_type`                                                   |
| `vq`           | `name`, `nlq` (the question), `sql`, `parameters` (`name`, `type`: `string`, `integer`, `number`, `boolean`, `timestamp`, `date`; `required`, `default`), `connection`                                                 |

## Actions and syncs

| `type`   | Fields                                                                                                                                                                                                                                                                                                                                                | Guide                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `action` | `name`, `transport` (`api` or `webhook`), `integration`, `description`, `tags`, `input`, webhook-only `auth_env_vars` (permitted env names), and the transport block, such as `webhook` (`url`, `method`, `request_body`)                                                                                                                             | [Send data to other systems](../guides/syncs-and-actions.md)       |
| `sync`   | `name`, `description`, `schedule`, `source` (`type: projection`, `connection`, `projection_ref`, `cursor`, `filters`), `target` (`action`, `entity_key`, `input_mapping`, `destination_connection`), `options` (`page_size`, `on_record_error`, `consecutive_failure_threshold`, `checkpoint_interval_records`, `lease_ttl_seconds`, `state_backend`) | [Send data to other systems](../guides/syncs-and-actions.md#syncs) |

## Other files

- `type: target`: a named Snowflake or BigQuery load destination for
  `load run --load-file`. Fields: `integration` (a Snowflake or BigQuery
  integration); `overrides` (`role`, `database`, `schema`, `warehouse`, `catalog`);
  `defaults` (`load_strategy`, `schema_behavior` of `evolve`, `strict` or `freeze`,
  `target_schema_template`, `buffer_size`). Other integration types fail with
  "not supported as a load destination yet". `load run --load-integration <name>`
  uses a Snowflake or BigQuery integration directly, without a target file.
- `extract-intents.yml`: plans for paid APIs; see
  [Paid enrichment APIs](../guides/billable-extracts.md).
- `entity-graph/`: resolution, survivorship, truthset, relationship and policy
  specs; see [Entity graph](../guides/entity-graph.md).
- `agents/`: agent definitions read by Dogsled Cloud. Core recognizes them and does
  not run them.
- `.dogsled/config.yml`: `default_destination` for lazy API sources, with `dest`
  (`ducklake`, `duckdb`, `bigquery` or `snowflake`) and that destination's fields:
  `dbPath`, `catalogUrl`, `targetSchema`, `projectId`, `datasetId`, `account`,
  `username`, `privateKeyPath`, `warehouse`, `database`.
