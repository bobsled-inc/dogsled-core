---
name: explore-integration
description: Look up a Dogsled integration's full details — resources, auth setup, schemas, pagination, and related model bundles. Use when you need to quickly understand what an integration offers.
argument-hint: '<integration-name> — e.g., "stripe", "hubspot", "github"'
exposed: true
triggers:
  - explore integration
  - look up integration
  - inspect integration resources
  - what resources does stripe have
  - show integration schema
  - list integration endpoints
  - integration auth setup
  - check integration details
  - what does this integration support
---

# Explore Integration — Quick Integration Lookup

Quickly look up everything about a Dogsled integration without leaving the terminal.

## Usage

```
/explore-integration <name>
```

Example: `/explore-integration stripe`

## Workflow

### Step 1: Load integration data

Read the integration spec and metadata:

```bash
ls packages/integrations/sources/<name>/
```

Read these files:

- `packages/integrations/sources/<name>/meta.yml` — display name, category, auth setup, docs URL
- `packages/integrations/sources/<name>/source.yml` — transport(s), base URL, auth type, `default_transport`

`source.yml` lists every transport as a `transports[]` entry with an `id` (`graphql`, `mcp`, `rest`, …). Sources with two or more entries are **multi-transport** — each entity has one variant per transport, and pipelines pick between them with `via:`. Note the transport ids; agents authoring `bobsled.yml` need them.

### Step 2: List all resources

```bash
ls packages/integrations/sources/<name>/resources/
```

Two shapes show up here:

- **Flat `<entity>.yml` files** — single-transport entities. Reference the file's `name:` field directly in `bobsled.yml` `resources:`.
- **`<entity>/` folders containing `<transport>.yml` files** (e.g. `issues/graphql.yml`, `issues/mcp.yml`) — multi-transport entities. Two ways to reference them in `bobsled.yml`:
  1. Bare entity name + pipeline `via:` — `resources: [issues]` with `via: mcp` resolves to `issues_mcp`. Used when a whole pipeline picks one transport.
  2. Variant spec name — `resources: [issues_mcp]` directly. Used when one pipeline mixes transports.

Single-variant entities also auto-resolve from the bare entity name — no `via:` required when there's only one option.

### Step 3: Summarize

Print a structured summary:

```
Integration: <display_name> (<name>)
Category: <category>
Type: <integration_type>
Docs: <docs_url>

Auth Setup:
  <ENV_VAR>: <description>

Transports:
  default_transport: <id>
  - id: <id>  type: <type>  base_url: <url>  auth: <auth_type>
  (one row per entry in source.yml `transports[]`)

Resources (<entity count>, <variant count> spec files):
  <entity_name>  (variants: <via1>, <via2>, …)
    spec names: <entity_via1>, <entity_via2>
    Endpoint:    <method> <endpoint>     (from default variant)
    Primary Key: <pk_fields>
    Pagination:  <type>
    Incremental: <cursor_field> (if applicable)
    Output Fields: <count>
```

### Step 4: Check for model bundle

```bash
ls packages/models/models/<name>/ 2>/dev/null
```

If a model bundle exists, report:

```
Model Bundle: <display_name>
  Sources: <count>
  Staging: <count>
  Marts: <count>
  Files: <list>
```

### Step 5: Show resource detail (if requested)

If the user asks about a specific resource, read its YAML:

```bash
cat packages/integrations/sources/<name>/resources/<resource>.yml
```

And present:

- Input parameters (name, type, required, description)
- Output schema (field, type, path)
- Extract config (pagination, incremental, record_path, for_each)
- Table config (primary_key, trust_tier)

## Tips

- Use `packages/integrations/sources/` to browse available integrations
- Category options: developer-tools, crm, marketing, finance, communication, analytics, cloud-infra, productivity
- Integration types: api, db, mcp
- The Explorer UI at `localhost:3333/integrations/<name>` shows the same data with a visual interface
