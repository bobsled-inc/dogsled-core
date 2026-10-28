# Dogsled documentation

Commands in these pages are shown as `dogsled`. If you installed Dogsled into a
project folder, as [Get started](getting-started.md) does, run them as
`npx dogsled`.

## Start here

- [Get started](getting-started.md): install Dogsled, load a CSV file and a public
  API into DuckDB, and build your first model.
- [Concepts](concepts.md): integrations, resources, the protocol, destinations,
  state, pipelines, sources and models.

## Guides

Extract:

- [Extract from an API](guides/extract-from-an-api.md): authentication,
  pagination and incremental loads for a REST API.
- [Use library integrations](guides/use-library-integrations.md): run, customize or
  generate integrations.
- [Extract from files](guides/extract-from-files.md): CSV, JSON Lines, Parquet and
  documents, locally or in cloud storage.
- [Extract from databases](guides/extract-from-databases.md): PostgreSQL, MySQL,
  Snowflake, BigQuery and others.
- [Extract from MCP servers](guides/extract-from-mcp.md): call MCP tools as
  resources.
- [Paid enrichment APIs](guides/billable-extracts.md): plans and cost estimates.

Load and run:

- [Load data](guides/load-data.md): destinations, load strategies and checks.
- [Run pipelines](guides/run-pipelines.md): `dogsled.yml`, fan-out and scheduling.
- [Run in production](guides/run-in-production.md): GitHub Actions, systemd and
  containers, credentials, incremental state and alerts.

Model and query:

- [Build models](guides/build-models.md): SQL models, materializations, seeds,
  tests and lineage.
- [Agentic models](guides/agentic-models.md): typed results from an AI
  executor, with resumable runs.
- [Semantic model](guides/semantic-model.md): descriptions and AI context, metrics,
  relationships, verified queries and Apache Ossie.
- [Query data](guides/query-data.md): SQL, API-backed sources and verified queries.
- [Entity graph](guides/entity-graph.md): resolve records into entities and serve
  them.
- [Embeddings and AI providers](guides/embeddings-and-ai.md): model roles,
  provider checks and embeddings.

Work with agents and other systems:

- [Project guide and skills](guides/project-skills.md): `AGENTS.md` and Project
  Skills.
- [Send data to other systems](guides/syncs-and-actions.md): actions and syncs.
- [Set up a project and check its health](guides/setup-and-doctor.md): `setup`
  and `doctor`.

More:

- [Explorer](guides/explorer.md): the local web app.
- [Tutorial and examples](guides/learn-and-examples.md): `dogsled learn` and the
  example projects.
- [Dogsled Cloud and Core](guides/dogsled-cloud.md): fields that only Dogsled Cloud
  reads.

## Reference

- [CLI](reference/cli.md): every command and flag.
- [Project files](reference/project-files.md): every file and its fields.
- [Connectors](reference/connectors.md): integrations, source types, destinations
  and warehouses.
- [Environment variables](reference/environment-variables.md).
- [Protocol](reference/protocol.md): the messages between extract and load.

## Advanced reference

The pages in `reference/advanced/` are older and more detailed than the guides,
and are written for operators and coding agents. If one of them disagrees with a
guide, the guide is right.

- Models: [agentic model fields](reference/advanced/agentic-model-reference.md),
  [operating agentic models](reference/advanced/agentic-model-operations.md),
  [data tests and contracts](reference/advanced/data-tests-and-contracts.md) and
  [lineage](reference/advanced/lineage-guide.md).
- Publishing across warehouses: [cookbook](reference/advanced/cross-warehouse-cookbook.md),
  [data flow and residency](reference/advanced/cross-warehouse-data-flow.md) and
  [limitations](reference/advanced/cross-warehouse-limitations.md).
- Entity graph: [authoring](reference/advanced/entity-graph-authoring-guide.md),
  [workflow diagrams](reference/advanced/entity-graph-workflow-diagrams.md),
  [stable entity IDs](reference/advanced/entity-graph-stable-entity-ids.md),
  [column lineage](reference/advanced/entity-graph-lineage-guide.md),
  [external reviewers](reference/advanced/entity-graph-reviewer-contract.md),
  [mention extraction](reference/advanced/mention-extraction.md),
  [relationship extraction](reference/advanced/relationship-extraction.md),
  [typed SDK generation](reference/advanced/sdk-codegen.md),
  [MCP document reads](reference/advanced/mcp-read-source.md) and
  [Claude Code routines](reference/advanced/claude-code-routines-entity-graph.md).
- Staging: [private Blob CSV to Snowflake](reference/advanced/private-blob-snowflake-staging.md).
- Upgrades: [bundler-safe project validation](migrations/2026-08-28-bundler-safe-project-validation.md).

## Project policies

- [Releases](releases.md) and [installed dependency security](dependency-security.md).
- [Privacy guard](privacy-guard.md) for contributors.
- [Contributing](../CONTRIBUTING.md), [security](../SECURITY.md) and
  [privacy](../PRIVACY.md).
