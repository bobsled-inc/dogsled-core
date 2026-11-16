# Set up a project and check its health

`dogsled init` creates an empty project. `dogsled setup` goes further: it turns a
plain-English goal into a recommended set of integrations, a destination and a
schedule, and writes the configuration, a Project guide and notes for the next
steps. `dogsled doctor` checks a project at any time.

## Start from a goal

```bash
dogsled setup recommend --goal "Sync Stripe and HubSpot into BigQuery every 4 hours." --write
```

```text
Recommended preset: SaaS Analytics
Sources: hubspot, stripe
Destination: bigquery
⚠ Missing items: HUBSPOT_ACCESS_TOKEN, STRIPE_SECRET_KEY, GCP_SERVICE_ACCOUNT_JSON
```

`--write` saves the answers to `bobsled.setup.answers.yml`. Edit that file to change
any choice, then render the project files:

```bash
dogsled setup render
```

```text
✓ Rendered 10 setup files.
bobsled.yml
README.md
AGENTS.md
skills/project-overview/SKILL.md
...
```

`render` writes `bobsled.yml` with the destination and one pipeline per source, a
`README.md`, step-by-step notes under `docs/`, a summary
(`bobsled.setup.summary.md`) and `dogsled.dashboard.state.json`. It creates
`AGENTS.md` and `skills/project-overview/SKILL.md` only if they do not exist yet,
and reports them as preserved otherwise, and links the skill for agents as
`dogsled skill configure` does. Rendering again refreshes the generated files from
the answers.

`dogsled setup doctor` explains what still blocks the setup, here the three
secrets, and exits with code 2 until nothing does:

```bash
dogsled setup doctor --json || echo "exit code $?"
```

```text
{"status":"blocked","summary":"Setup is blocked by 3 item(s): HUBSPOT_ACCESS_TOKEN, STRIPE_SECRET_KEY, GCP_SERVICE_ACCOUNT_JSON",
exit code 2
```

`dogsled setup describe` prints the questionnaire, presets and validation rules as
JSON, for an agent that asks the questions itself.

The setup flow also ships as a plugin for Claude Cowork. `dogsled setup install`
copies it into a repository and `dogsled setup export` writes it as a zip file, or
as a folder with `--format dir`.

## Check a project

`dogsled doctor` validates the configuration, every AI model role, the project files,
the Project guide and the skills. In the project rendered above:

```bash
dogsled doctor
```

```text
WARN platform.models: No model roles configured
OK mcp.unfiltered_in_production: fail-closed MCP default is in effect.
OK sdk.stale: No generated SDK headers found; skipping stale-SDK check.
OK project.files: 3 project files recognized
OK project.skills: 1 Project Skill valid
...
WARN project.guide: Project guide AGENTS.md still contains the setup scaffold placeholder; describe the data before agents rely on it
```

It exits with code 2 when any check fails. `--json` and `--yaml` print the same
checks for scripts, `--config` and `--project-root` select the project, and
`--no-guide` skips the Project guide check.

Other checks you can run on their own: `dogsled runner validate` for pipelines,
`dogsled model validate` for models, `dogsled extract validate` for integrations
and resources, and `dogsled skill validate` for the guide and skills.
