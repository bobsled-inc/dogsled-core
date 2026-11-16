# Agentic models

An agentic model (`model_kind: agentic`) sends prepared rows to an AI executor
and stores the typed results as a table. Use it to assess, classify or research
records: for example, to decide whether two customer records describe the same
company. Dogsled splits the input into assignments, checks every returned row
against the columns you declare, saves progress so that a run can resume, and
publishes the results. A downstream SQL model then applies your business rules.

A result is advice. Dogsled never turns a confidence score into an action such as
merging records; keep that decision in a later model or in your application.

## The model file

This model from the [agentic-mock example](../../examples/agentic-mock/) reads
prepared pairs and returns one assessment per pair:

```yaml
spec_version: '0.2'
type: model
model_kind: agentic
name: pair_assessments
description: Deterministic fictional findings using a test AI model.
grain: [pair_id]
sources:
  pairs:
    ref: prepared_pairs
llm:
  profile: review
limits:
  tokens: 100000
  timeout_seconds: 180
plan:
  steps:
    - id: assess
      source:
        ref: pairs
      map:
        over: pairs
        group_by: [pair_id]
      execution:
        mode: llm_call
      instructions: Return one deterministic finding using only fictional prepared evidence.
      columns:
        - { name: pair_id, type: string, nullable: false }
        - { name: assessment, type: string, nullable: false }
output:
  from: assess
materialization:
  type: table
  strategy: replace_processed_keys
  keys: [pair_id]
```

- `sources` names the SQL models or sources that feed the model. Prepare and filter
  the input in ordinary SQL models first.
- `llm.profile` names a [model role](embeddings-and-ai.md) in `bobsled.yml`.
- `plan.steps` run in order. `map.group_by` decides how rows are grouped into
  assignments: here, one assignment per pair. `execution.mode` is `llm_call` for a
  single structured answer, or `agent_loop` for an executor that reads more context
  and makes several calls.
- `columns` is the contract: rows that do not match are rejected.
- `output.from` picks the step to publish. Each published row also carries
  evidence, a confidence value, a reason and the run identity.
- `limits` caps what the run may spend (`max_cost_usd` or `tokens`) and how
  long it may take. At the cap, Dogsled stops starting new work, keeps every
  answer it already paid for, and tells you how to continue.

## Executors

Dogsled does not call a model provider by itself. An executor does:

- A local executor is a JavaScript module that exports
  `executeAgent(request)`. It receives one assignment, calls the model, and returns
  rows. Pass it with `--agent-executor ./executor.mjs`. It runs with the full access
  of your process; Dogsled does not sandbox it.
- `--agent-executor typesafe` uses the built-in TypeSafe classification executor for
  models that pick one fixed choice per row, with a `typesafe` model role.

The [agentic-pairs example](../../examples/agentic-pairs/) contains a reference
executor that calls the model role's provider through `@bobsled-inc/bobsled-core/ai`, and
a loop executor for `agent_loop` steps.

## Run and resume

Try the full cycle without an AI provider, using the deterministic test executor
from the agentic-mock example. Copy that example folder from the repository into a
project where Dogsled is installed, then create its input table:

```bash
dogsled query "CREATE TABLE pairs AS SELECT 'pair-' || lpad(CAST(i AS VARCHAR), 3, '0') AS pair_id, 'Fictional evidence only' AS evidence FROM range(1,21) AS t(i)" \
  --db-path data.duckdb
export SHOWCASE_MODEL_KEY=synthetic-test-model-key
```

The executor stops the process on purpose after ten assignments when
`SHOWCASE_CRASH=1` is set:

```bash
SHOWCASE_CRASH=1 dogsled model run +pair_assessments --integration local \
  --agent-executor ./mock-executor.mjs --agent-run-id first-run \
  || echo "stopped with exit code $?"
```

```text
Agentic run ID: first-run
...
stopped with exit code 137
```

Resume the same run. Dogsled reuses the ten accepted results and only sends the
other ten assignments:

```bash
dogsled model run +pair_assessments --integration local \
  --agent-executor ./mock-executor.mjs --agent-run-id first-run --agent-resume
dogsled query "SELECT COUNT(*) AS assignments FROM pair_assessments" --db-path data.duckdb
```

```text
...
✓ Executed 2 model operation(s).
assignments
20
```

The `+` before the model name also builds the models it depends on.

Other run flags: `--agent-concurrency` (1 to 64 assignments at a time),
`--agent-min-dispatch-interval-ms` to space out calls,
`--agent-allow-billable-source` to allow paid source queries, and `--dry-run` to
print the plan without calling the executor. On DuckDB, progress is kept in local
checkpoint files; on Postgres, Snowflake, BigQuery and Databricks, in warehouse
tables.

## With a real provider

Point `llm.profile` at a model role with a real provider and key, and pass your
executor. A run sends the prepared rows to that provider and can incur charges.
`dogsled doctor` and `dogsled ai test` check the role first; see
[Embeddings and AI providers](embeddings-and-ai.md).
