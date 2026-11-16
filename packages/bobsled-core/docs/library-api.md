# Library API

Host applications can embed Dogsled Core through the package's exports. This page collects the
programmatic contracts that were previously in the npm README. For the command line, see the
[user documentation](../../../docs/README.md).

## Programmatic runtime contracts

Project Skill hosts use the native-dependency-free `@bobsled-inc/bobsled-core/project-skills` subpath:

```typescript
import {
  buildProjectSkillsManifest,
  getProjectSkill,
  loadProjectGuide,
  loadProjectSkills,
  validateProjectSkills,
} from '@bobsled-inc/bobsled-core/project-skills';

const skills = await loadProjectSkills('/srv/project');
const skill = await getProjectSkill('/srv/project', 'project-overview');
const guide = await loadProjectGuide('/srv/project');
await validateProjectSkills('/srv/project');
const snapshot = await buildProjectSkillsManifest('/srv/project');
```

The four composite APIs validate the Project guide by default: `loadProjectSkills`,
`getProjectSkill`, `validateProjectSkills` and `buildProjectSkillsManifest`.

Pass `guide: false` for a Skills-only call, or pass `guide: { maxFileBytes }` to
override its read limit.

The CLI equivalents are `dogsled skill validate --no-guide` and
`dogsled doctor --no-guide`.

When a Skill declares references, these APIs read model and pipeline names from
the Project's pipeline config to resolve them. They check its structure but not
credential declarations, so they need no host options and keep working after a
host secret is removed. Project validation still enforces declarations. The
`declaredEnvNames` and `hostManagedModelAuth` options are still accepted and have
no effect.

Project Skills and the Project guide are guidance, not authority. Loading a
reference does not grant access to its model, Resource, Action, or pipeline.

See the [Project guide and skills](../../../docs/guides/project-skills.md) for formats,
manifests, and adapter workflow.

Dogsled exposes project compilation and persisted-manifest validation from
`@bobsled-inc/bobsled-core/manifest`:

```typescript
import { generateProjectManifest, parsePipelineManifest } from '@bobsled-inc/bobsled-core/manifest';

const generated = await generateProjectManifest({ projectRoot: '/srv/project' });
const persisted = parsePipelineManifest(JSON.parse(await readManifest()));
```

`generateProjectManifest` discovers `dogsled.yml`, performs the same full cross-validation used by
the CLI, resolves extract resources, and emits the canonical v6 `dogsled.pipeline.dag` manifest. The
default validation catalog is generated at build time and contains no runtime integration YAML or
execution-package imports, so server and serverless bundlers do not need to trace Dogsled's private
integration package. Hosts with their own integration registry can inject the same narrow interface:

```typescript
import { generateProjectManifest } from '@bobsled-inc/bobsled-core/manifest';
import {
  createValidationCatalog,
  type ValidationCatalog,
} from '@bobsled-inc/bobsled-core/validation';

const validationCatalog: ValidationCatalog = createValidationCatalog(hostIntegrationSnapshot);
const generated = await generateProjectManifest({ projectRoot: '/srv/project', validationCatalog });
```

The injected catalog instance is reused for source/resource validation, entity variants, `for_each`
grouping, secret enumeration, and manifest generation. The lower-level `generateManifest` API keeps
its existing `integrations` option for callers that already provide resolved pipelines.

The parser accepts historical v1-v5 manifests plus v6 and rejects malformed or semantically invalid
graphs with stable issue codes and paths. v6 uses the `BOBSLED_CORE_PIPELINE_*` command contract, retains
source/model `warehouse` IDs, and can carry an extract-only managed `destination_warehouse` ID
without changing task commands.

Use `@bobsled-inc/bobsled-core/resources` for small, request-time Resource reads from a server host.
It exposes lookup and query operations without adding the Resource runtime to Dogsled's root import:

```typescript
import { lookupResource, queryResource } from '@bobsled-inc/bobsled-core/resources';

const controller = new AbortController();

const users = await lookupResource({
  integration,
  resource: userLookupResource,
  input: { user_id: 'u-123' },
  secrets: requestSecrets,
  signal: controller.signal,
  limits: {
    maxRecords: 1,
    maxResultBytes: 64 * 1024,
    maxNetworkRequests: 2,
  },
});

const search = await queryResource({
  integration: exaIntegration,
  resource: exaSearchResource,
  search: 'recent warehouse security guidance',
  limit: 5,
  secrets: requestSecrets,
  signal: controller.signal,
  authorizeBillable: async ({ billing }) => approveCost(billing),
});
```

Pass validated Integration and Resource specs from the current project. Pass secrets for the
current request; do not copy them into a Resource. `queryResource()` can list a Resource that has
no `query:` block when no filter or search is passed. Use `limit` to bound that list. A lookup
returns at most one record. By default, it allows at most three upstream request attempts,
including safe retries. A billable Resource fails before the network call unless
`authorizeBillable` returns `true`. For a lookup, the approval context includes
`maxNetworkRequests`, so the host can approve the highest possible request cost.

For a Resource with canonical `extract.for_each` ancestors, use the additive graph API instead of
reimplementing bindings in the host. `planQueryFanOut()` is pure and returns a serializable v1
contract. `queryResourceFanOut()` does not write extraction state: `targeted` makes only the target
request when every required target input is known, while `fan_out` enumerates the declared ancestor
chain with correlated bindings, contextual `output.from` values, bounded concurrency, cancellation,
and aggregate budgets. `requiredRootInputs` identifies inputs a host must provide for fan-out; a
missing required input is rejected before provider access. A requested `limit` returns
`limitReached`; safety-budget exhaustion throws `QueryFanOutError` and never returns partial data.

```typescript
import { planQueryFanOut, queryResourceFanOut } from '@bobsled-inc/bobsled-core/resources';

const plan = planQueryFanOut({ resources: deployedResources, target: 'events' });
const result = await queryResourceFanOut({
  integration,
  resources: deployedResources,
  target: 'events',
  mode: 'fan_out',
  plan,
  // Repeat non-default planning policy here when the plan used it.
  maxDepth: 5,
  maxResources: 20,
  limits: { maxProviderAttempts: 100, maxParentWorkItems: 100 },
  secrets: requestSecrets,
  signal: controller.signal,
});
```

The v1 contract is intentionally small and JSON-safe. Plans contain `target`, root-to-target
`topologicalOrder`, role-tagged `nodes`, parent/child `edges`, exact binding tuples
(`field`, `input`, and `source`), `for_each.where`, effective concurrency, required root inputs,
every contextual ancestor referenced by `output.from`, and a canonical SHA-256 fingerprint of the
target-chain Resource definitions. Pass the same exact target-chain Resource specs to planning and
execution; a supplied plan that no longer matches them is rejected. When planning with non-default
`maxDepth` or `maxResources`, pass the same policy to execution. Effective edge concurrency is
carried by the plan; `limits.maxConcurrency` can enforce a stricter execution ceiling.

`QueryFanOutLimits` defaults to 100 parent work items, 9,999 mapped target rows, 100 provider
attempts, 64 MiB of mapped rows across the graph, concurrency 4, and a five-minute deadline. Every
HTTP/MCP page, retry, redirect, and authentication retry consumes the shared attempt budget.
`QueryResourceFanOutResult.counts` reports `parentWorkItems`, `targetRows`, `providerAttempts`,
their explicit `requestCount`/`resultCount` aliases, `mappedBytes`, observed `maxConcurrency`, and
`durationMs`. These are execution counters, not extraction state. Host overrides remain bounded by
hard safety ceilings: 10,000 parent work items, target rows, or provider attempts; 256 MiB mapped
bytes; concurrency 64; and a 30-minute deadline.

`QueryFanOutError` is the fail-closed boundary. It preserves the original `cause` and exposes a
stable `code`, Dogsled `kind`, `phase`, target/current/parent Resource context, the complete binding
tuple and safe parent ordinal when applicable, aggregate counts, retryability, provider status, the
bounded/redacted provider message/cause chain, and an optional host `correlationId`. Requested row limits may return
successful rows with `limitReached: true`; exhausting any safety limit throws and never returns
partial rows. Any provider or child failure fails the complete operation.

In `targeted` mode, all required target and parent-derived inputs must be supplied. Dogsled makes no
ancestor request and only projects ancestor context that the canonical binding tuple proves; nested
or unrelated `output.from` context is rejected before the target request. In `fan_out` mode, Dogsled
queries ancestors first, keeps multi-input bindings correlated, applies `for_each.where` before
child scheduling, preserves stable parent/page order, and maps only target rows. Query-time
execution never reads or mutates extractor bookmarks, batches, or durable state.

Use `@bobsled-inc/bobsled-core/actions` for request-time writes:

```typescript
import { executeAction } from '@bobsled-inc/bobsled-core/actions';

const preview = await executeAction(action, input, {
  dryRun: true,
  resolvedIntegration: integration,
  secrets: requestSecrets,
});

// The host app shows the preview and gets approval before this call.
const receipt = await executeAction(action, input, {
  resolvedIntegration: integration,
  secrets: requestSecrets,
  signal: controller.signal,
  limits: { timeoutMs: 30_000, maxResponseBytes: 256 * 1024 },
  safeErrors: true,
});
```

`dryRun` builds a safe preview and does not send the write. Dogsled does not grant approval by
itself. The host app must check project policy and user approval before it calls `executeAction`
without `dryRun`. The result is a small receipt with success or a stable error code; it does not
return the full upstream response.

A failed receipt's `error.code` separates a rejected credential (`auth_error`, HTTP 401) from a
service that refused the Action (`permission_denied`, HTTP 403); neither is retryable. When the
failure came from an HTTP response, `error.provider_status` holds its status. For a 4xx response
with a JSON body, `error.provider_message` holds the provider's own reason from `error.message`,
`message`, a string `error`, `detail`, `errors[0].message`, or `error_description`, in that order.
Dogsled removes control and formatting characters, sanitizes URLs, then redacts credential-shaped
text, declared credential values, and the credentials sent with the request, including minted or
refreshed OAuth and custom tokens, authentication header values, and decoded Basic credentials, in
raw, URL-, form- and JSON-encoded forms. It then limits the message to 300 characters. It is
present with `safeErrors`, which still replaces `error.message` with a stable text. Dogsled never
returns the raw body, and omits the field for 5xx responses and for bodies without such a string.

Use `@bobsled-inc/bobsled-core/pipeline` to run a named project pipeline with cancellation, bounded
previews, incremental state handoff, ordered events, and structured per-resource metrics:

```typescript
import { runProjectPipeline } from '@bobsled-inc/bobsled-core/pipeline';

const controller = new AbortController();
const result = await runProjectPipeline({
  projectRoot: '/srv/project',
  pipelineName: 'github',
  resources: ['issues'],
  maxRecords: 100,
  signal: controller.signal,
  state: { streams: {} },
  onEvent: (event) => observe(event),
});
```

For a one-shot Snowflake schema repair, a managed task adapter can add
`reconcileSchema: ['issues']` and `fullRefresh: true` to that invocation. The
override is resolved against the selected resources and forwarded to the
Snowflake loader as `--reconcile-schema`; it is not persisted in the pipeline
manifest. Dogsled's MCP server is currently read-only, so shell-less agents must
reach this API through their external managed task adapter.

When `state` is supplied, Dogsled validates it and uses an isolated project-contained backend for
that invocation; the resulting state is returned and temporary files are removed after every
terminal outcome. Limited runs are previews and therefore do not advance durable state.
Programmatic fan-out failures also remove raw captures, and credential-shaped values are redacted
from returned errors, warnings, metrics, and event callbacks. A resource with protocol metrics but
no attributable child error is reported as `unknown` when the overall pipeline fails.

## Agentic models in a library host

Start with the [user guide](../../../docs/guides/agentic-models.md) for CLI setup,
model authoring, and operations. See the [host integration guide](../../model-spec/docs/agentic-hosts.md)
for executor contracts, source permissions, usage accounting, and verification.

Use `@bobsled-inc/bobsled-core/agentic` to create the same input and source host that
Dogsled uses in the CLI. Supply the loaded project, an executor function, model
profiles, and a secret resolver. No local executor file is needed.

```typescript
import { createAgenticHost } from '@bobsled-inc/bobsled-core/agentic';
import { runProject } from '@bobsled-inc/bobsled-core/model-spec/project';

const host = createAgenticHost({
  project,
  executeAgent,
  platform: { models },
  secretResolver,
  runnerOptions: { customRunners, tokenProvider },
  tokensPerAssignment: 4096,
  concurrency: 3,
});

await runProject(project.cwd, {
  project,
  state,
  secretResolver,
  customRunners,
  tokenProvider,
  agentic: { host, run: { id: runId, mode: 'start' } },
});
```

Configure `checkpoint_store` in the project's `model-spec.yml` when the caller supplies
regular model state. Supply the same SQL runner and credential options to both
functions: the host reads inputs and scoped sources; `runProject` stores
checkpoints and publishes output. The caller owns executor transport, model
profile selection, run identity, and cancellation. Pass the run's `AbortSignal`
to `runProject`. Dogsled passes assignment signals to the executor and its source
callbacks.

This entry point does not start an LLM provider, a workflow, or a sandbox.

To use the built-in Jev classification executor, create it with the same
resolver: `executeAgent: createJevExecutor({ secretResolver })`. The
`secretResolver` option is required. Jev never reads a model key from
`process.env` by itself, and `createJevExecutor` throws when no resolver is
passed. The resolver decides which key names are readable; Jev fails closed
when it rejects a name or returns an empty value.

When your executor signs in to the model provider itself and never reads a
profile's `api_key`, pass `hostManagedModelAuth: true` to `createAgenticHost`.
Profiles then validate without declaring their `api_key` names. Pass the same
option to `validateProjectPipelines`, `resolveProjectPipelines`,
`loadProjectPipelineConfig`, and `generateProjectManifest` from `/manifest`, to
`runProjectPipeline`, and to `resolveAgenticModel`. Pipeline embeddings and
source credentials still need declarations. With `hostManagedModelAuth`,
always pass an explicit `secretResolver`, and leave the option off if you use
the built-in Jev executor. If Jev runs anyway, it reads the key only through its
explicit `secretResolver` and fails when the key is missing.

### Host declaration options

Every entry point that validates, compiles, or runs a Project's pipeline config
accepts the same two options. Both are names only and off by default; no value
is read and no CLI command sets them. `declaredEnvNames` covers `platform.models`
profiles and pipeline embeddings. `hostManagedModelAuth: true` covers only each
profile's own `api_key` name, so an undeclared embedding key still fails. The
Project Skills APIs accept both options for compatibility but do not need them.

| Entry point                                                                                                   | Subpath                      | Where the options go                                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `validateProjectPipelines`, `resolveProjectPipelines`, `loadProjectPipelineConfig`, `generateProjectManifest` | `/manifest`                  | options object                                         |
| `loadBobsledConfig`                                                                                           | package root and `/manifest` | second argument                                        |
| `parseReverseEtlProject`                                                                                      | `/reverse-etl`               | third argument (`ReverseEtlHostDeclarations`)          |
| `runProjectPipeline`                                                                                          | `/pipeline`                  | options object, with `env`                             |
| `createAgenticHost`                                                                                           | `/agentic`                   | `hostManagedModelAuth`; names via `secretResolver`     |
| `resolveAgenticModel`                                                                                         | `/model-spec/agentic`        | context: `declaredSecretNames`, `hostManagedModelAuth` |

For API resources stored by the host, pass `integrationSpecLoader` to
`createAgenticHost`. It accepts the same arguments as `loadQueryableResourceSpecs`
from `/integrations`: given an integration name, resource name, and options,
return the integration and resource definitions accepted by `queryResource`,
including source specs with named transports. The host owns
project overrides and any fallback to the bundled catalog. An undefined result
or loader error stops the read; Dogsled does not fall back after a supplied loader
fails. Without a loader, Dogsled uses the bundled catalog.

Dogsled still resolves secrets through `secretResolver` and enforces assignment
source permissions, paid-source approval, cancellation, and response limits.
Loading a paid resource definition does not authorize a paid request. This option
does not change the warehouse used to read model inputs or publish output.

Source callback failures keep the original error in a non-enumerable `cause` for
trusted host diagnostics. The public message remains generic. The cause can
contain private data or credentials: do not send it to an agent, serialize it
into a response, or log it without removing sensitive details. Dogsled's assignment
source boundary strips this cause before it reaches the executor.
