---
name: bobsled-overview
description: Source-of-truth high-level overview of Bobsled Core — what it is, how a typical project is laid out, what each entity (integration, source, resource, destination, extract+load pipeline, model pipeline, Model Spec model/metric/relationship/VQ, entity graph) means, and which skill to reach for next. Read this first when you're new to Bobsled Core or when a user request spans multiple concepts.
exposed: true
triggers:
  - what is bobsled
  - bobsled overview
  - explain bobsled
  - bobsled concepts
  - bobsled project structure
  - bobsled entity map
  - model spec vs bobsled yml
  - extractor yml
  - what is a resource in bobsled
  - what is an integration in bobsled
  - bobsled glossary
  - new to bobsled
  - model pipeline
  - bobsled protocol
  - entity graph
---

# Bobsled Core — Overview & Entity Map

Read this skill first when a user is starting from scratch, asking conceptual questions, or making a request that touches more than one Bobsled Core entity (e.g. "extract Linear into Snowflake and add some models"). It gives you the vocabulary, the file layout, and the routing table; the action-oriented skills do the actual work.

For any request about creating, configuring, filtering, scheduling, running, or
diagnosing an extract pipeline, route to `extract-pipelines`. It is the single
authoritative extract-pipeline capability skill; this overview defines terms
only.

This skill is intended to be source-of-truth-accurate. The canonical references it draws from live in `AGENTS.md` (root), `docs/guides/run-pipelines.md`, and the example projects under `examples/` and `workspace/`. If anything here ever drifts from those, treat the canonical references as authoritative and update this skill.

## What Bobsled Core is

Bobsled Core is an **open-source, context-and-semantics-first data-engineering toolkit, built for the agent era**. The whole stack is YAML-driven, CLI-first, and designed so AI agents can author, operate, and evolve pipelines and semantic models with humans steering. There is no UI in the core product.

A Bobsled Core project has four concerns:

1. **ELT** — extract from APIs, warehouses/databases, or MCP servers, optionally embed text fields, and load into one or more destinations.
2. **Semantic modeling (Model Spec)** — describe the loaded data as portable SQL models, named metrics, declared joins (relationships), and verified queries.
3. **Entity graph (optional)** — identity resolution, survivorship, truthsets, and agent-task workflows that sit on top of loaded data via `@bobsled-inc/entity-graph`.
4. **Orchestration** — pipelines tie ELT and model materialization together under one schedule (or on-demand), all run by the `bobsled` CLI.

Components communicate through the **Bobsled Core protocol**, a JSONL stream of typed messages (`SCHEMA`, `RECORD`, `STATE`, `BATCH`, `LOG`, `METRIC`). Extractor → optional embedder → loader is the canonical pipe; every component works standalone or composed.

```text
              Bobsled Core protocol (JSONL on stdout)
 ┌──────────┐  ┌─────────────────┐  ┌──────────┐  ┌──────────┐
 │ Extractor│─▶│ SCHEMA/RECORD/… │─▶│ Embedder │─▶│  Loader  │
 │  (YAML)  │  │ shared contract │  │ optional │  │          │
 └──────────┘  └─────────────────┘  └──────────┘  └──────────┘
```

## What's available today (the truth, not aspirations)

- **Extraction.** Three modes:
  - **API** — YAML-driven, cursor pagination, multiple auth (API key, OAuth2, Basic, Bearer), incremental sync.
  - **Warehouse/database** — Snowflake, BigQuery, PostgreSQL, MySQL, ClickHouse, Redshift, Iceberg, Delta Lake. Full / incremental / CDC where the source supports it.
  - **MCP** — pulls data via Model Context Protocol servers over stdio or HTTP. Two flavors: bundled MCP integrations (Linear, Notion, …) via `explore-integration` / `mcp-discover`, **or** bring-your-own remote MCP servers via `add-custom-mcp-integration` (HTTP-only, inline `mcp_http` transport authored entirely in YAML).
- **Integrations catalog.** ~80 bundled API/warehouse/MCP integrations in `@bobsled-inc/integrations` (GitHub, Stripe, Slack, Linear, Notion, HubSpot, GitLab, Salesforce, Jira, Shopify, Zendesk, and more). Projects can add their own under `integrations/`.
- **Loading.** 17 destinations in `@bobsled-inc/loader`: DuckDB, DuckLake, SQLite, BigQuery, **Snowflake**, PostgreSQL, MySQL, Databricks, SQL Server, ClickHouse, Turbopuffer, Elasticsearch, Chroma, pgvector, GCS, S3, local filesystem. Strategies: `append`, `merge`, `full_refresh`. Schema evolution supported.
- **Embedding.** Optional Bobsled Core-protocol stream enrichment (`@bobsled-inc/embedder`) — adds vector embeddings to selected text fields before they reach the loader.
- **Semantic modeling.** Models, metrics, relationships, and verified queries via `@bobsled-inc/model-spec` (Model Spec). Multi-dialect SQL compilation (Snowflake, BigQuery, Postgres, Databricks, Redshift, DuckDB, ClickHouse).
- **Entity graph.** Resolution, review, survivorship, truthset, and agent-task workflows via `@bobsled-inc/entity-graph` (`bobsled entity-graph ...`).
- **CLI.** Single public binary: `bobsled`.

If a user asks for something _not_ in this list (e.g. federation / query-in-place, a destination not above), flag the gap — don't claim it ships today.

## Anatomy of a typical Bobsled Core project

```text
my-bobsled-project/
  AGENTS.md            # Project guide (optional): what the data means, what is queryable, vocabulary, conventions, caveats
  bobsled.yml            # Optional default orchestration file
  extractor.yml        # Extractor settings: state and batch folders, load defaults
  model-spec.yml              # Model Spec settings: seed, Entity Graph, and target folders, checkpoint store
  .env                 # Secrets (never committed); referenced from YAML as $VAR_NAME

  integrations/        # Project-local integration definitions (transport + auth)
    linear.yml
    snowflake.yml
    ...

  resources/           # Project-local resource definitions (endpoints, queries, pagination)
    linear/            # — extends or overrides bundled resources from @bobsled-inc/integrations
      issues.yml
      teams.yml
    github/
      ...

  sources/             # Model Spec sources: schemas of *loaded* tables, one file per resource
    linear/
      issues_graphql.yml
      users_graphql.yml
      ...
    snowflake/
      ...

  models/              # Model Spec models — SQL-as-YAML transformations
  metrics/             # Model Spec metrics — named semantic measures
  relationships/       # Model Spec relationships — declared joins between models
  vqs/                 # Model Spec verified queries — canonical NL→SQL pairs
  seeds/               # Optional — static reference data (CSV/YAML) loaded into the warehouse
  entity-graph/        # Optional — entity-graph project files (resolve, survivorship, truthsets)
```

Things to remember:

- **This is the conventional layout, not a requirement.** Bobsled Core finds typed definitions anywhere, so files can also be grouped by source or subject, such as `golf/datagolf/pga/`. Untyped YAML under a recognized kind folder inherits that kind. The root `bobsled.yml` and `bobsled.yaml` stay valid legacy pipeline configs. Nonroot pipeline fragments declare `type: pipeline_config`.
- **Pipeline configuration can be split by domain.** Bobsled Core merges root configs and typed fragments by pipeline and destination name. A repeated name or single-owner section fails and reports both paths. With no config file, the Project has no pipelines and Bobsled Core creates no file.
- **Names remain semantic fields.** A folder does not create a name, namespace, integration owner, warehouse, or schema. Keep required `name` and `integration` fields explicit.
- **`model-spec.yml`'s directory keys** (`sources_dir`, `models_dir`, `metrics_dir`, `relationships_dir`, `vqs_dir`, `integrations_dir`) are accepted but no longer limit where files live. Bobsled Core discovers CSVs below `seeds/`; `seeds_dir` remains an explicit legacy override. `entity_graph_dir` (legacy `mdm_dir`) still locates Entity Graph specs.
- **`extractor.yml`'s common keys:** `state_dir`, `batch_dir`; `integrations_dir` and `resources_dir` are accepted but no longer limit where files live.
- **`integrations/` is shared** between the ELT side (extract-time transport/auth) and the Model Spec side (a Model Spec source can reference a warehouse integration to know where to materialize). Project-local integration files override or extend the bundled catalog in `@bobsled-inc/integrations`.
- **Secrets are never inlined.** YAML references env vars with `$VAR_NAME`; the extractor and loader resolve them at runtime.
- **`AGENTS.md` is a scoped Project guide.** Bobsled Core applies guides from the Project root through each ancestor directory of an asset. Put broad context at the root and more specific data context beside a domain. A Markdown file can also declare `type: guide`. Guides are context, never authority. Project Skills stay the place for repeatable procedures.

## The word "source" is overloaded — read this carefully

Bobsled Core uses _source_ in two distinct ways. Confirm which one a user means before acting:

|                 | ELT _source_                                      | Model Spec _source_                                                                          |
| --------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Lives in**    | Pipeline config files (`source: linear`)          | `sources/<integration>/<resource>.yml`                                                       |
| **Means**       | the upstream system data is being **pulled from** | the schema of a **loaded table** that Model Spec models read from                            |
| **References**  | an integration name                               | a connection + table (e.g. `connection: warehouse_prod`, `table: linear_bq__issues_graphql`) |
| **Authored by** | `extract-pipelines`                               | typically auto-generated from the loaded data; hand-edited when refining types               |

When a user says "Linear is my source," they almost always mean the ELT source. When a Model Spec model has `source: { ref: <connection>.<table> }`, that's a Model Spec-source reference.

## Entity glossary

Listed in the order data flows: ELT in, modeling on top.

### Integration

A YAML spec describing an external API, warehouse, database, or MCP server — transport, auth, pagination, and the set of available _resources_. Pre-built ones ship in `@bobsled-inc/integrations` (~80 today). Projects add their own under `integrations/<name>.yml`.

- **When used:** referenced by name from ELT pipelines (`source:`) and from model pipelines (`connection:` for warehouse integrations).
- **Author / inspect with:** `add-integration` (new), `add-warehouse-source` (new warehouse extractor), `explore-integration` (look up an existing one).

### Resource

One specific endpoint, table, or tool within an integration — e.g. for Linear, `issues`, `projects`, `users`. Bundled resources ship inside the integration spec in `@bobsled-inc/integrations`. Projects can add or override resources by writing their own YAML under `resources/<integration>/<resource>.yml` — the file declares the endpoint, request body, pagination, and any incremental cursor. A pipeline can apply a bounded `input_matrix` to one Resource, and an output can retain a request value with `from.input` when the API omits it.

Multi-transport sources (e.g. Linear, Notion) expose each entity in more than one transport — `issues_graphql` + `issues_mcp` for the same `issues` entity. ELT pipelines reference these either by the canonical **entity name** (`issues`) paired with a pipeline-level `via:`, or by the variant spec name (`issues_mcp`) directly. The resolution precedence is (per-resource `via:` → pipeline `via:` → bundled `via:` → source `default_transport`).

- **When used:** ELT pipelines list which resources to extract; one Model Spec source file per resource captures the resulting schema.
- **Inspect with:** `explore-integration`. Scaffold from an MCP server with `mcp-discover`.

### Destination

Where loaded data lands. Defined under `destinations:` in a root pipeline config or a typed fragment. Built-in destinations live in `@bobsled-inc/loader` (17 today, listed above). The `loader` skill covers configuration; `add-database-destination` / `add-file-destination` cover implementing a new one.

- **When used:** every extract+load pipeline names either one `destination` or a local fan-out list in `destinations`.

### Extract+load pipeline

The default pipeline type: pull from a source → land in one or more destinations. Pipeline config files hold these definitions. Core fields are `source`, exactly one of `destination`/`destinations`, an explicit `resources` allowlist, and a required `schedule` (`manual` means on-demand only). `runner` is optional.

```yaml
linear_sflk:
  source: linear
  destination: warehouse
  resources: [issues_graphql, users_graphql, ...]
  schedule: daily
  runner: managed
```

- **Run with:** `bobsled pipeline <name>`.
- **Author and operate with:** `extract-pipelines`.

### Model pipeline

A pipeline whose job is to **materialize Model Spec models** against a connection — not to extract data. Declared with `type: models`. Fields: `connection` (the warehouse integration to materialize into), `models: '*'` (or a list), and required `schedule` (`manual` for on-demand only). Optional `warehouse` selects a provider-declared warehouse **ID** for the whole pipeline; do not use the provider's underlying warehouse name.

```yaml
snowflake_silver:
  type: models
  connection: snowflake
  models: '*'
  schedule: daily
  warehouse: large # Optional ID from the connection's warehouses map
```

- **When used:** to refresh the materialized tables/views Model Spec models define. Typically scheduled to run _after_ the extract+load pipelines that populate raw tables.
- **Run with:** the same `bobsled pipeline <name>` surface as extract+load pipelines.
- **Author with:** `bobsled-add-pipeline`.

### Schedule

A trigger attached to a pipeline (extract+load or model). Examples: `hourly`, `daily`, `daily at 14:30`, `every 4h`, or `manual`. The field is required; `manual` marks an on-demand pipeline that runs when explicitly invoked.

- **Author with:** `bobsled-add-pipeline`, `bobsled-generate-yml`.

### Model Spec model

A SQL transformation expressed as YAML — materialization (view / table / incremental / ephemeral), column types, refs to upstream tables or other models, tests, dialect notes. One file per model in `models/`. The Model Spec compiler emits dialect-specific SQL.

- **Author with:** `bobsled-author-model-spec-model`.

### Model Spec metric

A named semantic measure layered on one or more Model Spec models (e.g. `total_revenue`, `order_count`). Carries an expression, synonyms, tags. One file per metric in `metrics/`.

- **Author with:** `bobsled-author-model-spec-metric`.

### Model Spec relationship

A declared join between two Model Spec models — join columns, join type, cardinality. Used by downstream planners (BI tools, host application, host agent) when queries cross model boundaries. One file per relationship in `relationships/`.

- **Author with:** `bobsled-author-model-spec-relationship`.

### Model Spec verified query (VQ)

A natural-language-question → SQL pairing the host agent treats as **ground truth** for retrieval. Supports `{ref}` tokens, optional parameters, and connection pinning. One file per VQ in `vqs/`.

- **Author with:** `bobsled-author-model-spec-vq`.

### Seed (optional)

Static reference data (CSV/YAML) loaded into the warehouse alongside extracted data. Useful for lookups (e.g. country codes, status mappings) that don't come from an upstream system. Bobsled Core discovers CSVs below any `seeds/` path. Add a YAML seed spec when warehouse loading is needed; a bare CSV has no warehouse target. `seeds_dir` in `model-spec.yml` remains available as a legacy folder override.

### Entity graph (optional)

Identity resolution + survivorship + truthsets + agent-task workflows on top of loaded data. Lives in `entity-graph/` (path configurable via `mdm_dir` in `model-spec.yml`) and is driven by the `bobsled entity-graph …` CLI in `@bobsled-inc/entity-graph`.

- **When used:** deduplicating people/companies/accounts across multiple sources, building golden records, running agent-driven enrichment tasks.
- **Set up / run with:** `entity-resolution`.

## Pipeline configs vs `extractor.yml` vs `model-spec.yml` — what each file owns

|                      | Pipeline config files                                                                        | `extractor.yml`                              | `model-spec.yml`                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Concern**          | Orchestration: destinations + pipelines + schedules                                          | ELT settings: extract state and batch output | Model Spec settings: seeds, Entity Graph, and compile options                         |
| **Typical contents** | `destinations:`, `pipelines:` (extract+load and model), `defaults:`; root or typed fragments | `state_dir`, `batch_dir`, `default_load`     | `seeds_dir`, `entity_graph_dir` (legacy `mdm_dir`), `targets_dir`, `checkpoint_store` |
| **Length**           | Where most user-facing changes happen                                                        | A few lines of settings                      | A few lines of settings                                                               |
| **Authored by**      | `bobsled-init`, `bobsled-add-pipeline`, `bobsled-generate-yml`                               | `bobsled-init` (rarely hand-edited after)    | `bobsled-init` (rarely hand-edited after)                                             |
| **Changes when**     | adding/removing pipelines, switching destinations, retiming syncs, adding model pipelines    | restructuring project layout (rare)          | restructuring project layout (rare)                                                   |

If the change is about _what runs and when_, update the owning pipeline config file. Bobsled Core merges all indexed fragments. Keep one owner for each pipeline name, destination name, and other top-level section. The other two manifests hold settings that rarely change once written; their `*_dir` keys for integrations, resources, sources, models, metrics, relationships, and VQs no longer limit where those files live.

## Lifecycle — which skill owns which phase

```text
   ┌──── extract ────┐  ┌── (embed) ──┐  ┌──── load ────┐  ┌──── model ─────┐  ┌──── query ────┐
   │ integration +   │  │  optional   │  │ destination  │  │ Model Spec sources +  │  │ Agent hosts / │
   │ resources       │→ │ vector enrich│→ │ (loader)     │→ │ models +       │→ │ NL-SQL agents │
   │ (extractor)     │  │  (embedder) │  │              │  │ metrics +      │  │ consume VQs   │
   │                 │  │             │  │              │  │ relationships  │  │               │
   └─────────────────┘  └─────────────┘  └──────────────┘  └────────────────┘  └───────────────┘
        skills:                                  skills:           skills:               skills:
   explore-integration,                       loader, add-*-    bobsled-author-model-spec-model,    bobsled-author-model-spec-vq,
   add-integration,                           destination       bobsled-author-model-spec-metric,   bobsled-author-model-spec-
   add-warehouse-source,                                        bobsled-author-model-spec-           relationship
   mcp-discover                                                  relationship

   pipeline config files that orchestrate this:
   ── extract+load pipeline:  source → destination
   ── model pipeline:         connection → materialized models

   parallel concern, on top of loaded data:
   ── entity graph (entity-resolution): resolution + survivorship + truthsets + agent tasks
```

## Skill router — "if you want to X, use Y"

| Goal                                                                                               | Skill                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Bootstrap a new Bobsled Core repo from scratch                                                          | `bobsled-init`                           |
| Author, modify, filter, schedule, run, or diagnose an extract pipeline                             | `extract-pipelines`                      |
| Add another pipeline to an existing repo                                                           | `bobsled-add-pipeline`                   |
| Turn a plain-English goal into `bobsled.yml`                                                       | `bobsled-generate-yml`                   |
| Look up what an integration offers                                                                 | `explore-integration`                    |
| Add a new integration the catalog doesn't have                                                     | `add-integration`                        |
| Add a REST/GraphQL API source not in the catalog (author it in YAML, no connector module)          | `add-custom-api-integration`             |
| Add a remote MCP server as a source (BYO MCP, not in the catalog)                                  | `add-custom-mcp-integration`             |
| Build a remote MCP server from scratch and connect it                                              | `build-mcp-server`                       |
| Add a warehouse/database as a _source_                                                             | `add-warehouse-source`                   |
| Add a new _database_ destination (Snowflake, Postgres, ClickHouse, …)                              | `add-database-destination`               |
| Add a new _file-based_ destination (Azure Blob, R2, MinIO, …)                                      | `add-file-destination`                   |
| Scaffold extract YAML from an MCP server's tools                                                   | `mcp-discover`                           |
| Compose extract → optional embed → load stages                                                     | `pipeline`                               |
| Configure loading details only                                                                     | `loader`                                 |
| Validate a project before running                                                                  | `bobsled-troubleshoot`                   |
| Diagnose a failing pipeline                                                                        | `bobsled-troubleshoot`                   |
| Wrap an existing ETL into Bobsled Core                                                                  | `etl-migration`                          |
| Author a Model Spec model from SQL or a description                                                | `bobsled-author-model-spec-model`        |
| Author a named metric                                                                              | `bobsled-author-model-spec-metric`       |
| Declare a join between two Model Spec models                                                       | `bobsled-author-model-spec-relationship` |
| Lock in a canonical NL-question → SQL pairing                                                      | `bobsled-author-model-spec-vq`           |
| Stand up the curated starter analytics models for a loaded source (Stripe, HubSpot, Salesforce, …) | `starter-data-models`                    |
| Full Model Spec reference — sources, models, materializations, CLI, error codes                    | `bobsled-model-spec`                     |
| Expression DSL details — operators, functions, JSON paths, reserved words                          | `bobsled-model-spec-expressions`         |
| Programmatic granular edits to Model Spec YAML (sources/models/columns/metrics/...)                | `bobsled-model-spec-edit`                |
| Cleaning / standardization functions for staging-layer transforms                                  | `bobsled-model-spec-cleaning`            |
| Set up entity resolution / golden records                                                          | `entity-resolution`                      |

## Operating principles

- **Read this skill once, then route.** Don't try to perform multi-entity work using only this overview — pick the next skill from the router.
- **ELT before modeling.** Models can't be authored against data that hasn't been loaded yet. If the user asks for both in one turn, plan extract+load pipelines first, then Model Spec models, then a model pipeline to materialize them.
- **Check capability before promising.** The "What's available today" list above is the source of truth for what's shipped. If a user names a destination, integration, or feature that isn't on it, the next step is `add-*` or a gap conversation — not a fabricated pipeline.
- **Mind the overloaded "source".** Confirm whether the user means an ELT source (integration to pull from) or a Model Spec source (loaded-table schema) — they're authored differently.
- **Secrets via `$ENV_VAR` indirection.** Never write raw credentials into a pipeline config, `extractor.yml`, or any project YAML.
- **One question at a time.** Bobsled Core projects accumulate decisions (auth, resource subset, destination, schedule, materialization). Don't dump them all at once.
- **When in doubt, check the canonical references.** Root `AGENTS.md`, `docs/guides/run-pipelines.md`, and the example projects under `examples/` and `workspace/` are authoritative.
