# Integrate an agentic host

<!-- last-reviewed: 2026-09-23 -->

Use this guide when embedding Dogsled in an application or writing an executor.
For model authors, start with the [user guide](../../../docs/guides/agentic-models.md).
The host runs trusted code; the model receives only the capabilities the executor
exposes to it.

## Public package entry points

Install the published `@bobsled-inc/dogsled` package. Its subpaths expose the
host factory, project runner, and contracts without requiring consumers to
install private workspace packages:

| Import                                    | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `@bobsled-inc/dogsled/agentic`            | `createAgenticHost`, `createJevExecutor`, host options               |
| `@bobsled-inc/dogsled/model-spec/agentic` | Model/assignment schemas, executor types, state and publication APIs |
| `@bobsled-inc/dogsled/model-spec/project` | `loadProject`, `buildSecretResolver`, `runProject`                   |
| `@bobsled-inc/dogsled/ai`                 | Provider-neutral generation helpers for custom executors             |

Inside this repository, model-spec code uses the owning workspace's public
`@bobsled-inc/model-spec/agentic` entry point. Do not import across package source
directories or add provider SDKs to model-spec.

## Create a host and run a model

This example runs the pair project with a trusted local executor. The executor
module must export `executeAgent`; use the reference module from the example as a
starting point. Model profiles remain application-supplied configuration.

```typescript
import { createAgenticHost } from '@bobsled-inc/dogsled/agentic';
import {
  buildSecretResolver,
  loadProject,
  runProject,
} from '@bobsled-inc/dogsled/model-spec/project';
import { executeAgent } from './executor.mjs';

const projectDirectory = '/srv/pair-project';
const project = await loadProject(projectDirectory, { skipEntities: true });
const secretResolver = await buildSecretResolver(projectDirectory, undefined);
const controller = new AbortController();
const host = createAgenticHost({
  project,
  executeAgent,
  secretResolver,
  platform: {
    models: {
      review: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        api_key: '$OPENAI_API_KEY',
      },
    },
  },
  concurrency: 3,
  minDispatchIntervalMs: 200,
});

const result = await runProject(projectDirectory, {
  project,
  models: ['+pair_assessments'],
  integration: 'local',
  secretResolver,
  signal: controller.signal,
  agentic: {
    host,
    run: { id: 'pairs-20260923', mode: 'start' },
  },
});
```

Retain the run ID and use `mode: 'resume'` to continue it. Wire application
cancellation to `controller.abort()`. Do not discard the run promise while its
executor or warehouse calls are still active.

The factory supplies normalized input schemas, bounded warehouse preparation,
and scoped source callbacks. `runProject` selects and closes the built-in
publisher. A caller-supplied publisher remains the caller's responsibility to
close. The factory does not start a provider session, create a sandbox, or run a
workflow on its own.

If your application supplies regular model `state`, also configure
`checkpoint_store` in `model-spec.yml` or pass `agentic.stateStore`. Save returned regular
state as usual. Confirmed agentic publication adds a completion entry in
`result.state.models` under `<integration>.<model>` with the saved table location.
Dry runs, failed publication, and experimental probes do not register completion.
Agentic checkpoints and shared input cursors remain separate from regular state.

Pass the same `customRunners` and `tokenProvider` to the factory's `runnerOptions`
and to `runProject`. Input/source reads, checkpoints, and publication must use
compatible connections and credentials. For custom input preparation, apply
`context.incremental.after` before the row limit, honor `maxRows`, `maxBytes`, and
`signal`, and reject unsupported type conversions. Never truncate an input to fit.
A host that sets `incrementalBatches: true` receives `context.incremental.batch` and
must then return incremental rows ordered by the cursor field, including at least one
row past the row or byte limit when more rows exist; Dogsled keeps the ordered prefix
that fits. Source adapters show the executor a `CommandError` message; keep those
messages free of credentials and row data.

## Implement an executor

The public `ExecuteAgent` type accepts a request containing:

- `assignment`: serializable identity, instructions, profile, prepared input,
  group and processed keys, output schema, limits, and allowed capabilities.
- `signal`: cancellation for this attempt.
- `budget.reserve` and `budget.settle`: token accounting around every model call.
- `sources`: a host callback present only for `agent_loop` requests.

Keep callbacks and signals out of stored payloads. `definition_ref` and
`input_snapshot_ref` are opaque host references, not URLs or file paths for an
executor to open. The host owns their resolution and retention.

Use the [direct executor](../../../examples/agentic-pairs/executor.mjs) and
[loop executor](../../../examples/agentic-pairs/loop-executor.mjs) as working
examples. They use Dogsled's public AI helper, disable hidden provider retries, and
validate the complete result. Their prompt/response size limits are example-specific controls in addition
to the model's limits. The loop uses the assignment model-call limit when a saved
older run supplies one, then the `maxTurns` factory option, and otherwise stops
after 16 turns.

For each provider call, pass the attempt signal and report usage on success or
failure. `budget.reserve` and `budget.settle` remain available and are safe to keep
calling. A direct call makes one model call. A loop must bound its own turns; new
runs send no call limits. Handle `null` tokens and deadlines as unlimited; never
serialize numeric infinity. Do not invent measured zero usage when usage is
missing. Report `unknown` with an `unavailable` or `interrupted` reason; Dogsled
then charges the attempt's input estimate. Mark provider errors and missing usage
as retryable so one transient failure does not stop the run. `generateStructured`
failures carry the provider's HTTP `status` when known. Report 401 and 403 as kind
`auth`, not retryable, with measured zero usage: providers do not bill a rejected
request, and retrying cannot fix a bad key. Report 429 as a retryable provider
failure with code `rate_limited`.

Return one of the contract's explicit outcomes:

| Status                  | Required behavior                                                  |
| ----------------------- | ------------------------------------------------------------------ |
| `succeeded`             | Return validated rows, possibly empty, and usage                   |
| `insufficient_evidence` | Return a completed domain result with reason, rows, and usage      |
| `failed`                | Return a safe error kind/code/retryability and usage, with no rows |

Bind the outcome to the exact attempt ID. Preserve grouping/replacement keys,
output grain, types, and nullability. Include the three nullable judgment metadata
fields and leave `_dogsled_run_id` to Dogsled. `parseAgentAssignmentOutcome` checks
these rules, but durable acceptance still belongs to the coordinator. A result
that arrives after ownership loss or cancellation must not become accepted work.

Use `createAgentAssignmentOutputSchema(assignment).toJSONSchema()` for the
executor's output tool. It returns the complete `{ rows: [...] }` schema. Do not
rebuild the envelope or its row limit in the host. Use
`createAgentAssignmentRowSchema(assignment)` only when a host needs a row schema.
Pass the generated JSON Schema to the provider SDK. Do not let the SDK infer a
schema from the Zod input type: the local data guard accepts unknown input before
checking the row. SDKs that use `io: 'input'` can lose the row constraints. Keep
the Zod schema for local validation of the returned answer.

Both helpers bind group keys to their exact values and list the evidence source
names that final validation accepts: prepared input references, allowed sources
and tools, and valid evidence carried by prepared input rows. Prepared input
citations must keep their supplied retrieval time. A source that the assignment
can query live may use a new retrieval time. Put a cited URL in `reference`, not
in `source`.

The envelope permits at most one row when the group fixes the whole output grain.
Other groups permit up to 1,000 rows. Classification requires exactly one row,
an allowed choice, and confidence from zero to one. Other assignments may return
an empty rows array; that is different from returning no answer.

These rules survive JSON Schema transport. An agent runtime can report an invalid
tool submission to the model and let it correct the answer before ending the
assignment. The schema does not itself add retries or change execution limits.
Always run `parseAgentAssignmentOutcome` before accepting output. It also checks
the attempt identity, the complete replacement-key set, multi-row grain
uniqueness, and total data bounds. The schema does not grant tool access or prove
that the evidence supports a claim.

Dogsled saves accepted output, not the executor's internal conversation. A retry
starts the assignment again. Design external work for replay and keep writes out
of read-only source callbacks. Do not report partial work as a successful empty
result after cancellation, timeout, malformed output, or a denied capability.

The reference executors use `costBudgetMode: 'observe'`, so profile and daily
dollar budgets do not apply to them. Use `limits.max_cost_usd` for an agentic
dollar cap. `createAgenticHost` prices usage with Dogsled's built-in price table;
pass `priceUsage` to supply your own prices. Provider credentials and raw errors must stay out of
prompts, results, and checkpoints. See the
[full assignment contract](agentic-contracts.md) for schemas and wire bounds.

## Sources, resources, and tools

The source callback accepts an actual source reference, operation, and bounded
JSON arguments. Model aliases are resolved before dispatch. Only `read` and
`search` are allowed; capabilities still depend on the underlying source. The
built-in adapter uses declared fields, source request mapping, credentials, and
response bounds. Paid sources need `allowBillableSources` approval separately.

For API resources stored by your application, supply `integrationSpecLoader` to
`createAgenticHost`. It takes the same arguments as `loadQueryableResourceSpecs`
from Dogsled's `/integrations` subpath and returns integration/resource definitions
accepted by `queryResource`. The host owns overrides and any catalog fallback.
A supplied loader that fails or returns no definition stops the read; Dogsled does
not silently fall back to its bundled catalog.

Extra host tools use `supportedTools` and the assignment's `allowed_tools`.
When YAML omits `execution.tools`, agent loops inherit approved host defaults.
An explicit list restricts that set; an empty list disables it. Dogsled validates
names and binds the effective set into checkpoint identity. Your executor must
expose only allowed tools and own their implementation, authorization, credentials,
cancellation, call accounting, and audit records. There is no automatic host-tool
dispatch implementation in the factory.

Source/tool data can contain misleading instructions. Keep it in the data channel
of your executor and do not let it change permissions. Evidence from a host tool
must use its declared name, a returned reference, and actual retrieval time.
Dogsled checks shape and allowed names; the host must verify claims against its
observations if it needs proof that a resource was fetched.

Trusted source adapter errors can retain a non-enumerable `cause` for diagnosis.
It may contain credentials or private data. Do not serialize it for the agent or
log it without removing sensitive content. The assignment boundary strips it.

## Persistence and publication

Use the built-in local store for one persistent host or configure a warehouse
checkpoint store for workers that may restart elsewhere. A supplied store must
hold exclusive ownership through execution and publication, fence obsolete owners,
and atomically apply the exported `applyAgenticCheckpoint` transition. Reads return
null only for missing state; storage failures must throw.

For incremental inputs, provide `agentic.cursorStore` or the state store's `cursors`
capability. Dogsled never falls back to local cursors when a supplied store lacks
that capability. Custom cursor stores need atomic ownership replacement to support
fresh-start takeover; older stores without it keep rejecting takeover.

After an uncertain warehouse response, inspect the publication receipt. Never
replay writes merely because the transport failed. Keep target changes and their
receipt in one transaction. Custom runners must preserve the connection/transaction
rules of their database. Prevent external writers from changing managed targets
while publication is active.

See [checkpoint contracts](agentic-state.md) and
[publication contracts](agentic-publication.md) for ownership, lease recovery,
receipts, and retention. `experimentalAgenticProbe` is a test seam; its publication
callback is not durable confirmation and is unsuitable for incremental progress.

## Verify a host or executor change

Use deterministic fake providers and source adapters first. Cover malformed
rows, foreign keys, successful empty results, missing usage, cancellation,
exhausted limits, denied tools/sources, and repeated attempts. Exercise a restart
with accepted work and a commit whose response is lost. Multi-input executors
must preserve named bundles and completed-empty markers.

From this repository, run the relevant focused suites:

```bash
pnpm --filter @bobsled-inc/model-spec exec vitest run tests/unit/agentic
pnpm --filter @bobsled-inc/dogsled exec vitest run tests/unit/runtime/agentic-host.test.ts
```

Run `npm test` in the installed pair example for its executor tests. These use
fake providers. Before deployment, run the credentialed warehouse integration
suite for the chosen database and a small approved live provider test. Local
fake-provider tests do not prove cloud transaction support or live credentials.
