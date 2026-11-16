# `@bobsled-inc/model-spec` — Programmatic API

Every Model Spec CLI verb is available as a library function. Hosts that want to drive
`compile` / `run` / `validate` / `test` / `lineage` / `seed` pipelines without
shelling out to the `dogsled model` CLI can import the same orchestrators the CLI itself
uses. Layer 1 primitives (`compileAll`, `buildModelRegistry`, `generateSql`,
`TransformSpecSchema`, ...) stay frozen — hand-rolled flows like the host application
app's `data-model-compilation-service.ts` keep working byte-for-byte.

## Entry points

| Layer            | Import                                   | What it gives you                                                                                                              |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Primitives    | `from '@bobsled-inc/model-spec'`         | Raw compiler: parsers, DAG, codegen, registries.                                                                               |
| 2. Loader        | `from '@bobsled-inc/model-spec/project'` | `loadProject(cwd)` — parse a project on disk into a typed `LoadedProject`.                                                     |
| 3. Orchestrators | `from '@bobsled-inc/model-spec/project'` | `compileProject`, `runProject`, `validateProject`, `testProject`, `lineageProject`, `validateSeeds`, `loadSeeds`, `diffSeeds`. |
| File-less        | `from '@bobsled-inc/model-spec/project'` | `compileInMemory` — for hosts whose model YAML lives outside the filesystem.                                                   |

## Compile a project on disk

```ts
import { compileProject } from '@bobsled-inc/model-spec/project';

const result = await compileProject(process.cwd(), {
  integration: 'duckdb', // optional — omit to fan out over every integration
  models: ['fct_orders'], // optional — default is all models
  strict: true, // optional — reject implicit raw_sql fallbacks
});

for (const group of result.byIntegration) {
  console.log(`-- ${group.handle} (${group.dialect})`);
  for (const r of group.results) {
    if (r.ok) console.log(r.sql);
    else console.error(`${r.modelName}: ${r.error}`);
  }
}
```

`CompileProjectResult` groups results by integration and carries `warnings`,
`skipped` integrations, and optional `metadata` (metrics / relationships / VQs)
when `includeMetadata: true`.

## Run against a warehouse

`runProject` resolves runners via `@bobsled-inc/connections` — pass a
`SecretResolver` for `${{ env.VAR }}` interpolation and a `CustomRunnerRegistry`
for host-specific variants (e.g. `(snowflake, sledhouse_oidc)`).

```ts
import { runProject, buildSecretResolver } from '@bobsled-inc/model-spec/project';

const result = await runProject(process.cwd(), {
  fullRefresh: false,
  secretResolver: buildSecretResolver(process.env),
});

for (const group of result.byIntegration) {
  console.log(`${group.handle}: ${group.results.filter((r) => r.ok).length} ok`);
}
```

## Validate, test, lineage

All three mirror the same `byIntegration` shape.

```ts
import { validateProject, testProject, lineageProject } from '@bobsled-inc/model-spec/project';

const vr = await validateProject(cwd);
if (!vr.ok) throw new Error('validation failed');

const tr = await testProject(cwd);
for (const group of tr.byIntegration) {
  for (const t of group.tests) {
    console.log(`-- ${t.modelName}::${t.testName}\n${t.sql}`);
  }
}

const lr = await lineageProject(cwd);
// Each group has { models: DagNode[], effectiveTiers: Map<string, TrustTier> }
```

## Seeds

Seeds split into three entry points so hosts pick the runner requirement that
matches their need:

```ts
import { validateSeeds, loadSeeds, diffSeeds } from '@bobsled-inc/model-spec/project';

validateSeeds(cwd); // parse + CSV checks only
await loadSeeds(cwd, { runner }); // compile SQL, optionally execute
await diffSeeds(cwd, { query: runnerModule.query }); // compare CSV vs warehouse
```

## File-less compile (`compileInMemory`)

For hosts that store model YAML outside the filesystem (for example, a host that
persists specs in a database), `compileInMemory` takes already-parsed
`TransformSpec`s plus a `SourceRegistry` and returns `CompileResult[]`:

```ts
import { TransformSpecSchema, quoteIdentifier, type SourceRegistry } from '@bobsled-inc/model-spec';
import { compileInMemory } from '@bobsled-inc/model-spec/project';

const spec = TransformSpecSchema.parse(yamlParsed);
const sources: SourceRegistry = new Map([
  [
    'raw_orders',
    `${quoteIdentifier('RAW', 'snowflake')}.${quoteIdentifier('RAW_ORDERS', 'snowflake')}`,
  ],
]);

const result = compileInMemory({
  models: [{ name: spec.name, spec }],
  sources,
  dialect: 'snowflake',
  targetSchema: 'ANALYTICS',
});
```

The function does the DAG topo sort, `buildModelRegistry`, and `compileAll`
internally — a drop-in replacement for hand-rolled orchestration loops.

## Layer 1 primitives (unchanged)

Existing consumers keep their imports. The primitives re-exported from the
package root (`compileAll`, `buildModelRegistry`, `buildSourceRegistry`,
`parseTransformSpec`, `parseTransformSpecFromParsed`, `generateSql`,
`generateSelectSql`, `generateTestSql`, `materializeSql`, `executeSqlStatements`,
`TransformSpecSchema`, `SourceSpecSchema`, `SeedSpecSchema`, `ResolutionSpecSchema`,
`quoteIdentifier`, `quoteLiteral`, `caseName`, `resolveDialectProfile`,
`supportsDialectCapability`, `loadState`, `saveState`, `computeChecksum`,
`stateKey`, `migrateLegacyState`, `inferDagIntegrations`, `filterDagByIntegration`,
`filterSourceRegistry`) have the same signatures and semantics they had before
this API.

The host application compatibility guardrail at
`tests/integration/ai-app-compat.test.ts` pins the exact contract the host application
relies on; breaking it requires a coordinated migration.

## Error model

`loadProject` and `validateProject` normalize boundary failures into the typed
`BobsledRuntimeError` exported by the project entry point. Validation failures
have `kind: 'validation'`, and their `cause` retains the original
`CommandError` when callers need its exit code or detailed message. Catch the
typed error instead of assuming every failure is a `CommandError`:

```ts
import { CommandError, BobsledRuntimeError, loadProject } from '@bobsled-inc/model-spec/project';

try {
  await loadProject(cwd);
} catch (error) {
  if (error instanceof BobsledRuntimeError) {
    if (error.kind === 'validation' && error.cause instanceof CommandError) {
      console.error(error.cause.message);
    } else {
      throw error;
    }
  } else {
    throw error;
  }
}
```

Per-integration compile, validation, and test findings remain in each
orchestrator's result. Check `result.ok` for compile and validation results,
and inspect `byIntegration` for test findings.
