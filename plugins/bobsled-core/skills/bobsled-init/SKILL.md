---
name: bobsled-init
description: Set up a local Bobsled Core project or continue a Cowork-style repo
  setup flow from local setup files.
---

# Bobsled Core Init — Local Project Setup

Use `bobsled-get-started` for end-to-end setup of connections, sources and models.
This skill owns local project creation and the setup bundle. For guided example
lessons, use `bobsled-tutorials`.

Guide the user through local Bobsled Core setup. Use Node.js 24+ and the single `bobsled` CLI. `bobsled init <name>` writes `bobsled.yml`, `.bobsled/config.yml`, a `README.md`, and empty `integrations/` and `sources/` folders; it does not write a separate metadata file. It defaults to DuckLake; `--duckdb` uses a single `.bobsled/bobsled.duckdb` file.

1. Run `bobsled setup install` to install the local Cowork bundle.
2. Capture the goal with `bobsled setup recommend --goal "Sync Stripe into DuckDB daily." --write`.
3. Review `bobsled.setup.answers.yml` for destination details and environment-variable references. Store secret references only.
4. Run `bobsled setup render` to write project configuration and resumable docs.
5. Run `bobsled setup doctor`, fix its blockers, and run `bobsled runner validate --strict`.
6. Route extraction decisions to `extract-pipelines`. After the user authorizes a real write and confirms the destination, use `bobsled runner run <pipeline>`.

Ask one question at a time and recommend defaults. Read the local Project guide and setup summary before resuming. Keep secret values outside authored files. Use `bobsled init` when the user wants a minimal local project rather than the guided setup bundle. Scheduling belongs to the caller; the toolkit does not provision a hosted runner.
