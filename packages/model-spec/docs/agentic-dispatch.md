# Agentic model discovery and dispatch

Dogsled recognizes `model_kind: agentic` in the model dependency graph. A derived
model can prepare its input, and another derived model can reference its declared
output columns, including Dogsled metadata. Agentic plans do not enter the SQL
compiler.

The executable path accepts a fake or caller-supplied executor.
[Database publication](agentic-publication.md) provides atomic output and receipt
commits through `agentic.host` and an automatically selected publisher.
An explicit `agentic.publisher` remains available as a host override. The experimental probe
remains available for dispatch tests.
[Durable execution checkpoints and restart](agentic-state.md) use local or supplied storage. The ordinary derived-only runner retains its existing behavior.

`compileProject` returns agentic definitions in `agenticPlans`, separately from
generated SQL. The SQL-only CLI compiler rejects agentic models rather than
writing an empty SQL file for it.

## Graph and discovery

Agentic `sources` aliases can reference dotted source names or upstream models.
A reference exactly equal to the agentic model's own name means its old published
output; it does not create a dependency on itself. Other cycles and missing
references fail validation.

The model's selected output step supplies its public column schema. Authors do
not repeat that schema on downstream derived models. Model selectors retain their
existing meaning: a bare name selects that model, while `+name` includes upstream
dependencies. Dogsled's host manifest discovery follows the same agentic edges and
keeps the existing shape of externally supplied model metadata.

Pipeline discovery infers an agentic model's warehouse from the source aliases
used as prepared step inputs. A live API source used only by a source tool does
not change that warehouse. Tool-only upstream models remain dependencies, but
do not select compute. This allows a warehouse-backed model to read Notion or
another API during an agent loop without an explicit execution engine.
Validation and compilation retain the project source registry for agentic
contexts so tool sources on other connections remain resolvable. Source access
still follows the aliases authorized by each agentic step.

Library consumers of `DagNode.parsedSpec` must check `model_kind` before reading
SQL-only fields such as `source`, `joins`, or `columns`. Agentic output columns
come from the selected plan step instead.

Lineage keeps the model dependencies and declared agentic output columns. It
marks their column provenance as incomplete because an AI result has no SQL
expression from which to infer exact upstream column use.

## Probe responsibilities

A programmatic host opts in through `RunProjectOptions.experimentalAgenticProbe`.
It supplies:

- The warehouse dialects supported by its probe.
- Normalized input column schemas and `platform.models` profiles.
- Optional YAML token and call limits for assignments.
- A bounded input preparation callback.
- An executor implementing the public `ExecuteAgent` contract.
- A provisional publication callback that finishes before downstream SQL starts.

The coordinator validates the selected model definitions and host capabilities
before execution. It processes one prepared row per group, calls the executor
within the host concurrency limit, validates each outcome, and checks spend
caps and cancellation. The default concurrency is one.
The host must honor the supplied bounds and signal during preparation and
publication. A callback interface does not make arbitrary host code safe.

An executor failure, malformed result, foreign key, invalid metadata, cancellation,
or exhausted limit prevents downstream work from using that model's new output.
A successful result with zero findings remains different from failed work. The
publication seam must use completed keys separately from result rows when replacing
old findings. Empty prepared input is a successful no-op.

The publication callback has the shape `publish(context, rows, processedKeys)`.
For example, reassessing pair A with no findings supplies an empty `rows` array
and `processedKeys: [{ pair_id: 'A' }]`. A host can remove A's old findings while
preserving other pairs. It must not infer completed work from the rows array.

## A fake executor

For the prepared-pair model in the contract guide, a deterministic executor can
return a fixed assessment. The usage values below are synthetic test data:

```typescript
import type { ExecuteAgent } from '@bobsled-inc/model-spec/agentic';

const fakeExecutor: ExecuteAgent = async ({ assignment, budget }) => {
  const pairId = assignment.group_key.pair_id;
  if (typeof pairId !== 'string') throw new Error('Expected a pair_id group');
  const reservation = await budget.reserve(100);
  const usage = {
    status: 'measured' as const,
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  };
  await budget.settle(reservation, usage);
  return {
    contract_version: 2,
    attempt_id: assignment.attempt_id,
    status: 'succeeded',
    rows: [
      {
        pair_id: pairId,
        assessment: 'Needs review',
        _dogsled_evidence: null,
        _dogsled_confidence: null,
        _dogsled_reason: null,
      },
    ],
    usage,
  };
};
```

Supply this as `experimentalAgenticProbe.executeAgent`, alongside the host's
bounded preparation and provisional publication callbacks. Set
`tokensPerAssignment` to at least 100 for this example. Real provider calls and
production publication are not implemented by this fake.

## Current limits

The runner supports ordered map/reduce steps in `llm_call` or `agent_loop` mode.
Reduce steps can combine several earlier steps. A loop requires a trusted source
adapter. See the [step reference](../../../docs/reference/advanced/agentic-model-reference.md#step-fields)
for multi-step authoring.
Unsupported plans and warehouse capabilities fail before work begins.
The mixed runner rejects authored agentic skills and explicit model-level
`execution` or `publish` settings in the selected graph. The experimental probe
also rejects authored `tests`/`expect` checks; durable publication supports the
subset listed in the [publication guide](agentic-publication.md#checks-and-schema-policy).

The probe uses the existing contract bounds for rows and serialized data. It does
not silently truncate oversized input or output. It supplies cancellation and a
shared run deadline, reserves call capacity, and accounts for unknown usage using
the full reservation.

Agentic execution checkpoints use the compatible `agentic` extension in
`.dogsled/model-spec/run-state.json`, or a supplied store. They are separate from regular model
completion. A successful publication probe is evidence of that test only. It is
not a durable warehouse publication receipt. A CLI run without the required host
capability fails clearly.

See [the canonical contracts](agentic-contracts.md) for assignment and outcome
fields, and [execution state and restart](agentic-state.md) for storage, limits and
recovery. Use the [publication API](agentic-publication.md) for durable processed-key
replacement and receipt reconciliation.

## Concurrent assignments

Set `concurrency` on the host to run between 1 and 64 assignments at once. The
default is 1. Set `minDispatchIntervalMs` between 0 and 60,000 to space assignment
starts, including retries. The default is 0. This spacing applies to one model run
in one process; it is not a provider-wide rate limiter.

The CLI exposes `--agent-concurrency` and `--agent-min-dispatch-interval-ms`.
These settings do not alter assignment data. A caller can change them on resume.
Token charges and assignment attempt limits remain unchanged. An explicit retry
opens a fresh execution window; automatic lease recovery does not extend that window.

Before each executor call the coordinator saves the attempt with its input
estimate as a charge. It starts a call only while the run is under its spend caps.
At a cap it starts nothing new, lets active calls finish, saves their answers and
then fails with `spend_cap_reached`. Measured usage replaces the estimate; unknown
or interrupted usage keeps it. See
[optional execution limits](agentic-contracts.md#optional-execution-limits). Runs
saved with the older reservation accounting keep its rules on resume.

Calls may finish in any order. One coordinator saves each returned result and its
usage before that work is complete. It serializes checkpoint changes so parallel
calls do not overwrite each other's state. Final results follow prepared input
order. Required failure stops new calls and cancels active calls. Executors must
honor cancellation: Dogsled waits for them to settle before releasing the store.
Outputs returned after cancellation are not accepted; their attempts remain
charged. Each execution window includes preparation, dispatch waits, and assignment
retries. A later explicit retry starts a new window.

The existing preparation bounds still apply: at most what the run's state store holds
per input, 1,000 rows and 1 MiB by default and 10,000 rows and 16 MiB on the
[row store](agentic-state.md#row-store-limits) on DuckDB, PostgreSQL and Snowflake, with the
per-value limit applied to each row. Built-in preparation requests one extra
row. It rejects overflow rather than truncating, except for incremental inputs, which
are processed in ordered batches; see [incremental agentic inputs](../README.md#incremental-agentic-inputs). DuckDB publication inserts up to 128 rows and
4,096 bindings per batch inside the existing transaction. Other built-in SQL
publishers retain their existing bounded batches. Acceptance checkpoints remain
per attempt, so batching publication does not delay saving completed work.

This implementation does not schedule distributed workers or concurrent model
DAG execution. Agent loops can use scoped sources and declared host tools. Hosts must still prevent conflicting output runs.

## Agent loops

A loop uses the same preparation, saved state, retries, and publication path.
Set the step's `execution.mode` to `agent_loop`. The model's source aliases define
available reads. The step's optional `context_sources` list narrows them. An empty list
permits no reads. Omission allows reads from all declared model sources.
Assignment payloads contain the actual source references.

```yaml
source: { ref: pages }
map: { over: pages, group_by: [page_id] }
execution: { mode: agent_loop, tools: [] }
context_sources: [blocks]
```

Here `pages` provides the prepared rows and `blocks` is available for context
reads. Model-level `sources` still defines both aliases. The old step-level
`sources` spelling is accepted for existing configurations and saved runs;
new configurations should use `context_sources`. Setting both fields is an error.
Rename the field in the next model revision; do not rewrite saved run definitions.

An API source used only as a tool remains in the DAG, but does not become a SQL
input to hydrate before the run. Prepared inputs select the output integration.
A tool may use another connection. Table and model dependencies still run first.

The CLI source adapter uses existing source request mapping and credentials.
Table reads return declared columns only. API reads/searches use the existing
query interface and retain source filters. Paid API sources require explicit
`--agent-allow-billable-source <ref>` authorization. Agent text cannot grant it.

The host gateway rejects undeclared sources, write operations, invalid JSON,
oversized responses, and calls after assignment completion. The CLI adapter also
checks source-specific arguments and limits reads to 100 rows and 64 KiB. A source
with a pinned filter supports read but not search, because the query layer cannot
combine a filter with free-text search. Each rejection reaches the executor as a
safe reason, such as which argument to fix, and the reference loop reports it to the
model, which can try again. Only policy violations fail the assignment.
These are bounded reads, not a claim of exhaustive source coverage.

The reference loop is in `examples/agentic-pairs/loop-executor.mjs`. It uses
structured read, search, and finish decisions. It does not evaluate model-generated
code or expose a shell, arbitrary SQL, files, or direct URL fetching to the model.
Both this executor and any supplied local module are trusted host code. Dogsled
does not provide an OS sandbox for an untrusted module. Retrieved text cannot add
capabilities to the reference loop.

Spend caps and deadlines are optional. See [optional execution limits](agentic-contracts.md#optional-execution-limits).
