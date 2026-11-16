# Bobsled Core

[![CI](https://github.com/bobsled-inc/bobsled-core/actions/workflows/ci.yml/badge.svg)](https://github.com/bobsled-inc/bobsled-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@bobsled-inc/bobsled-core.svg)](https://www.npmjs.com/package/@bobsled-inc/bobsled-core)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Bobsled Core is an open-source command-line toolkit for moving and transforming data.**
Extract data from APIs, files and databases, load it into a database or warehouse,
and build SQL models that produce tables you can query.

Keep your pipelines and your semantic model in the same project. YAML files define
how data moves and changes, alongside descriptions, business metrics, relationships
and example queries that explain what it means. Developers and coding agents can
read, review, validate and run that project from a repository.

[Get started](#getting-started) · [Guided tutorial](#learn-with-your-coding-agent) ·
[Concepts](docs/concepts.md) ·
[Documentation](docs/README.md) · [Examples](examples/README.md)

## When to use Bobsled Core

- **Turn source data into queryable tables.** Load API responses or files into
  DuckDB or a warehouse, then build models for questions such as customer spend.
- **Keep transformations and business definitions together.** Review changes to
  SQL expressions, metric definitions and instructions for interpreting the data
  in the same repository.
- **Work on data projects with a coding agent.** Give the agent project files,
  data context and validation commands to use when it changes a pipeline or model.

Use [extraction and loading](docs/getting-started.md#extract-and-load) and
[modeling](docs/guides/build-models.md) separately or together. For example, build
models on warehouse tables that another tool already loads. Run Core from your
terminal, CI or an existing orchestrator. Core has no built-in scheduler. Use
cron, a workflow or an orchestrator to start recurring jobs.
See [Run pipelines](docs/guides/run-pipelines.md) and
[Run in production](docs/guides/run-in-production.md).

## Getting started

The [ten-minute tutorial](docs/getting-started.md) loads a CSV file into a local
DuckDB database, builds a model and queries it. You need **Node.js 24 or later
and npm**. The exercise needs no Bobsled Core account, AI provider or external warehouse.

Install the `@bobsled-inc/bobsled-core` package and create a project:

```bash
mkdir my-data
cd my-data
npm init -y
npm install @bobsled-inc/bobsled-core
npx bobsled init shop --duckdb
cd shop
npx bobsled doctor
```

These commands create and check an empty project. Continue with
[Add some data](docs/getting-started.md#add-some-data) to load five sample orders
and build the `customer_revenue` model. After completing those tutorial steps,
the model query returns:

| customer | order_count | total_amount |
| -------- | ----------- | ------------ |
| linus    | 1           | 300          |
| ada      | 2           | 162.75       |
| grace    | 2           | 95.75        |

The tutorial then adds a public API without an API key. It includes every project
file, command and expected result.

Installing Bobsled Core into each project keeps its version and warehouse drivers with
that project. Other destinations can require optional drivers and credentials.
See [Load data](docs/guides/load-data.md#install-a-warehouse-driver).
The [installation guide](docs/getting-started.md#install-bobsled-core) also covers global installation.

### Set up your own data with your coding agent

Install the [Bobsled Core plugin for Claude Code or Codex](plugins/bobsled-core/README.md),
open your project folder in the agent, and ask:

> Use bobsled-get-started to install Bobsled Core and set up my project.

The skill checks Node.js 24+ and installs Bobsled Core in your project if needed.
Use **`bobsled-get-started`** to set up your Bobsled Core environment with your own
connections, sources, pipelines and models. It can create a project or continue
an existing one, then validate the setup and help you run a first useful query.

### Learn with your coding agent

The [TV Night guided tutorial](docs/guides/tv-night.md) teaches Bobsled Core through
“What should I watch next?” Connect to a public API, build an ETL pipeline and
semantic models, query across sources, and try an agentic transformation. An
optional chapter teaches entity resolution.

Install the [Bobsled Core plugin for Claude Code or Codex](plugins/bobsled-core/README.md)
to make the built-in skills available without copying files from this repository.

After installing Bobsled Core, open Claude Code or Codex in your project folder and
invoke the **`bobsled-tutorials`** skill, or ask:

> Use the bobsled-tutorials skill for TV Night.

The skill already includes the chapter order, setup, choices and inspection pauses.
You do not need to repeat those instructions. If the skill is not available in your
agent, use this fallback:

> Read `npx bobsled onboarding guide` and follow its instructions.

This command exposes the bundled guide without a separate skill installation.

The agent creates and opens a local HTML page with chapter progress, working files,
model lineage and data previews. It explains each capability and pauses for your
choices and inspection. No separate plugin or tutorial server is needed. Public
data reads need no API key; the optional AI chapter uses your own provider account
and asks for consent before making calls.

For the CLI fallback in a source checkout, [build the repository](CONTRIBUTING.md#develop-and-verify-a-small-fix)
and have your agent use `node packages/bobsled-core/bin/cli.mjs onboarding guide` from
the repository root instead of `npx`, so it reads the checkout’s version.
See the [full walkthrough](packages/bobsled-core/examples/tv-night/README.md) for the
chapter instructions.

## How a project works

A Bobsled Core project is a folder of YAML and Markdown files:

```text
APIs, files, databases → extract → load → tables → SQL models → query
```

- **Integrations and resources** describe how to connect and what to read.
- **Destinations** describe where to load the records.
- **Sources and models** describe existing tables and the transformations built on them.
- **Semantic definitions** describe what the data means: metrics, relationships,
  context and verified queries that pair a question with SQL known to answer it.
- **Project guides and skills** give coding agents instructions for working with the project.

For example, this model groups orders by customer and keeps its meaning beside
its SQL expressions. It uses the `warehouse.orders` source from the tutorial:

```yaml
spec_version: '0.2'
type: model
name: customer_revenue
description: Order count and total amount per customer.
ai_context:
  instructions: Use this model for questions about customer spend. Amounts are in US dollars.
grain: [customer]
source: { ref: warehouse.orders }
columns:
  - { name: customer, expr: customer, primary_key: true }
  - { name: order_count, expr: count(*) }
  - { name: total_amount, expr: sum(amount), description: Sum of order amounts. }
group_by: [customer]
materialization: { type: table }
```

Bobsled Core validates the model, compiles it to SQL and runs it against the configured
database. People and agents can read the descriptions and `ai_context` to decide
which model to use. Core also validates and exports metric definitions. It does
not compute those metrics itself. See [Semantic model](docs/guides/semantic-model.md).

The [concepts guide](docs/concepts.md) explains the file types and how they connect.

## Capabilities

### Move and query data

- **Extract** from [library integrations](docs/guides/use-library-integrations.md),
  [REST APIs](docs/guides/extract-from-an-api.md),
  [files and documents](docs/guides/extract-from-files.md),
  [databases and warehouses](docs/guides/extract-from-databases.md), and
  [Model Context Protocol (MCP) servers](docs/guides/extract-from-mcp.md).
- **Load** into DuckDB, DuckLake, PostgreSQL, Snowflake, BigQuery, Databricks,
  ClickHouse, MySQL, SQL Server, SQLite, vector stores or files.
  See [Load data](docs/guides/load-data.md).
- **Model** with SQL expressions, views, tables, incremental models, seeds, tests
  and lineage. See [Build models](docs/guides/build-models.md) for supported warehouses.
- **Query** loaded tables with SQL and API-backed sources on demand.
  See [Query data](docs/guides/query-data.md).

### Describe and enrich data

- **Semantic model:** keep descriptions, AI context, metrics, relationships and
  verified queries alongside the models. Import and export semantic definitions
  through Apache Ossie, an interchange format. See [Semantic model](docs/guides/semantic-model.md).
- **Entity graph:** resolve records from several sources into customers,
  companies or other entities. Serve them through SQL, a typed SDK, an HTTP API
  or an MCP server. See [Entity graph](docs/guides/entity-graph.md).
- **Agentic models:** send prepared rows to an AI executor, validate its returned
  rows and store the results as a table. Runs can resume after a failure.
  See [Agentic models](docs/guides/agentic-models.md).

### Work with agents and inspect projects

- **Coding agents** can read project context, edit files and invoke the CLI.
  An `AGENTS.md` guide and project skills supply instructions.
  See [Project guide and skills](docs/guides/project-skills.md).
- **CLI automation** uses `--json` output and exit codes for success (`0`), runtime
  failure (`1`), validation failure (`2`) and detected drift (`3`).
  See the [CLI reference](docs/reference/cli.md).
- **Explorer** is a local web app for browsing integrations, models and pipelines.
  It runs from a source checkout. See [Explorer](docs/guides/explorer.md).

A coding agent working on files and an AI executor processing rows are separate
uses of AI. Ordinary extraction, loading and SQL modeling do not require an AI provider.

## Running Core

Core runs in your environment and uses the sources and destinations you configure.
It requires no hosted Bobsled Core account or control plane and has no default
maintainer telemetry. Keep credentials in environment variables referenced by
project files. Optional AI and embedding features send selected data to configured
providers and can incur provider charges. See [Privacy](PRIVACY.md) for data flows,
local state and retention.

## Documentation and project information

- [Get started](docs/getting-started.md): complete the first local workflow.
- [Examples](examples/README.md): explore runnable projects with fictional data.
- [Run in production](docs/guides/run-in-production.md): schedule runs from GitHub
  Actions, systemd or a container, and keep state between runs.
- [Documentation index](docs/README.md): find task guides and reference pages.
- [Changelog](CHANGELOG.md): review version history and unreleased changes.
- [Release guide](docs/releases.md): understand versioning and package publication.

## Community and contributions

Ask questions, share ideas and request connectors in
[GitHub Discussions](https://github.com/bobsled-inc/bobsled-core/discussions).

- Report a reproducible bug in a
  [GitHub issue](https://github.com/bobsled-inc/bobsled-core/issues/new/choose).
- Report a vulnerability privately, as described in [SECURITY.md](SECURITY.md).
- Outside code contributions are limited to small fixes. Read
  [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution policy, development setup
  and checks. Every commit needs a Developer Certificate of Origin (DCO) sign-off.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) when taking part in the project.

## License

[Apache-2.0](LICENSE).

See [TRADEMARKS.md](TRADEMARKS.md) for the name and logo policy.
