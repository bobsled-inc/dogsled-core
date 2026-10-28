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
| `limits`                           | No       | Run limits and default assignment limits; see below                           |
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
| `limits`                     | No          | Override per-assignment limits                                                         |
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
  tokens: 100000
  timeout_seconds: 600
  tokens_per_assignment: 16000
  tool_calls_per_assignment: 8
  model_calls_per_assignment: 12
```

All values are optional positive integers or `null`. `null` means no limit at
model level. The timeout maximum is 2,147,483 seconds; token and call counts must
be safe JavaScript integers.

| Field                        | Scope                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| `tokens`                     | Total tokens across steps and attempts in this run                   |
| `timeout_seconds`            | Execution window, including preparation, dispatch waits, and retries |
| `tokens_per_assignment`      | Token allowance for one assignment attempt                           |
| `tool_calls_per_assignment`  | Tool-call allowance for one assignment attempt                       |
| `model_calls_per_assignment` | Model-call allowance for one assignment attempt                      |

A step may override only the three per-assignment fields. Omission inherits the
model value. Explicit `null` removes that inherited cap:

```yaml
# Within a step:
limits:
  tokens_per_assignment: null
  tool_calls_per_assignment: 4
```

The run's total token limit still applies. If only that total is set, one
assignment reserves all remaining capacity and other assignments wait for it to
settle. Set a per-assignment token allowance to share a finite total across
concurrent assignments. Each retry gets fresh call limits, but all token charges
count toward the same run total.

The legacy CLI `--agent-tokens-per-assignment` and host `tokensPerAssignment`
options are fallbacks only when neither YAML level specifies the field. There is
no implicit 8,192-token CLI cap. YAML takes precedence, including explicit `null`.

Usage remains recorded without limits. Unknown usage consumes a finite
reservation; without one, the charged total is only a lower bound. An explicit
retry opens a fresh time window but keeps the original token charges and attempt
counts. Cancellation, permission checks, retry counts, and storage limits remain
active even when all YAML limits are omitted. Executors must enforce call limits
across their internal calls. Provider and host limits may be stricter.

These controls do not enforce a dollar ceiling. The reference executors use the AI
client's observe mode; `platform.budget` and profile dollar budgets are not a
substitute for an agentic execution budget. A custom executor must document its
own cost policy.

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

Assignments and outcomes use inline JSON with a 1 MiB limit, at most 1,000 rows,
16 levels, and 16,384 JSON nodes. Split oversized work upstream; Dogsled rejects
overflow instead of silently truncating it. See the [executor contract](../../../packages/model-spec/docs/agentic-contracts.md)
for the exact wire format.

## Final checks

Supported model tests are `not_null`, `unique`, and `accepted_values`. Supported
expectations are `primary_key`, `non_null`, `unique`, `in_range`, `regex`,
`schema_contains`, `row_count_between`, and `accepted_values`. They gate publication
and run against the staged target, including retained rows. Warning-severity
expectations, custom SQL tests, and custom/expression expectations are rejected
before agent calls. See [publication checks](../../../packages/model-spec/docs/agentic-publication.md#checks-and-schema-policy)
for required fields and database preflight behavior.
