# Dogsled Cloud and Core

Dogsled Cloud is the hosted product built on Bobsled Core. It runs the same project
files and adds a web app and an AI assistant for building and running pipelines.
Cloud also provides scheduling, background agents, access control, and audit for teams.
In Cloud, a project is called a Blueprint.

A Blueprint uses the file formats described in these docs. A few fields only mean
something to an orchestrator such as Cloud. Core validates them and leaves them
alone, and refuses to run anything that depends on them. This page lists them.

## Managed destinations

In Cloud, a destination can point at a connection that Cloud manages instead of
naming a warehouse. For example, in the `shop` project from
[Run pipelines](run-pipelines.md), the `warehouse` destination in `bobsled.yml`
could be:

```yaml
destinations:
  warehouse:
    type: bobsled_managed
    bobsled_connection_ref: analytics-prod
```

`bobsled_connection_ref` names the connection in Cloud. `runner validate` accepts
this destination, but Core cannot load into it:

```bash
bobsled runner validate
bobsled runner run shop_files || echo "exit code $?"
```

```text
✓ Configuration is valid
A "bobsled_managed" destination only runs in Dogsled Cloud. To run this pipeline with Bobsled Core, replace it with a concrete destination type such as "duckdb" or "bigquery".
exit code 2
```

To run the project with Core, replace the destination with a concrete one, for
example `type: duckdb` with a `db_path`, or `type: bigquery` with its connection
fields. A pipeline-level
`destination_warehouse` is only valid with a single `bobsled_managed` destination.

## Extension keys

Specs may carry metadata for the orchestrator that runs them. Keys that start with
`x-`, `dogsled_` or `bobsled_` pass validation on sources, integrations and destinations; <!-- rename:keep -->
Core does not read them, and on a concrete destination it drops them. Any other unknown
key is still an error, so typos fail.

## Field name spellings

Blueprints may use either spelling of the host fields, and Core reads both with no warning: `dogsled_connection_ref` or `bobsled_connection_ref`, `dogsled_source_kind` or `bobsled_source_kind`, and `type: dogsled_managed` or `type: bobsled_managed`. <!-- rename:keep -->

If a file sets both spellings of a field to different values, validation fails
with `LEGACY_KEY_CONFLICT`. The retired `type: bobsled_lakehouse` is still rejected.

## Models and entity-graph pipelines

Pipelines with `type: models` or `type: entity-graph` are schedules for an
orchestrator. Core validates them; run their work yourself with `bobsled model run`
or `bobsled entity-graph build`. See [Run pipelines](run-pipelines.md).

## Embedding Bobsled Core in a host

A host application can use Core as a library. The package exports, among others,
`@bobsled-inc/bobsled-core/pipeline` (run pipelines), `/manifest` (a portable pipeline
manifest for an orchestrator), `/project-index` (classify project files),
`/model-spec/project` (run models), `/source-query`, `/project-skills` and
`/connections`.
