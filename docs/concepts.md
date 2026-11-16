# Concepts

A Dogsled project is a folder of YAML and Markdown files. The `dogsled` command line
reads those files and does three kinds of work: it **extracts** records from
sources, **loads** them into a destination, and builds **models** on top of the
loaded tables. This page explains the pieces and how they connect.

```text
integration + resource ──extract──▶ protocol messages ──load──▶ destination tables
                                                                       │
                                     source ──▶ model ──▶ model ──▶ tables and views
```

## Project files

Every file declares what it is with a top-level `type`, or gets it from the folder
it sits in:

| Folder                               | `type`                         | What it describes                                                         |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------- |
| `integrations/`                      | `integration` or `source`      | How to connect to an API, database, file store or MCP server.             |
| `resources/<integration>/`           | `resource`                     | One thing to read from an integration, which becomes one table.           |
| `sources/`                           | `source`                       | A table that models read, or an API resource that queries read on demand. |
| `models/`                            | `model`                        | A table or view built from sources and other models.                      |
| `seeds/`                             | `seed`                         | A small CSV file loaded as a table.                                       |
| `metrics/`, `relationships/`, `vqs/` | `metric`, `relationship`, `vq` | Meaning: aggregates, joins and verified queries.                          |
| `actions/`, `syncs/`                 | `action`, `sync`               | Writing to other systems.                                                 |
| `targets/`                           | `target`                       | A Snowflake or BigQuery destination for `load run --load-file`.           |
| `entity-graph/`                      | `resolution` and others        | Entity resolution specs.                                                  |
| `skills/`                            | Markdown                       | Instructions for coding agents.                                           |

Some files have fixed names: `bobsled.yml` (pipelines, destinations and AI model
roles), `extractor.yml` and `model-spec.yml` (folder settings), `extract-intents.yml`
(plans for paid APIs), `AGENTS.md` (the Project guide) and `.bobsled/config.yml`
(local settings). A file's `name` is its identity, so files can live in nested
folders. The [project file reference](reference/project-files.md) lists every field.

## Integrations and resources

An **integration** holds what every request to one system shares: the base URL or
connection, authentication, retries and rate limits. Secrets are never written in
these files; they are environment variable references such as
`${{ env.STRIPE_API_KEY }}`.

A **resource** describes one endpoint, table, file pattern or MCP tool: how to call
it, how to paginate, which fields to keep and their types, the primary key, and how
to read only what changed (incremental cursors). Dogsled ships 83
[library integrations](reference/connectors.md#library-integrations) with their
resources; your own files override them by name.

## The protocol

`dogsled extract run` writes newline-delimited JSON messages to standard output:
`SCHEMA` (columns and keys of a stream), `RECORD` (one row), `STATE` (where the
extraction stopped) and `BATCH` (a pointer to a file of records). Logs and metrics go
to standard error. `dogsled load run` reads the same messages, so the two connect
with a pipe, and `dogsled embed` can sit between them. See the
[protocol reference](reference/protocol.md).

## Destinations and load strategies

A **destination** is where `load run` writes: DuckDB, DuckLake, SQLite, PostgreSQL,
Snowflake, BigQuery, MySQL, SQL Server, Databricks, ClickHouse, vector stores, or
files locally, in S3 or in Google Cloud Storage. Each stream becomes a table and is
loaded with a strategy: `append`, `merge` (upsert on the primary key) or
`full_refresh`.

## State

Incremental resources remember the highest cursor value they have seen, in
`.extractor/state.json` by default, so the next run asks only for changes. State is
saved with `--advance-state`, or after a successful `dogsled pipeline` or
`dogsled runner run`.

## Pipelines

A **pipeline** in `bobsled.yml` names a source integration, its resources and one or
more destinations. `dogsled runner run <pipeline>` runs it. Dogsled Core has no
scheduler: the `schedule` field is for whatever runs your jobs.

## Sources and models

A **source** declares a table that already exists in a warehouse, through a model
integration that says which warehouse and schema to use. A **model** is a YAML file
with a source, columns written as SQL expressions, and a materialization (view,
table, incremental and others). Dogsled compiles models to the warehouse's SQL
dialect, orders them by their references, and runs them. Agentic models
(`model_kind: agentic`) send prepared rows to an AI executor and store typed
results.

The word _source_ appears in a few places with different meanings. `source_type` in
an integration names the kind of system, such as `api`, `local` or `postgres`. A
file in `sources/` declares a table for models. A pipeline's `source:` names the
integration it extracts from. A database resource's `extract.source` names the table
or SQL query to read.

## The semantic model

A project's semantic model is the context around its models: `description` and
`ai_context` on sources, models, columns, metrics and relationships, plus metrics,
relationships, verified queries and entities. It lives in the same YAML files as the
models and in the `metrics/`, `relationships/` and `vqs/` folders; there is no
separate semantic model file. See [Semantic model](guides/semantic-model.md).

## The entity graph

The entity graph resolves records from several sources into entities with stable
IDs, and serves them through SQL, a generated TypeScript SDK, an HTTP API or an MCP
server.

## Guidance for agents

A root `AGENTS.md` explains the project's data, and `skills/<name>/SKILL.md` files
teach agents specific tasks. Dogsled validates both and links skills where Codex and
Claude look for them.

## Output and exit codes

Commands print text in a terminal. `--json`, and on many commands `--yaml`, prints
machine-readable output instead; several commands, such as `doctor`, `init` and
`query`, also switch to JSON on their own when their output is piped or `CI` is
set. Extraction logs on standard error are JSON lines unless you pass
`--log-format pretty`. Exit codes are `0` for success, `1` for a runtime failure,
`2` for a validation failure and `3` for detected drift.
