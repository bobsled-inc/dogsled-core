---
name: dogsled-get-started
description: Set up or extend a Dogsled environment with the user's own
  connections, sources, pipelines, and models. Use for practical project setup;
  guided example lessons live in dogsled-tutorials.
---

# Get started with Dogsled

Help the user turn their own data into a working Dogsled project. Start from their
question or desired result, configure the needed connections and sources, and
build the smallest useful pipeline and model. This is practical setup, not a
chapter-based tutorial. If they ask to learn with TV Night or Retail, use
`dogsled-tutorials`; do not create tutorial data or progress files for ordinary setup.

## Understand the goal and existing project

Use the goal, systems and destination already supplied. Ask only for missing
choices that affect the work, one question at a time. A useful first question is:
“What data do you want to connect, and what would you like to answer with it?”
Recommend a small first scope, such as one source and one useful model.

Before writing files, inspect the selected project, its Project guide, Project
Skills, configuration, connections, resources, sources and models. Read any saved
setup summary and `dogsled.setup.answers.yml`. A project can use nested typed
files without a root `dogsled.yml`; do not treat that as an empty project. Reuse
working definitions and preserve unrelated files. Resume from the missing step
instead of initializing again.

## Prepare the environment

Check Node.js 24+ and the installed Dogsled CLI. If needed, install
`@bobsled-inc/dogsled` in the user's project and use `npx dogsled`. Install optional
warehouse drivers next to Dogsled only for the chosen destination.

For a new project, use `dogsled-init` for the guided setup flow or minimal
`dogsled init` scaffold. That skill owns project creation; continue here for
connections, sources and models after it finishes. For an existing project,
configure only the missing pieces. Use `dogsled-project-layout` when choosing
where new definitions belong.

Confirm the intended destination before loading. For a simple local project,
recommend DuckDB (`dogsled init <name> --duckdb`); plain `init` defaults to
DuckLake. Preserve an existing destination unless the user asks to change it.

## Connect data and build the first result

Read the relevant Built-in Skills as each step needs them through the installed
Dogsled Core plugin. If they are unavailable, use the installed CLI help and
Dogsled documentation for the required commands; do not assume a source checkout
exists in the user’s project.

- **Connections and extraction:** use `extract-pipelines` for supported API
  integrations, authentication references, resources and extraction settings.
  For an existing warehouse or database, use `add-warehouse-source`. For
  documents, use `add-file-storage-source`. Use `add-custom-api-integration` or
  `add-custom-mcp-integration` only when the needed service is not already covered.
- **Destination and pipeline:** use `loader` and `dogsled-add-pipeline` as needed.
  Explain which records will be read, where they will be written, and whether
  existing data will be replaced. Keep the first run bounded to the agreed scope.
  A warehouse that already holds the needed data may not need an ingestion pipeline.
- **Sources and models:** use `dogsled-model-spec` to describe queryable source
  data and `dogsled-author-model-spec-model` for the first useful model. Check
  `starter-data-models` for a matching bundle before writing models from scratch.
  Adapt keys, fields and business rules to the real schema; do not assume a starter
  matches every account. Add relationships, metrics or saved queries only when
  they help answer the user's question.

Keep credentials outside chat and authored files. Use environment-variable
references and declare required credential references in `auth_env_vars` where
required by the connection contract. Check availability without printing values.
If credentials are missing, prepare and validate what can be checked locally,
then explain the exact remaining step. Do not claim the connection works.

AI configuration is optional. Use `ai-model-roles` only if the requested work
needs AI, and agree on provider, model, scope and spend before paid calls.

## Validate and hand over

Use `dogsled doctor --json` to check project configuration. For a rendered setup
bundle, also run `dogsled setup doctor`. Validate the relevant extraction,
pipeline and model definitions with their owning skill's commands before execution.
Run only within the user's authorized read, write and spending scope; reuse
explicit authorization already given.

After an authorized first load and model build, run a bounded query that answers
the original question. Inspect keys, row counts and the result's meaning, not just
command success. If the user requested configuration only, stop after validation
and state that execution remains unverified.

Finish with the files created or changed, configured sources and destination,
checks performed, a useful query and its result when run, and any remaining
blocker. Distinguish configured, validated and successfully run. Leave enough
local setup context to resume without recording secrets. Scheduling is a separate
choice; Dogsled does not provision a hosted runner.
