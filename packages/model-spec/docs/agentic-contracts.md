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

Reserve token capacity before each provider call. A reservation belongs to the
attempt. The runner saves its full assignment reservation before dispatch.
Internal call receipts spend from that allowance in memory. A crash retains the
full unfinished reservation; accepted completion saves the final charge.
A direct-call attempt makes one
call; hidden SDK retries must be disabled. Agent loops reserve for every internal
call. Outcomes report totals across all calls within that attempt.

Measured usage contains input, output and total tokens. Total equals input plus
output, including any provider reasoning tokens in output. Unknown usage is explicit,
with an unavailable or interrupted reason. `agenticChargeableTokens` charges the
full finite reservation for unknown usage. With no reservation, unknown usage
remains unknown; the charged total is a lower bound. It never clamps a measured overrun. An overrun must stop further dispatch and fail the run
if the shared limit is exhausted. Outcome totals must not be charged a second time
in addition to already settled calls.

Start the elapsed clock before preparing the run and persist the deadline.
An explicit retry opens a new execution window with the model's configured timeout.
Assignment retries and automatic lease recovery share that window and cannot extend
it. The original token budget and assignment attempt limits remain in force. The later coordinator must stop dispatch at cancellation or exhaustion,
forward the signal to active provider/source operations, and await settlement.
A promise timeout alone is not cancellation. After a required failure exhausts
retries, cancel remaining work and await settlement before reporting failure.
The bounded runner persists retry counts and the original limits in execution state.

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

Set model limits as defaults. A step can override the three per-assignment limits:

```yaml
limits:
  tokens: 3000000
  timeout_seconds: 3600
  tokens_per_assignment: 256000
  tool_calls_per_assignment: 16
  model_calls_per_assignment: 32
plan:
  steps:
    - id: research
      # Other step fields omitted here.
      limits:
        tokens_per_assignment: null
        tool_calls_per_assignment: 4
```

An omitted model limit is unlimited. An omitted step field inherits the model
value. A step value of `null` disables that inherited per-assignment limit.
The total token budget and execution timeout belong to the model; steps cannot
turn them off. Each assignment attempt gets fresh call limits. Token use from
all attempts counts toward the model total.

Omit the entire `limits` block to disable all these limits. Cancellation, source
permissions, output validation, retry counts, and storage size bounds still apply.
Providers and hosting platforms can impose their own limits.

The legacy library `tokensPerAssignment` option remains an explicit fallback
when neither YAML level supplies a value. The CLI no longer supplies a default
of 8192. Prefer YAML for new projects. Existing numeric YAML limits keep their
meaning. Changing limits changes checkpoint identity; start a new run.

When only a model token budget is set, one assignment reserves the remaining
budget. Other assignments wait for it to settle. Configure a per-assignment
allowance to share a finite budget across concurrent work. Executors receive
`null` for unlimited tokens or deadlines, and optional `tool_calls` and
`model_calls`. Executors must enforce call limits across all their internal calls.
A direct `llm_call` still means one model call.

Usage is recorded even without a cap. Unknown usage remains marked `unknown`.
With a finite reservation, unknown usage charges that reservation. Without one,
no amount can be estimated: the charged total includes only known charges and
is not proof of zero cost. JSON checkpoints use `null`, never numeric infinity.
The same checkpoint contract applies to local files and all warehouse stores.
