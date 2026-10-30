# Agentic model and executor contracts

Canonical contract validation lives under `@bobsled-inc/model-spec/agentic`.
Model discovery recognizes agentic definitions, and the
[experimental dispatch probe](agentic-dispatch.md) can run a mixed graph with a
host-supplied fake executor. The SQL compiler still rejects agentic plans.
[Execution state and restart](agentic-state.md) use local or supplied storage.
[Database publication](agentic-publication.md) adds atomic target replacement and receipt recovery.

For setup and authoring, see the [user guide](../../../docs/guides/agentic-models.md).
For application integration, see the [host guide](agentic-hosts.md).
The first proving case uses prepared undecided pairs. Agent advice does not grant
permission to merge entities. Derived models prepare inputs and apply policy.

## Public surface and ownership

```typescript
import {
  AgenticModelSpecSchema,
  ModelSpecSchema,
  resolveAgenticModel,
  AgentAssignmentSchema,
  AgentExecutorRequestSchema,
  createAgentAssignmentOutputSchema,
  parseAgentAssignmentOutcome,
  agenticChargeableTokens,
  type ExecuteAgent,
} from '@bobsled-inc/model-spec/agentic';
```

Zod schemas own serialized contracts. TypeScript types are inferred from them.
The normal package build generates the public `.d.ts` files. Do not edit generated
files. The executor uses the same contract through the public package subpath.
Provider SDKs remain outside model-spec. No new workspace dependency is required.

| Owner               | Responsibility                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Author              | Sources, steps, grouping, instructions, output columns, profiles and keys                      |
| Dogsled host        | Discover input schemas, bind profiles, prepare bounded data, supply callbacks and cancellation |
| Executor            | Perform one assignment and return an explicit outcome with usage                               |
| State store         | Freeze references, select accepted attempts, save results and completion, maintain limits      |
| Publication adapter | Check required completion, replace processed keys atomically, reconcile publication receipts   |

`ModelSpecSchema` accepts agentic contracts and existing derived contracts.
It does not route either one to an executor. Existing derived definitions need no
new field; they may explicitly declare `model_kind: derived`.

## Model definition

```yaml
spec_version: '0.2'
type: model
model_kind: agentic
name: pair_assessments
description: Assess prepared pairs without authorizing a merge.
grain: [pair_id]
sources:
  pairs: { ref: undecided_pairs }
llm: { profile: review }
limits:
  tokens: 100000
  timeout_seconds: 600
plan:
  steps:
    - id: assess
      source: { ref: pairs }
      map: { over: pairs, group_by: [pair_id] }
      execution: { mode: llm_call }
      instructions: Assess only the supplied evidence and return advice.
      columns:
        - { name: pair_id, type: string, nullable: false }
        - { name: assessment, type: string, nullable: false }
output: { from: assess }
materialization:
  type: table
  strategy: replace_processed_keys
  keys: [pair_id]
```

Execution mode and `output.from` are required. Each step declares exactly one map
or reduce group. `source.ref` and `over` name the same source alias or earlier step.
Steps are in dependency order. Reduce reads an earlier step's saved findings.
A reduce step can read several earlier steps through a list in `reduce.over`;
`source.ref` must match its first entry. Each named bundle retains its schema,
rows, and completion markers, including successful empty results.

Columns use the shared protocol field types: string, integer, number, boolean,
timestamp, date, array and object. Nullability is explicit. SQL expressions,
warehouse type aliases, and vector values are not part of this executor wire
format. The host must supply normalized input types and known nullability; it must
reject an unsupported conversion rather than guess. Timestamps are ISO strings
with an offset; dates use `YYYY-MM-DD`. Integers must be safe JavaScript integers.

Names are unique ignoring case. References and key names must match their declared
spelling. Grain and replacement keys must name non-null scalar output columns.
Every step preserves its grouping and replacement keys, including their types.
Model-level `execution.engine`, `execution.staging`, and publication settings reuse
the existing schemas. Their presence does not establish warehouse support.

## Schema and profile resolution

`resolveAgenticModel(definition, { inputs, platform })` takes a registry of normalized
input column lists keyed by existing source/model references. It copies the inferred
schema into each resolved step. Later steps read the declared output columns plus
Dogsled metadata. Authors do not write a second input schema.

The profile comes from `platform.models[step.llm.profile ?? model.llm.profile]`.
Missing profiles fail with the shared validation error contract before any call.
Connection configuration uses the shared `ModelConnectionSchema`, including its
ban on literal API keys. The resolved profile contains its selected name and
validated connection configuration. Environment references are not resolved to
secret values in this contract. The trusted executor resolves provider credentials
through the existing AI layer. Source credentials never enter assignments.

A model reference equal to the current model name means the old published target.
Resolution supplies its output schema without adding a self dependency. The CLI
source adapter reads the old target and treats a missing first-run target as empty.
The pure resolver does not read the warehouse or prove target compatibility.

Search-only sources do not need a prepared column list. The source gateway
resolves and validates their actual capabilities. Direct calls receive no source
access. Agent loops inherit declared source aliases unless the step restricts them.
A step cannot grant an undeclared source.

## Prepared assignments and executor requests

`AgentAssignmentSchema` validates the serializable payload:

- `contract_version: 2` and model, run, step, shard and attempt identities.
- `definition_ref` and `input_snapshot_ref`, which refer to host-owned frozen artifacts.
- Instructions, resolved skills with versions, and the selected model profile.
- `input`: reference, inferred columns, and prepared rows.
- `group_key`: one explicit assignment group.
- `processed_keys`: the complete selected replacement-key set, independent of result rows.
- `output`: columns, grain and replacement keys.
- `limits`: the token allowance, original run start time, and current execution deadline.
- Execution mode and permitted source references, resolved from model aliases.

References are opaque host identifiers, not paths or URLs to open automatically.
The host owns their resolution, retention, access controls and immutable identity.
This slice supports inline JSON only: at most 1 MiB per assignment or outcome,
1,000 rows, 16 levels and 16,384 JSON nodes. Larger work must be split or rejected;
it must not be truncated. Handles and streaming transports require a later contract.

`AgentExecutorRequestSchema` wraps the payload with an `AbortSignal` and host-owned
`budget.reserve` and `budget.settle` functions. Only an `agent_loop` request contains
`sources`, a callable source gateway. Extra fields fail validation, including a source
callback on `llm_call`. Functions and signals never belong in persisted payloads.

The source callback accepts `{ source, operation, arguments }`. `source` is the
actual declared reference, such as `research.web_search`, not its model alias.
`operation` must be `read` or `search`. Arguments are bounded JSON. This
contract is not a second source catalog. The gateway must validate operations and
arguments against the existing source definition, enforce scope and billing
permission, and return bounded data. A callback type or prompt is not a sandbox.
A caller-supplied module must be trusted. The reference loop gives the model only
structured decisions and source callbacks; it does not execute generated code.
This protects against model output requesting unrelated capabilities. It does not
sandbox arbitrary JavaScript supplied by the host.

The CLI loads a local module exporting `executeAgent: ExecuteAgent` through
`--agent-executor`. An embedding host supplies the function directly. Reference
direct and loop executors are in `examples/agentic-pairs`.

A supplied `AgenticHost.sources` adapter receives the validated request plus
`{ assignment, signal }`. The adapter owns credentials, supported arguments,
source restrictions, billing policy, response bounds, and cancellation. It must
never return credentials or raw provider errors. The reference loop expects
`{ rows, retrieved_at }`, with a host-generated retrieval timestamp.

## Outcomes and acceptance

Every outcome includes the contract version, attempt ID and usage. Outcomes are:

| Status                  | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `succeeded`             | Completed assignment; `rows` may be empty                                      |
| `insufficient_evidence` | Completed domain outcome with rows, possibly empty, and a fixed reason object  |
| `failed`                | Execution failure with no rows; error kind, code and retryability are explicit |

Failure kinds reuse `DOGSLED_RUNTIME_ERROR_KINDS`. Error payloads exclude raw provider
messages and causes. Hosts render the shared public messages and keep any private
diagnostics out of saved results. Cancellation and timeout remain failures that
prevent publication; they cannot be converted into successful empty results.

`parseAgentAssignmentOutcome` checks the attempt ID, output types and nullability,
exact row fields, grouping, replacement keys, output grain and metadata. It rejects
foreign keys and duplicate findings. It does not commit data or prove that this
attempt still owns the assignment. The execution coordinator adds conditional durable
acceptance and rejects late or duplicate commits even if a result passes this parser.

A successful empty result completes the explicit processed keys. Publication removes
the old findings for those keys. Missing work and failed work never count as empty
success. Empty selected model input produces no assignments and is a successful
no-op in the runner. That is distinct from one completed assignment with zero rows.

## Usage and cancellation rules

Executors report measured usage for every provider call. A direct-call attempt
makes one call; hidden SDK retries must be disabled. Outcomes report totals across
all calls within that attempt.

Measured usage contains input, output and total tokens. Total equals input plus
output, including any provider reasoning tokens in output. Unknown usage is
explicit, with an unavailable or interrupted reason.

New runs use spend-cap accounting:

- When an attempt starts, Dogsled saves a charge equal to its input estimate (about
  four bytes per token). An interrupted attempt keeps that charge.
- When it finishes, measured usage replaces the estimate. Unknown usage keeps the
  estimate. Hosts that supply `priceUsage` also get a charge in US dollars.
- `budget.reserve` and `budget.settle` remain for compatibility. `reserve` always
  succeeds for spend-cap runs and `settle` records usage. Executors may keep calling
  them; an executor that reserves less than it uses is no longer stopped.
- Every valid answer that finishes is accepted, even when it pushed the run over
  its cap or finished after the deadline. Caps and deadlines stop new dispatch only.
  Answers that finished before another assignment failed for good are saved too.
- A cost cap cannot be applied to a run saved with the older accounting; Dogsled
  refuses `maxCostUsd` for such a run instead of ignoring it.

Runs saved before this change have no `accounting` marker. They keep the original
rules on resume: a full token reservation is charged before each call, unknown
usage charges the whole reservation, and a measured overrun stops the run.
`AgenticRunOptions.accounting: 'reservation'` still creates such runs; it is
deprecated.

Start the elapsed clock before preparing the run and persist the deadline.
An explicit retry opens a new execution window with the model's configured timeout.
Assignment retries and automatic lease recovery share that window and cannot extend
it. The coordinator stops dispatch at cancellation, forwards the signal to active
provider/source operations, and awaits settlement. A promise timeout alone is not
cancellation. After a required failure exhausts retries, it cancels remaining work
and awaits settlement before reporting failure.

## Errors

Every agentic failure message is safe to print and save. Provider text, row data
and credentials never appear in it.

| Error                    | Raised when                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `AgenticStateError`      | Run state, limits, deadlines, storage. Has `code`, and `reason` and `hint` when known |
| `AgenticAssignmentError` | An assignment failed for good. Has the step, shard, attempts and executor error       |
| `AgenticHostError`       | A host callback failed: preparation, executor or source access                        |

State error messages start with `Agentic state <code>` and, when known, the
reason, for example `Agentic state limit (spend_cap_reached): ...`. Reasons include
`spend_cap_reached`, `estimate_exceeds_cap`, `pricing_unknown`, `deadline_passed`,
`definition_changed`, `run_not_found`, `invalid_checkpoint`, `invalid_option`,
`snapshot_too_large`, `state_directory_full` and `usage_overflow`.

An executor result that fails validation is saved as a retryable failed attempt
with code `invalid_executor_output`; it is never accepted. If the assignment then
fails for good, the message lists the invalid fields, by name only.

`formatAgenticError(error)` renders an error and its safe causes. A cause that is
not a Dogsled error is shown only by its type, a system code such as `ENOSPC`, and
a numeric HTTP status, for example `caused by: APICallError (status 429)`. The CLI
and `runProject` results use it.

## Reserved metadata

Executor rows contain the three nullable judgment fields below. Dogsled supplies
`_dogsled_run_id` only after acceptance. An executor cannot return that field.

| Column                | Contract                                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| `_dogsled_run_id`     | Non-null string assigned by Dogsled; untouched rows retain their original value |
| `_dogsled_evidence`   | Null or a nonempty array of evidence objects                                    |
| `_dogsled_confidence` | Null or a number from 0 to 1; not a calibrated probability                      |
| `_dogsled_reason`     | Null or `{ summary, supporting_factors, conflicting_factors }`                  |

Evidence contains `source`, `reference`, nullable `support_excerpt`, and
`retrieved_at`. A record or document reference need not be a URL. Sources must
identify prepared input, permitted source access, or evidence retained in the
prepared input. Retaining a citation does not grant fresh access to its source. Dogsled never invents citations,
reasons or confidence, and never averages confidence values. Metadata structure
checks do not prove that a citation supports a claim.

## Follow-up boundaries

Built-in publication supports DuckDB, PostgreSQL, Snowflake, BigQuery, and
Databricks. The bounded runner
supports acceptance, staging, empty output, target identity, and receipt recovery
through its public publisher contract. Direct calls, agent loops, and multi-step map/reduce plans use
this same path. All external plan inputs are frozen before execution; context
reads during agent loops can still fetch fresh data. See the publication guide
for the host ownership restrictions.

Tests are deterministic and use synthetic inputs. The three fixtures cover a
prepared-pair model, successful empty completion and failure. Run the focused suite
with `pnpm --filter @bobsled-inc/model-spec exec vitest run tests/unit/agentic`.

For one-row choice classification with TypeSafe, see [Jev classification](./jev-classification.md).

## Optional execution limits

Set spend caps and a timeout at model level:

```yaml
limits:
  max_cost_usd: 25
  tokens: 3000000
  timeout_seconds: 3600
```

All fields are optional; omission or `null` means no limit. Before each assignment
starts, the coordinator compares spend so far with the caps. At a cap it stops
dispatch, lets running assignments finish, saves their answers and fails with
`spend_cap_reached`. Raise the cap and resume to continue; caps are not part of the
saved definition. `AgenticRunOptions.maxCostUsd` overrides `max_cost_usd` for one
invocation, and the CLI exposes it as `--agent-max-cost`.

`max_cost_usd` needs `AgenticHost.priceUsage` and a known price for every profile
in the plan, or the run fails with `pricing_unknown` before any call. Before the
first call of a run, the coordinator refuses a first step whose input estimate
alone is above a cap (`estimate_exceeds_cap`).

`tokens_per_assignment`, `tool_calls_per_assignment` and
`model_calls_per_assignment`, at model or step level, and the legacy
`tokensPerAssignment` host option are deprecated and ignored by new runs.
Executors receive `null` for the assignment token limit and no call limits; they
must bound their own loops. The reference loop executor stops after 16 turns.

Cancellation, source permissions, output validation, retry counts, and storage
size bounds always apply. Providers and hosting platforms can impose their own
limits. JSON checkpoints use `null`, never numeric infinity. The same checkpoint
contract applies to local files and all warehouse stores.
