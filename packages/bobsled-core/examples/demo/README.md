# dogsled Demo

End-to-end walkthrough: extract data from REST and GraphQL APIs, build semantic models, query locally with DuckDB.

Includes four integrations — run any combination depending on which tokens you have.

## Quick Start

```bash
dogsled examples init demo
cd demo
```

Set one or more tokens (see below), then:

```bash
./walkthrough.sh
```

If you installed Dogsled into a project folder with `npm install @bobsled-inc/bobsled-core`,
run the commands below with `npx dogsled`; the walkthrough finds it either way. The
walkthrough needs bash 4 or later.

The script auto-detects which tokens are set and runs only those integrations.

## Tokens

### GitHub

Extract: public repos for an organization.

1. Go to https://github.com/settings/tokens
2. Generate a **classic** personal access token with `public_repo` scope
3. Export it:

```bash
export GITHUB_READ_TOKEN='ghp_...'
```

### Slack

Extract: channels and users from a workspace.

1. Go to https://api.slack.com/apps and create a new app (or use an existing one)
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `channels:read`
   - `groups:read`
   - `users:read`
   - `users:read.email` (optional, for email field)
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`)

```bash
export SLACK_BOT_TOKEN='xoxb-...'
```

### Notion

Extract: workspace users and pages.

1. Open your Notion integration settings and create a new **internal integration**
2. Under **Capabilities**, enable "Read content" and "Read user information"
3. Copy the **Internal Integration Secret** (`ntn_...`)
4. Share any pages/databases you want to extract with the integration

```bash
export NOTION_API_TOKEN='ntn_...'
```

### Linear

Extract: issues and teams via GraphQL.

1. Go to https://linear.app/settings/api
2. Create a **Personal API key**
3. Copy the key (`lin_api_...`)

```bash
export LINEAR_API_KEY='lin_api_...'
```

## What the Walkthrough Does

1. **Validate** — checks all extractor specs and Model Spec model definitions
2. **Extract** — pulls data from each active integration into local parquet files
3. **Compile** — generates SQL from Model Spec model definitions
4. **Query** — loads parquet into DuckDB, deploys modeled views, runs sample analytics

## Project Structure

```
integrations/       One YAML per API (auth, transport, rate limits), plus the warehouse
  github.yml
  slack.yml
  notion.yml
  linear.yml
  warehouse.yml     DuckDB file the models run against (output/demo.duckdb)
resources/          Endpoint definitions (fields, pagination, output mapping)
  github/repos.yml
  slack/channels.yml, users.yml
  notion/users.yml, pages.yml
  linear/issues.yml, teams.yml
sources/            Raw tables in the warehouse (raw.github_repos and so on)
models/             Model Spec model definitions (staging + summary views)
extractor.yml       Extractor framework config
walkthrough.sh      Run everything end-to-end
```

## Running Individual Steps

```bash
# Validate
dogsled extract validate github
dogsled model validate

# Extract a single resource
dogsled pipeline repos --integration github --format parquet --output-dir ./output --input org=octocat
dogsled pipeline channels --integration slack --format parquet --output-dir ./output
dogsled pipeline users --integration notion --format parquet --output-dir ./output
dogsled pipeline issues --integration linear --format parquet --output-dir ./output

# Compile models (writes ./compiled/warehouse/*.sql)
dogsled model compile -o ./compiled
```

## Prerequisites

- **Node.js** 24+
- **bash** 4+ for `walkthrough.sh`
- **dogsled** CLI installed (`dogsled --version`)
- **DuckDB** (optional, for query step) — `brew install duckdb`
