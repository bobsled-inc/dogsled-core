# Bobsled Core Explorer

A local-first web UI for exploring, configuring, and demoing the [Bobsled Core](../../README.md) data engineering toolkit. Browse integrations, model bundles, journeys, runs, docs, pipelines, data previews, and the Entity Graph demo surface from your browser. The user guide is [docs/guides/explorer.md](../../docs/guides/explorer.md); this README describes the app for contributors.

Explorer is local-only, has no authentication, and must not be exposed to a network.

## Quick Start

```bash
# From the monorepo root
pnpm run setup          # Install deps + build all packages
pnpm --filter @bobsled-inc/explorer dev   # Prefers http://localhost:3333
```

The explorer reads integration and model data directly from the monorepo packages at build time. No database, no cloud services, no API keys required.

## Pages

### Dashboard (`/`)

Your launchpad. Shows:

- **Stats at a glance** — integration count, total API resources, model bundles, analytics marts, destinations, categories
- **Bobsled Core Capabilities** — five cards covering Extract, Load, Model, Pipeline, and Entity Graph with feature highlights
- **Quick actions** — colored cards linking to Guided Setup, Pipeline Builder, Terminal, and Data Query
- **Integrations by category** — clickable list filtered by category (CRM, payments, marketing, etc.)
- **Load destinations** — all 9 supported destinations (DuckDB, BigQuery, Snowflake, PostgreSQL, ClickHouse, Turbopuffer, Local Files, S3, GCS)
- **Model bundles** — all pre-built analytics models with mart counts
- **Popular integrations** — top 12 by resource count with direct links

### Journeys (`/journeys`, `/journeys/[id]`)

Guided product tours that connect the main explorer surfaces into a runnable workflow:

- Scenario-based walkthroughs like the SaaS pipeline and customer resolution demos
- Per-step instructions, page links, and terminal command previews
- Direct jumps into Terminal, Data Preview, the pipeline builder, and the Entity Graph surface

### Runs (`/runs`)

Local run history for Terminal sessions:

- Filter by status, integration, and date range
- Re-run saved commands or multi-command pipeline batches
- Jump straight into DuckDB results when a run wrote to a local database

### Agent (`/agent`)

Conversational AI assistant powered by your local Claude Code installation. Ask freeform questions about Bobsled Core:

- "What integrations are available for CRM data?"
- "How do I build a Stripe analytics pipeline?"
- "Explain the source → staging → mart pattern"
- "What destinations can I load data into?"

The agent's system prompt is dynamically built from the actual integration and model catalogs, so it always has up-to-date knowledge of every connector, model bundle, destination, and CLI command.

**Requires** `claude` CLI available in your PATH. Install via `npm install -g @anthropic-ai/claude-code` if needed.

### Integrations (`/integrations`)

Browse all 81+ API connectors with:

- **Search** by name or tag
- **Filter** by category (CRM, payments, marketing, support, etc.) or type (API, Database, MCP)
- **Model bundle badges** on integrations that have pre-built analytics models
- **Click through** to full detail pages

### Integration Detail (`/integrations/[name]`)

Open one integration:

- **Authentication setup** — environment variables needed, with docs links
- **Transport** — base URL, auth type
- **Model bundle link** — banner linking to the pre-built model bundle when available
- **Expandable resource cards** for each API endpoint showing:
  - HTTP method and endpoint URL
  - MCP tool references
  - Input parameters (name, type, required, description)
  - Output schema (field, type, path, primary key)
  - Pagination type, incremental cursor field, trust tier
  - Billable and lookup badges

### Models (`/models`)

Browse all 21 pre-built analytics model bundles. Each card shows:

- Display name and description
- Source, staging, and mart counts
- Tags

### Model Detail (`/models/[name]`)

Full model bundle exploration with tabs:

- **Overview** — tags, total specs, file count, bundle name
- **Sources / Staging / Marts** — expandable spec cards showing column details (name, type, PK, semantic role, expression)
- **Files** — side-by-side file browser with syntax-highlighted content
- **DAG summary** — visual source → staging → mart flow with counts and individual model names
- **Integration link** — banner linking to the data source integration when one exists

### Pipeline Builder (`/pipelines/new`)

6-step wizard to configure an extract + load pipeline:

1. **Preset** — choose SaaS Analytics, Customer Ops, Revenue Ops, Product Delivery, or Custom
2. **Integrations** — select from all available connectors (pre-filled from preset)
3. **Resources** — pick specific API resources per integration (with Select All toggle, incremental indicators)
4. **Destination** — choose DuckDB, BigQuery, Snowflake, PostgreSQL, ClickHouse, Turbopuffer, Local Files, S3, or GCS with destination-specific config fields
5. **Schedule** — hourly, every 4h, daily, weekly, or custom
6. **Review** — see generated `bobsled.yml`, copy to clipboard, link to Export Options or Run in Terminal

### Export (`/pipelines/new/export`)

Export your pipeline configuration as YAML or CLI commands:

- **bobsled.yml** — ready-to-use pipeline configuration file
- **CLI Commands** — copy-paste commands for manual execution

The main terminal CTA also runs every selected integration in sequence, instead of only the first integration in the config.

When reached from the Pipeline Builder, shows your actual config. Otherwise shows a demo configuration with a link back to the builder.

### Data Preview (`/data`)

Query local DuckDB databases:

- Configurable database file path
- **Quick queries** — "Show tables" and "Table sizes" one-click buttons
- SQL editor with **Ctrl+Enter** to execute
- Results table with column headers, null handling, and row count
- Error display for failed queries

### Terminal (`/terminal`)

Interactive Bobsled Core CLI runner with:

- **8 quick commands** — list integrations, show Stripe, extract help, etc.
- **Streaming output** via Server-Sent Events with Bobsled Core protocol parsing
- Color-coded messages: LOG (by level), METRIC (green), PROGRESS (primary), SCHEMA (yellow), RECORD (muted)
- **Command history** with up/down arrow navigation
- **Stop** button and Ctrl+C support
- Clear button

Commands are prefixed with `bobsled` automatically — just type `integrations list --type api`.

### Docs (`/docs`)

In-app documentation for the explorer surface, API routes, and high-value Bobsled Core commands.

### Entity Graph (`/entity-graph`, `/entity-graph/design`, `/entity-graph/resolve`, `/entity-graph/resolve/clusters/[id]`)

The Entity Graph demo is split across a hub, a design flow, and a resolve workspace:

- `/entity-graph` — hub page with overview, saved specs, and recent run context
- `/entity-graph/design` — author entity, inputs, standardize, blocking, scoring, thresholds, and review YAML
- `/entity-graph/resolve` — run the demo pipeline, inspect the review queue, and browse clusters
- `/entity-graph/resolve/clusters/[id]` — inspect one resolved cluster in detail

### Setup Wizard (`/setup`)

Chat-style guided pipeline configuration:

- Connects to Bobsled Core's setup APIs (`bobsled setup describe` and `bobsled setup recommend`) when available
- Falls back to built-in presets if CLI is unavailable
- Flow: describe your goal → get preset recommendation → choose destination → set schedule → review summary with next steps

## Architecture

The explorer is a Next.js 15 app that reads integration and model data from workspace packages at build time and spawns `bobsled` CLI subprocesses for command execution.

```
Browser ──→ Next.js App ──→ @bobsled-inc/integrations (YAML catalog)
                         ──→ @bobsled-inc/models (model bundles)
                         ──→ bobsled CLI subprocess (commands, queries, setup)
                         ──→ claude CLI subprocess (agent chat)
```

### API Routes

| Route                             | Method  | Purpose                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------- |
| `/api/integrations`               | GET     | List integrations with search/category/type filters           |
| `/api/integrations/[name]`        | GET     | Integration detail with all resources + model bundle link     |
| `/api/models`                     | GET     | List model packages                                           |
| `/api/models/[name]`              | GET     | Model package detail + integration link                       |
| `/api/command`                    | POST    | Execute bobsled CLI command, returns SSE stream               |
| `/api/query`                      | POST    | SQL query against local DuckDB                                |
| `/api/setup/describe`             | GET     | Setup catalog from bobsled CLI                                |
| `/api/setup/recommend`            | POST    | Goal-based pipeline recommendation                            |
| `/api/agent`                      | POST    | Chat with Claude Code agent, returns SSE stream               |
| `/api/entity-graph/specs`         | GET     | List available Entity Graph demo specs                        |
| `/api/entity-graph/specs/[name]`  | GET/PUT | Read or update an Entity Graph YAML spec                      |
| `/api/entity-graph/run`           | POST    | Seed + run the demo Entity Graph pipeline, returns SSE stream |
| `/api/entity-graph/runs`          | GET     | Read recent Entity Graph run history                          |
| `/api/entity-graph/queue`         | GET     | Load the live review queue                                    |
| `/api/entity-graph/clusters`      | GET     | Summarize resolved clusters                                   |
| `/api/entity-graph/clusters/[id]` | GET     | Load one cluster detail view                                  |
| `/api/entity-graph/decide`        | POST    | Persist a review decision via Bobsled Core Entity Graph       |
| `/api/entity-graph/agent-review`  | POST    | Run the bounded agent-review flow                             |
| `/api/entity-graph/assistant`     | POST    | Chat with the Entity Graph assistant rail                     |

### Key Design Decisions

- **No database** — all data comes from YAML specs in the monorepo or bobsled CLI subprocesses
- **Server-Sent Events** — command execution and agent chat stream results incrementally
- **YAML cache clearing** — integration and model libraries cache parsed YAML; every server-side call clears the cache to prevent memory leaks in the long-running dev server
- **Command whitelist** — only allowed bobsled subcommands can be executed via the API
- **Dynamic system prompt** — the agent's system prompt is built from actual catalog data on every request
- **Sequential terminal batches** — the explorer can stream multiple Bobsled Core commands back-to-back for multi-source pipeline runs

## Configuration

The app prefers port 3333 by default. If that port is already in use, the dev launcher automatically starts on the next open port and prints the URL it chose. To pin a specific port:

```bash
pnpm --filter @bobsled-inc/explorer dev -- --port 4000
```

## Development

```bash
pnpm --filter @bobsled-inc/explorer dev        # Dev server with hot reload, prefers 3333
pnpm --filter @bobsled-inc/explorer build      # Production build
pnpm --filter @bobsled-inc/explorer typecheck   # Type checking
pnpm --filter @bobsled-inc/explorer lint        # Linting
```

## Requirements

- Node.js 24 or later
- pnpm (workspace-aware)
- `claude` CLI for the Agent page (optional — everything else works without it)
