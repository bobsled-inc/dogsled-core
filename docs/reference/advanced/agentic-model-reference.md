# Agentic model YAML reference

<!-- last-reviewed: 2026-09-23 -->

This reference describes the current `spec_version: '0.2'` agentic model contract.
For a complete first model, start with [Build an agentic model](../../guides/agentic-models.md).
Definitions live in the project's models directory, usually `models/`.

## Model fields

| Field                              | Required | Meaning                                                                       |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `spec_version`                     | Yes      | `'0.2'`                                                                       |
| `type`                             | Yes      | `model`                                                                       |
| `model_kind`                       | Yes      | `agentic`                                                                     |
| `name`                             | Yes      | Model identifier                                                              |
| `description`                      | Yes      | What the model does                                                           |
| `grain`                            | Yes      | Columns that uniquely identify an output row                                  |
| `sources`                          | Yes      | One to 256 aliases, each with a `ref` and optional `incremental.cursor_field` |
| `llm.profile`                      | Yes      | Default role name under `platform.models` in `dogsled.yml`                    |
| `limits`                           | No       | Run spend caps and timeout; see below                                         |
| `plan.steps`                       | Yes      | One to 256 steps in dependency order                                          |
| `output.from`                      | Yes      | ID of the step whose rows are published                                       |
| `materialization.type`             | Yes      | `table`                                                                       |
| `materialization.strategy`         | Yes      | `replace_processed_keys`                                                      |
| `materialization.keys`             | Yes      | Columns identifying the processed records to replace                          |
| `target_schema`, `target_database` | No       | Output location through the normal model target rules                         |
| `tests`, `expect`                  | No       | Supported final checks that must pass before publication                      |

Unknown fields are rejected. Alias and step names must be unique ignoring case;
step names must also be distinct from aliases. References and key names must use
the declared spelling.

An alias may reference a source, an upstream model, or this model's own name.
A self-reference reads the previously published target and is empty when that
target does not yet exist. It does not form a dependency cycle. Other dependency
cycles are rejected.

The schema accepts the shared model-level `execution` and `publish` fields, but
the mixed agentic runner currently rejects these explicit settings. It does not
support cross-warehouse compute/publication. Step-level `execution` is required
and has a different purpose.

## Step fields

| Field                        | Required    | Meaning                                                                                |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `id`                         | Yes         | Unique step identifier                                                                 |
| `source.ref`                 | Yes         | Source alias or earlier step; equals the first `over` input                            |
| `map` or `reduce`            | Exactly one | Input selection and grouping                                                           |
| `map.over`                   | Map only    | One source alias or earlier step ID                                                    |
| `reduce.over`                | Reduce only | One earlier step ID or a list of earlier step IDs                                      |
| `group_by` inside map/reduce | Yes         | Nonempty list of grouping columns                                                      |
| `execution.mode`             | Yes         | `llm_call` or `agent_loop`                                                             |
| `execution.tools`            | No          | Extra host tool names for an agent loop                                                |
| `context_sources`            | No          | Source aliases available for extra reads during an agent loop                          |
| `llm.profile`                | No          | Override the model's default profile for this step                                     |
| `limits`                     | No          | Deprecated per-assignment limits; ignored by new runs                                  |
| `instructions`               | Yes         | Nonempty instructions, up to 65,536 characters                                         |
| `columns`                    | Yes         | One to 256 output business columns                                                     |
| `classification.choices`     | No          | Two to 255 named choices for supported classification executors                        |
| `skills`                     | No          | Accepted by the contract, but authored skills are rejected by the current mixed runner |

Every step must preserve the grouping and materialization keys and their types.
The selected output must contain every grain and replacement-key column as a
non-null scalar. For intermediate steps, Dogsled uses the model grain when those
columns exist; otherwise it uses grouping and replacement keys together.

A direct call makes one model call and has no source callback or extra tools.
An agent loop may make several calls and use authorized context sources and host
tools. The executor must support the chosen mode and any classification contract.

### Context sources and host tools

| Setting           | Omitted                           | Empty list            | Nonempty list              |
| ----------------- | --------------------------------- | --------------------- | -------------------------- |
| `context_sources` | All declared model source aliases | No extra source reads | Only the named aliases     |
| `execution.tools` | Host's approved `supportedTools`  | No extra host tools   | Only named supported tools |

Step-level `sources` is a deprecated alias for `context_sources`; using both is an
error. These declarations do not grant credentials or paid-call approval. Host
tools need implementations and per-call authorization in the executor host.
Changing the effective tool set changes checkpoint identity, including when a
host changes its defaults.

## Limits

```yaml
limits:
  max_cost_usd: 25
  tokens: 2000000
  timeout_seconds: 3600
```

All fields are optional. `null` or omission means no limit.

| Field             | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `max_cost_usd`    | Spend cap for the run in US dollars, priced from measured token usage |
| `tokens`          | Spend cap for the run in tokens, across all steps and attempts        |
| `timeout_seconds` | Execution window, including preparation, dispatch waits, and retries  |

### How the caps work

A cap stops new work; it does not cut off work that is already running.

1. Before each assignment starts, Dogsled compares what the run has spent so
   far with the cap.
2. Under the cap, the assignment starts.
3. At or over the cap, no new assignment starts. Assignments that are already
   running finish, and their answers are saved.
4. The run then stops with `Agentic state limit (spend_cap_reached)`. The
   message gives the amount spent, the cap, and how many assignments are done.

Raise the cap and resume the run to continue. The resumed run keeps all saved
answers and does not repeat them:

```bash
dogsled model run +pair_assessments --agent-executor ./executor.mjs \
  --agent-run-id <id> --agent-resume --agent-max-cost 50
```

You can raise a cap in YAML or with `--agent-max-cost`, which overrides
`limits.max_cost_usd` for one invocation. Changing a cap does not count as a
changed definition.

**Overshoot.** A run can go over its cap by about the cost of the work that is in
flight when it reaches the cap, roughly `--agent-concurrency` times the cost of
one assignment.

**Up-front check.** Before the first model call of a run, Dogsled estimates the
input size of the first step at about four bytes per token. If that estimate
alone is above the cap, the run stops before any model call with
`estimate_exceeds_cap`. The estimate counts input only, so the real cost is
higher.

**Unreported usage.** When a provider does not report usage for an attempt,
Dogsled charges that attempt's input estimate. An interrupted attempt keeps the
estimate it was charged when it started.

**Pricing.** `max_cost_usd` needs a known price for every model profile the plan
uses. The CLI uses Dogsled's built-in price table. If a model has no price, the
run stops before any model call with `pricing_unknown`; use `tokens` as the cap
for that model instead. Library hosts supply prices through
`AgenticHost.priceUsage`.

### Deprecated per-assignment limits

`tokens_per_assignment`, `tool_calls_per_assignment` and
`model_calls_per_assignment`, at model or step level, are still accepted but are
ignored by new runs. So are the CLI `--agent-tokens-per-assignment` option and the
host `tokensPerAssignment` option. Executors bound their own loops; the reference
loop executor stops after 16 turns. `dogsled model run` prints a warning naming each ignored field.
If a loop runs out of turns, the failure explains how to raise the limit.

Runs saved by an earlier Dogsled version keep the per-attempt reservation rules
they started with when you resume them.

## Output types and metadata

Each business column has `name`, `type`, and explicit `nullable`; `description`
is optional. Supported types are `string`, `integer`, `number`, `boolean`,
`timestamp`, `date`, `array`, and `object`. Integers must be safe JavaScript
integers. Timestamps use ISO strings with an offset; dates use `YYYY-MM-DD`.
Vector values, SQL expressions, and warehouse-specific type names are not part
of the executor output contract.

Dogsled adds four columns to the published table:

| Column                | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `_dogsled_run_id`     | Run that produced this row; set by Dogsled after acceptance                       |
| `_dogsled_evidence`   | Null or a nonempty list of evidence observations                                  |
| `_dogsled_confidence` | Null or a number from 0 to 1; not a calibrated probability                        |
| `_dogsled_reason`     | Null or an object with `summary`, `supporting_factors`, and `conflicting_factors` |

The executor supplies the three nullable judgment fields, including explicit null
when unknown. It must not return `_dogsled_run_id`. Evidence contains `source`,
`reference`, nullable `support_excerpt`, and `retrieved_at`. Sources must refer to
supplied input, permitted context, retained evidence, or declared tools.
Retrieval times come from actual observations. Shape validation does not prove
that a citation supports a claim. Dogsled does not invent evidence or average
confidence values.

Each prepared input and the model's final output hold at most what the run's state
store holds: 10,000 rows and 16 MiB on the row store on DuckDB, PostgreSQL and
Snowflake, which includes the DuckDB run files the CLI uses by default, and 1,000 rows
and 1 MiB elsewhere. Each row, and each assignment and outcome sent to an executor, holds at
most 16,384 JSON values, 16 levels, and 1 MiB, and one assignment holds at most 1,000
rows. When a limit is exceeded, the error names the input, the limit, and the row.
Dogsled never truncates silently: split oversized work upstream, or use an
incremental input to process a large table in batches. The whole run checkpoint is
limited to 128 MiB on the row store and 16 MiB elsewhere. See
[row store limits](../../../packages/model-spec/docs/agentic-state.md#row-store-limits)
and the [executor contract](../../../packages/model-spec/docs/agentic-contracts.md)
for the exact wire format.

## Final checks

Supported model tests are `not_null`, `unique`, and `accepted_values`. Supported
expectations are `primary_key`, `non_null`, `unique`, `in_range`, `regex`,
`schema_contains`, `row_count_between`, and `accepted_values`. They gate publication
and run against the staged target, including retained rows. Warning-severity
expectations, custom SQL tests, and custom/expression expectations are rejected
before agent calls. See [publication checks](../../../packages/model-spec/docs/agentic-publication.md#checks-and-schema-policy)
for required fields and database preflight behavior.
