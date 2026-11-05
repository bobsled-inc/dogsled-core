---
name: dogsled-init
description: Set up a local Dogsled project or continue a Cowork-style repo
  setup flow from local setup files.
---

# Dogsled Init — Local Project Setup

Use `dogsled-get-started` for end-to-end setup of connections, sources and models.
This skill owns local project creation and the setup bundle. For guided example
lessons, use `dogsled-tutorials`.

Guide the user through local Dogsled setup. Use Node.js 24+ and the single `dogsled` CLI. `dogsled init <name>` writes `dogsled.yml`, `.dogsled/config.yml`, a `README.md`, and empty `integrations/` and `sources/` folders; it does not write a separate metadata file. It defaults to DuckLake; `--duckdb` uses a single `.dogsled/dogsled.duckdb` file.

1. Run `dogsled setup install` to install the local Cowork bundle.
2. Capture the goal with `dogsled setup recommend --goal "Sync Stripe into DuckDB daily." --write`.
3. Review `dogsled.setup.answers.yml` for destination details and environment-variable references. Store secret references only.
4. Run `dogsled setup render` to write project configuration and resumable docs.
5. Run `dogsled setup doctor`, fix its blockers, and run `dogsled runner validate --strict`.
6. Route extraction decisions to `extract-pipelines`. After the user authorizes a real write and confirms the destination, use `dogsled runner run <pipeline>`.

Ask one question at a time and recommend defaults. Read the local Project guide and setup summary before resuming. Keep secret values outside authored files. Use `dogsled init` when the user wants a minimal local project rather than the guided setup bundle. Scheduling belongs to the caller; the toolkit does not provision a hosted runner.
