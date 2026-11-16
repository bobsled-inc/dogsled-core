# Programmatic source-query API (`@bobsled-inc/bobsled-core/source-query`)

The lazy/live source-query engine that powers the `dogsled source-query` (alias
`vq`) CLI is also importable as a library. This lets a host application drive the
engine directly — injecting source definitions, the default destination, a
warehouse SQL runner, and API secrets in memory, without requiring a
`sources/*.yml` tree or a `.bobsled/config.yml` on disk.

All injection points are **additive and optional**. When omitted, the engine
behaves exactly like the CLI: it loads `sources/*.yml` from `projectRoot`, reads
the default destination from `.bobsled/config.yml`, and resolves API secrets from
`process.env`.

## Export surface

```ts
import {
  LazyQueryEngine,
  runQueryCommand,
  resolveDestinationFor,
  createSqlRunnerFor,
  loadApiResourceEntries,
  sourceNameOf,
  resolveSourceMaterializerFlags,
  referencedSources,
  maxSqlLimitLiteral,
  isMissingTableError,
  resolveModelReferences,
  detectModelReferences,
  stageWarehouseSourceIntoDuckDb,
  createRunnerDuckDbDestination,
  materializeWarehouseLeaf,
  DEFAULT_WAREHOUSE_LEAF_ROW_CEILING,
  analyzeDeployedModelProject,
  planDeployedModelExecution,
} from '@bobsled-inc/bobsled-core/source-query';

import type {
  RunQueryArgs,
  RunQueryResult,
  LazyQueryEngineDeps,
  ApiResourceEntry,
  ResolvedDestination,
  ResolveDestinationArgs,
  SourceMaterializerFeatureFlags,
  ResolveModelReferencesOptions,
  StageWarehouseSourceArgs,
  StageWarehouseSourceResult,
  MaterializeWarehouseLeafArgs,
  MaterializeWarehouseLeafResult,
  WarehouseLeafReadMode,
  DeployedModelAnalysis,
  DeployedModelExecutionPlan,
} from '@bobsled-inc/bobsled-core/source-query';
```

## Planning deployed definitions without a project directory

Hosts that store committed Dogsled definitions in a database can pass the parsed
source and model objects directly to Dogsled. No temporary project directory is
needed.

`analyzeDeployedModelProject` validates all definitions and returns, for every
derived model:

- `materialized` or `on_read` execution mode;
- whether the model mixes live and materialized roots;
- the dependency-first model closure;
- the live and materialized source leaves.

`planDeployedModelExecution` does the same analysis for one target model and
also returns a self-contained DuckDB SELECT plus source bindings. Every source
binding has a request-local `sources.__bobsled_source_N` table, so two
Connections can safely use the same source name. `entry` is the original
deployed source used to fetch rows. `runtimeEntry` is the same source bound to
the internal table for Dogsled's query-time runner.

This planner is intentionally DuckDB-only. Its SQL is a fixed contract for
Dogsled's query-time DuckDB runner, not portable warehouse SQL. The planner does
not accept a dialect option.

The planner only validates definitions, analyzes dependencies, assigns safe
table names, and produces SQL. It does not fetch data or run SQL. It does not
enforce row, byte, or time limits. The host must supply and enforce limits. The
host also owns credentials, staging, execution, cancellation, and cleanup.

The integration tests prove that deployed live and mixed plans can run through
existing DuckDB helpers with host-supplied limits. They do not make the planner
an execution runner.

```ts
const plan = planDeployedModelExecution({
  sources: deployedSourceDefinitions,
  models: deployedModelDefinitions,
  model: 'orders_with_usernames',
});

for (const binding of plan.sourceBindings) {
  // Fetch from binding.entry and stage the bounded rows at binding.internalTable.
}

const rows = await duckdb.query(plan.sql);
```

The plan contains definitions and SQL only. It never contains credentials or
execution controls.

## Querying derived models (`resolveModelReferences`)

`runQueryCommand` only resolves `sources.<name>` references. To let a query reference a **derived
Model Spec model** by name (`SELECT ... FROM <model>`), run `resolveModelReferences` first — a pure SQL
front-end that compiles each referenced model to a self-contained SELECT (over `sources.<name>`,
upstream models folded into CTEs via `inlineDeps`) and splices it in as a leading CTE. Hand the
result to `runQueryCommand` unchanged; a query that references no models is returned byte-identical.

```ts
const resolvedSql = await resolveModelReferences(sql, projectRoot);
const result = await runQueryCommand({ sql: resolvedSql, projectRoot, apiResourceEntries });
```

Hosts whose models do not live on disk can inject the project via
`ResolveModelReferencesOptions` (`project`, `loadProjectImpl`, `compileProjectImpl`). Resolution is
pure-read — nothing is persisted; a live-rooted model recomputes from a fresh fetch on each query.

## Minimal end-to-end example

```ts
import {
  LazyQueryEngine,
  createSqlRunnerFor,
  type ApiResourceEntry,
} from '@bobsled-inc/bobsled-core/source-query';

// 1. Provide source definitions in memory (no sources/*.yml needed).
//    Build these from your own config, or load them with
//    loadApiResourceEntries(projectRoot) and filter the result.
const apiResourceEntries: ApiResourceEntry[] = [/* ...resolved api_resource source entries... */];

const engine = new LazyQueryEngine({
  projectRoot: '/tmp/ephemeral-project', // only used for the scratch temp dir
  apiResourceEntries,

  // 2. Inject the default destination instead of reading .bobsled/config.yml.
  //    `dest` selects the kind; remaining fields mirror default_destination.
  defaultDestination: {
    dest: 'duckdb',
    dbPath: '/tmp/cache.duckdb',
    targetSchema: 'analytics',
  },

  // 3. Optionally supply your own warehouse SQL runner. When provided it is used
  //    alongside defaultDestination, which still supplies the dest kind + schema.
  //    Credentials in defaultDestination may be omitted when a runner is injected.
  createSqlRunnerImpl: async ({ destination }) => createSqlRunnerFor({ destination }),

  // 4. Pass resolved API secrets without mutating process.env. These flow through
  //    to the extractor transport auth resolution.
  secrets: {
    GH_TOKEN: process.env.MY_RESOLVED_GITHUB_TOKEN,
  },
});

const result = await engine.runQuery('SELECT id FROM sources.issues LIMIT 100');
console.log(result.rows);
for (const receipt of result.receipts) console.log(receipt);
```

The same options can be passed directly to the functional entrypoint:

```ts
const result = await runQueryCommand({
  projectRoot,
  sql: 'SELECT id FROM sources.issues',
  apiResourceEntries,
  defaultDestination: { dest: 'duckdb', dbPath, targetSchema: 'analytics' },
  secrets,
});
```

## Pure-live vs mixed-live

- **Pure-live (in-memory DuckDB).** When every referenced source is `mode: live`,
  the engine materializes each API result into a throwaway in-memory DuckDB
  database and runs the SQL there. Nothing is persisted, and no warehouse is
  required — `defaultDestination` can be omitted for purely live queries because
  live sources resolve to an in-memory target. This is the cheapest path for
  ad-hoc reads and isolated tests.

- **Mixed-live (warehouse scratch table).** When live sources are joined with
  persisted (`mode: lazy` / `mode: extract`) sources, the persisted snapshots stay
  in their configured warehouse and the live API results are staged into
  short-lived warehouse scratch tables so the final join executes on a single
  engine. Here you supply a real `defaultDestination` (and optionally a
  `createSqlRunnerImpl`) so the engine has a warehouse to stage into and clean up
  after the query completes.

## Staging a warehouse leaf into the engine (mixed models)

`resolveModelReferences` resolves a derived model's refs to `sources.<name>`, but
it does not move any data — it assumes each `sources.<name>` table already exists
in the engine. For a **mixed model** that joins live/lazy API sources with a
`warehouse_table` source from a different warehouse, the host must first copy that
warehouse table into the engine so the join resolves locally.

`stageWarehouseSourceIntoDuckDb` is that copy step, exposed as a standalone brick:
it reads a `warehouse_table` source through a caller-provided runner, writes it as
`sources.<name>` in a DuckDB / DuckLake engine, and returns the row count. The host
supplies the runner (its own credentialed connection to the source warehouse), so
no integration files or credentials are read from disk.

```ts
import {
  stageWarehouseSourceIntoDuckDb,
  createRunnerDuckDbDestination,
  createSqlRunnerFor,
  resolveDestinationFor,
  resolveModelReferences,
} from '@bobsled-inc/bobsled-core/source-query';

// 1. A DatabaseDestination over the engine (a DuckDB file, or a DuckLake catalog).
const engineRunner = await createSqlRunnerFor({
  destination: await resolveDestinationFor({ entry: someLiveLeaf, projectRoot }),
});
const database = createRunnerDuckDbDestination(engineRunner);

// 2. Copy the foreign warehouse table in as `sources.accounts` using the host's
//    own runner for that warehouse (e.g. a Snowflake/BigQuery connection).
await stageWarehouseSourceIntoDuckDb({
  entry: accountsWarehouseEntry, // a warehouse_table SourceRegistryEntry
  sourceName: 'accounts',
  schema: 'sources',
  database,
  sourceRunner: hostWarehouseRunner,
  dialect: 'snowflake',
  tempDir,
});

// 3. Point the model's source ref at the staged table, then fold + run as usual.
//    Rewrite the warehouse leaf's fqRef to `sources.accounts` in the project you
//    pass to resolveModelReferences (the engine's source registry), so the model
//    compiles `FROM sources.accounts`.
const sql = await resolveModelReferences(querySql, projectRoot, { project });
```

The brick preserves `BIGINT` precision (values are carried as strings through the
JSONL hop and cast back to the declared column type on load), and matches source
columns case-insensitively (warehouses like Snowflake return upper-cased keys).
The `dogsled model run` CLI uses this same brick internally for live mixed views;
exposing it lets a host application stage
warehouse leaves into its own engine and keep its existing query-time fold.

## Read modes for a warehouse leaf (`materializeWarehouseLeaf`)

`stageWarehouseSourceIntoDuckDb` is a dumb copy — it re-reads the whole warehouse
table every call. For a mixed model that reads the same warehouse table on every
query, that re-copy is wasteful for a slowly-changing dimension table and unsafe
for a large one. `materializeWarehouseLeaf` wraps the brick with the **same
freshness engine** an `api_resource` leaf uses, so a warehouse leaf gets two
per-reference read modes:

- **`live`** — re-read the warehouse table fresh on every call. Never cached.
- **`lazy`** — stage once, reuse the staged snapshot within `maxAge`, re-stage
  when it ages out. Keyed by `(sourceName, currentFilterHash)` in the engine's
  generic `_bobsled_source_metadata` table — the exact table lazy API sources
  already use, so a host that already runs lazy API sources on its DuckLake reuses
  it as-is. With no `maxAge`, a `lazy` leaf is reused indefinitely once staged.

The read mode is a **call argument**, not a field on the `warehouse_table` source
entry: the same warehouse model can be read `live` by one mixed model and `lazy`
by another, so the choice rides on the reference. `lazy` staleness is **time-based
only** — a `lazy` leaf can serve a snapshot up to `maxAge` old; it does not track
the warehouse model's own re-materialization schedule.

```ts
import {
  materializeWarehouseLeaf,
  createRunnerDuckDbDestination,
  DEFAULT_WAREHOUSE_LEAF_ROW_CEILING,
} from '@bobsled-inc/bobsled-core/source-query';

const database = createRunnerDuckDbDestination(engineRunner); // DuckDB or DuckLake
const receipt = await materializeWarehouseLeaf({
  entry: accountsWarehouseEntry, // a warehouse_table SourceRegistryEntry
  sourceName: 'accounts',
  schema: 'sources',
  database,
  engineRunner, // drives the freshness metadata store + table-existence probe
  sourceRunner: hostWarehouseRunner, // host's own credentialed source connection
  dialect: 'snowflake',
  tempDir,
  mode: 'lazy',
  maxAge: '15m',
  currentFilterHash: 'accounts', // stable cache key (no pushed predicate yet)
  nowIso: new Date().toISOString(),
  maxRows: DEFAULT_WAREHOUSE_LEAF_ROW_CEILING, // OOM safety floor
});
// receipt.action is 'reused' on a cache hit, 'materialized'/'live' on a (re)stage.
```

`maxRows` is the **OOM safety floor**: the brick buffers the whole leaf in memory
for the JSONL hop, so an unbounded warehouse table can OOM the host (e.g. a small
Cloud Run instance). When set, the read is bounded to `maxRows + 1` and the stage
aborts with a `CommandError` — before the rows are written — if the leaf exceeds
the ceiling. A host with tight memory should pass its own ceiling rather than the
generous `DEFAULT_WAREHOUSE_LEAF_ROW_CEILING`.

Predicate pushdown for `live` leaves (reading only the rows the outer query needs)
is a separate, not-yet-built extension to the brick; until then a `live` leaf
reads the full (capped) table.

## Notes

- `LazyQueryEngineDeps` is `Omit<RunQueryArgs, 'sql'>`; the `LazyQueryEngine`
  constructor takes those deps and `runQuery(sql, opts?)` merges per-call
  overrides on top.
- `RunQueryResult` exposes `rows`, the per-source `receipts`, and `totalMs`.
- The SQL must reference sources via the reserved `sources.<name>` namespace; the
  engine rewrites those references to the resolved physical tables.
