/**
 * `runProjectWithLazySources` — Phase 1 bridge between the lazy/live source
 * runtime and the Model Spec model-spec compiler.
 *
 * The two engines historically never met: model-spec builds the model DAG and
 * emits `FROM sources.<name>` assuming the table already exists, while the
 * source-materializer hydrates `live`/`lazy` API sources into a destination but
 * never walks a model DAG. This orchestrator joins them for the common case:
 *
 *   1. Load the project's `api_resource` source entries (or accept injected
 *      ones), keeping only `live`/`lazy` leaves.
 *   2. Resolve a SINGLE shared destination + runner for those leaves, ensure
 *      the `sources` schema + metadata table, and hydrate each leaf ONCE
 *      up-front (a consistent as-of snapshot for the whole run) into
 *      `sources.<name>` via `materializeOneSource`.
 *   3. Hand off to model-spec's `runProject`, which builds the model DAG
 *      against the SAME DuckDB so the just-hydrated `sources.<name>` tables are
 *      visible to the model SELECTs.
 *
 * The load-bearing constraint: the source cache destination
 * (`.bobsled/config.yml` `default_destination`, or the injected
 * `defaultDestination`) and the model integration destination
 * (`integrations/<handle>.yml`) must point at the SAME file-based DuckDB. A
 * `:memory:` database is rejected — it would not be shared across the two
 * separate runner constructions. The orchestrator validates this and errors
 * clearly when they diverge.
 *
 * Out of scope for Phase 1 (deferred): interleaved hydrate+build in topo
 * order, mixed live+lazy-on-different-engines joins, predicate pushdown through
 * the model layer, and `mode` on derived models. See
 * `local-research/live-derived/phase-1-implementation-plan.md`.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createTokenCommandProvider,
  interpolateSecrets,
  loadIntegration,
  resolveRunner,
} from '@bobsled-inc/connections';
import { queryResource as defaultQueryResource } from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import { CommandError } from '@bobsled-inc/protocol';
import {
  analyzeModelDependencies,
  getSourceEntry,
  normalizeSourceRef,
  type ModelDependencyAnalysis,
  type SourceRegistryEntry,
} from '@bobsled-inc/model-spec';
import {
  getExecutionEngine,
  getPublishTarget,
  loadProject,
  runProject,
  type LoadedProject,
  type RunProjectOptions,
  type RunProjectResult,
} from '@bobsled-inc/model-spec/project';

import { resolveDestinationFor, type ResolvedDestination } from './destination-resolver.js';
import { createSqlRunnerFor } from './sql-runner-bridge.js';
import { createRunnerDuckDbDestination } from './runner-duckdb-destination.js';
import { ensureMetadataTable } from './metadata.js';
import { filterHash } from './filter-hash.js';
import { loadApiResourceEntries, sourceReferenceOf, type ApiResourceEntry } from './load-specs.js';
import { materializeOneSource } from './materialize-one-source.js';
import {
  materializeWarehouseLeaf,
  DEFAULT_WAREHOUSE_LEAF_ROW_CEILING,
} from './materialize-warehouse-leaf.js';
import { formatReceipt, type Receipt } from './materializer.js';
import type { SourceMaterializerFeatureFlags } from './feature-flags.js';
import { quoteIdentifier } from './sql-utils.js';
import { localStateDir } from '@bobsled-inc/connections';

export interface RunProjectWithLazySourcesArgs {
  /** Model Spec project root (holds `sources/`, `models/`, `integrations/`, `model-spec.yml`). */
  projectRoot: string;
  /**
   * The model integration handle to build against. Its `integrations/<handle>.yml`
   * must be a file-based DuckDB whose path equals the source cache destination
   * so the hydrated `sources.<name>` tables are visible to the model build.
   *
   * Optional: when omitted and the project has live/lazy leaves, it is
   * auto-selected if the project declares exactly one integration; with multiple
   * integrations a clear error asks for an explicit handle. When the project has
   * no live/lazy leaves the value is forwarded to `runProject` as-is, so
   * `undefined` preserves multi-integration fan-out.
   */
  integration?: string;
  /** Subset of model names — forwarded to `runProject` (subgraph semantics). */
  models?: string[];
  nowIso?: string;
  /**
   * Optional in-memory source entries. When provided they replace the on-disk
   * `sources/*.yml` load so library callers (and tests) can drive the engine
   * without source YAML on disk. Defaults to disk loading.
   */
  apiResourceEntries?: ApiResourceEntry[];
  /**
   * Optional injected default destination, forwarded to the destination
   * resolver to bypass `.bobsled/config.yml`. Must be a file-based DuckDB for
   * the shared-DuckDB seam. Defaults to the on-disk read.
   */
  defaultDestination?: { dest: string } & Record<string, unknown>;
  /** Mockable API fetch; never hits a real API in tests. */
  queryResourceImpl?: typeof defaultQueryResource;
  integrationSpecLoader?: typeof loadQueryableResourceSpecs;
  featureFlags?: Partial<SourceMaterializerFeatureFlags>;
  secrets?: Record<string, string | undefined>;
  /** Pre-loaded project reused for both the guard and the model build. */
  project?: LoadedProject;
  /** Forwarded model-build options (state, callbacks, secretResolver, …). */
  runProjectOptions?: Omit<RunProjectOptions, 'integration' | 'models' | 'project'>;
  /** Receipt sink mirroring `runQueryCommand`'s `onReceipt`. */
  onReceipt?: (line: string) => void;
  // ---- test seams ----
  resolveDestinationImpl?: typeof resolveDestinationFor;
  createSqlRunnerImpl?: typeof createSqlRunnerFor;
  loadIntegrationImpl?: typeof loadIntegration;
  runProjectImpl?: typeof runProject;
}

export interface RunProjectWithLazySourcesResult {
  /** Source-hydration receipts (one per hydrated live/lazy leaf). */
  hydration: Receipt[];
  /** The model-spec `runProject` result. */
  run: RunProjectResult;
}

/** Source leaf modes Phase 1 hydrates. `extract` is left to `dogsled pipeline`. */
const HYDRATED_MODES = new Set(['live', 'lazy']);

/**
 * Materializations the cross-warehouse publisher persists. Mirrors
 * `PERSISTED_PUBLISH_MATERIALIZATIONS` in `run-project.ts`; kept in lockstep so
 * the orchestrator's "is this model published?" decision matches the publisher's.
 */
const PERSISTED_PUBLISH_MATERIALIZATIONS = new Set(['table', 'incremental', 'snapshot']);

/**
 * A model is "published" when `runProject` routes it through the cross-warehouse
 * publisher rather than building it in-place: an explicit `publish:` always
 * publishes, and a persisted materialization with `execution.engine` publishes
 * into that engine. Published models stage their own leaves (API + warehouse)
 * into the target warehouse, so the live orchestrator must NOT hydrate or
 * rewrite their warehouse leaves — doing so double-handles the leaf and makes
 * the publisher re-read a rewritten `sources.<name>` ref from the wrong
 * connection. This predicate keeps the two paths from colliding.
 */
function isPublishedModel(node: LoadedProject['models'][number]): boolean {
  if (getPublishTarget(node.parsedSpec.publish) !== undefined) return true;
  return (
    PERSISTED_PUBLISH_MATERIALIZATIONS.has(node.materialization) &&
    getExecutionEngine(node.parsedSpec.execution) !== undefined
  );
}

function fileBackedDuckDbPath(destination: ResolvedDestination): string {
  if (destination.config.dest !== 'duckdb') {
    throw new CommandError(
      `runProjectWithLazySources requires a file-based duckdb source destination; got dest "${destination.config.dest}". ` +
        'Derived models over live/lazy sources need the source cache and the model build to share one DuckDB file.',
      2
    );
  }
  const dbPath = destination.config.dbPath;
  if (dbPath === ':memory:') {
    throw new CommandError(
      'runProjectWithLazySources requires a file-based duckdb destination, not :memory:. ' +
        'An in-memory database is not shared across the source-hydration and model-build runner constructions.',
      2
    );
  }
  return resolve(dbPath);
}

function modelIntegrationDuckDbPath(
  integrationFile: Awaited<ReturnType<typeof loadIntegration>>
): string {
  if (integrationFile.source_type !== 'duckdb') {
    throw new CommandError(
      `runProjectWithLazySources requires a duckdb model integration; integration "${integrationFile.name}" is "${integrationFile.source_type}". ` +
        'Phase 1 only supports live/lazy-rooted models on a shared DuckDB file.',
      2
    );
  }
  const auth = integrationFile.auth;
  if (auth.type !== 'file') {
    throw new CommandError(
      `runProjectWithLazySources requires a file-based duckdb model integration (auth.type: file); integration "${integrationFile.name}" uses auth.type "${auth.type}". ` +
        'A :memory: integration cannot see the hydrated sources.* tables.',
      2
    );
  }
  return resolve(auth.path);
}

/**
 * Reject persisted materializations rooted on a `live` source leaf. Per the
 * settled decision, a `live` source has no persistent home, so a
 * `table`/`incremental`/`snapshot` model over it would freeze the live data —
 * contradicting "always fresh". Only `view` is persistence-consistent over a
 * live leaf. `lazy` and `extract` leaves are unconstrained here.
 *
 * The model-spec dependency analysis supplies the transitive result. Thus, this
 * guard cannot drift from deployed-model planning.
 */
function assertNoPersistedLiveRootedModels(
  project: LoadedProject,
  analyses: readonly ModelDependencyAnalysis[]
): void {
  const analysisByName = new Map(
    analyses.map((analysis) => [analysis.modelName.toLowerCase(), analysis])
  );
  const persisted = new Set([
    'table',
    'incremental',
    'snapshot',
    'materialized_view',
    'dynamic_table',
  ]);
  for (const node of project.models) {
    if (!persisted.has(node.materialization)) continue;
    if (analysisByName.get(node.name.toLowerCase())?.executionMode === 'on_read') {
      throw new CommandError(
        `Model "${node.name}" uses materialization "${node.materialization}" but is rooted on a live source. ` +
          'Live-rooted derived models must be view-only: a live source has no persistent home, so persisting it freezes the data and contradicts "live". ' +
          'Change this model (and any persisted model between it and the live leaf) to materialization.type: view.',
        2
      );
    }
  }
}

export async function runProjectWithLazySources(
  args: RunProjectWithLazySourcesArgs
): Promise<RunProjectWithLazySourcesResult> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const resolveDestinationImpl = args.resolveDestinationImpl ?? resolveDestinationFor;
  const createSqlRunnerImpl = args.createSqlRunnerImpl ?? createSqlRunnerFor;
  const loadIntegrationImpl = args.loadIntegrationImpl ?? loadIntegration;
  const runProjectImpl = args.runProjectImpl ?? runProject;

  // Hydration opens foreign warehouse runners before `runProject` does. Build
  // the managed provider once here so those source reads and the later model /
  // publish run share the same refreshable credential cache.
  const credentialsTokenCommand =
    args.runProjectOptions?.credentialsTokenCommand ??
    process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'];
  const tokenProvider =
    args.runProjectOptions?.tokenProvider ??
    (credentialsTokenCommand ? createTokenCommandProvider(credentialsTokenCommand) : undefined);

  const project = args.project ?? (await loadProject(args.projectRoot));

  const allEntries =
    args.apiResourceEntries ?? (await loadApiResourceEntries(args.projectRoot, project.index));
  // Tool-only sources are queried by the agent host, not hydrated into SQL tables.
  const toolRefs = new Set<string>();
  const tableRefs = new Set<string>();
  for (const node of project.models) {
    const model = node.parsedSpec;
    if (model.model_kind === 'agentic') {
      for (const source of Object.values(model.sources)) {
        toolRefs.add(normalizeSourceRef(source.ref));
      }
      for (const step of model.plan.steps) {
        const input = model.sources[step.source.ref];
        if (input) tableRefs.add(normalizeSourceRef(input.ref));
      }
    } else {
      for (const ref of node.sourceRefs) tableRefs.add(normalizeSourceRef(ref));
    }
  }
  const leaves = allEntries.filter((entry) => {
    const ref = normalizeSourceRef(sourceReferenceOf(entry));
    return HYDRATED_MODES.has(entry.mode ?? 'lazy') && (!toolRefs.has(ref) || tableRefs.has(ref));
  });

  // Use model-spec's shared dependency analysis for the live-as-view guard.
  // In-memory entries override matching file entries so injected callers and
  // file-loaded callers receive the same result.
  const entryOverrides = new Map(
    allEntries.map((entry) => [normalizeSourceRef(sourceReferenceOf(entry)), entry])
  );
  const dependencySourceEntries = new Map(
    [...project.sourceEntries].map(([ref, entry]) => [
      ref,
      entryOverrides.get(normalizeSourceRef(ref)) ?? entry,
    ])
  );
  for (const entry of allEntries) {
    const ref = sourceReferenceOf(entry);
    if (!getSourceEntry(dependencySourceEntries, ref)) {
      dependencySourceEntries.set(ref, entry);
    }
  }
  const dependencyResult = analyzeModelDependencies({
    models: project.models.map((node) => node.parsedSpec),
    sourceEntries: dependencySourceEntries,
  });
  if (!dependencyResult.ok) throw new CommandError(dependencyResult.error, 2);
  assertNoPersistedLiveRootedModels(project, dependencyResult.analyses);

  // Resolve the integration the live/lazy leaves hydrate into. Only required
  // when there are leaves; otherwise the value passes through to runProject
  // unchanged (`undefined` => multi-integration fan-out). Auto-select the sole
  // integration so single-integration projects need no `--integration`.
  let resolvedIntegration = args.integration;
  if (leaves.length > 0 && resolvedIntegration === undefined) {
    const handles = [...project.integrations.keys()];
    if (handles.length === 1) {
      resolvedIntegration = handles[0]!;
    } else {
      throw new CommandError(
        `Project has live/lazy sources but ${
          handles.length === 0
            ? 'no integrations'
            : `multiple integrations (${handles.slice().sort().join(', ')})`
        }; pass --integration <handle> so the sources hydrate into the same DuckDB the models build in.`,
        2
      );
    }
  }

  // Foreign warehouse_table leaves referenced by the DuckDB-engine models are
  // staged into the engine and their refs rewritten to the staged table. Only
  // leaves referenced by engine-stamped models are staged; the source registry
  // is global across integration contexts, so a warehouse source ALSO read by a
  // non-engine model cannot be rewritten without breaking that model — reject
  // that ambiguous case instead.
  type WarehouseLeaf = Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;
  const warehouseRewrites = new Map<string, string>();
  const warehouseLeavesToStage: Array<[string, WarehouseLeaf]> = [];

  // Published models (explicit `publish:` or a persisted `execution.engine`) are
  // handled end-to-end by the cross-warehouse publisher inside `runProject` — it
  // stages their API + warehouse leaves into the target warehouse itself. Only
  // NON-published models built in `resolvedIntegration`'s DuckDB need the
  // orchestrator to hydrate live/lazy leaves and stage foreign warehouse leaves
  // locally. Splitting on this keeps the publisher and the live path from
  // double-handling the same leaf.
  const orchestratedModels =
    resolvedIntegration === undefined
      ? []
      : project.models.filter(
          (model) => model.integration === resolvedIntegration && !isPublishedModel(model)
        );

  // `sources.<name>` fqRefs of the live/lazy leaves this run hydrates. A model
  // "needs orchestration" when it reads one of these (the WI3 live mixed view).
  const hydratedLeafRefs = new Set(
    leaves.map((entry) => normalizeSourceRef(sourceReferenceOf(entry)))
  );
  const modelReadsHydratedLeaf = (model: LoadedProject['models'][number]): boolean =>
    model.sourceRefs.some((ref) => hydratedLeafRefs.has(normalizeSourceRef(ref)));

  if (orchestratedModels.length > 0 && resolvedIntegration !== undefined) {
    const neededRefs = new Map<string, string>();
    for (const model of orchestratedModels) {
      for (const ref of model.sourceRefs) {
        const entry = getSourceEntry(project.sourceEntries, ref);
        if (
          entry?.kind === 'warehouse_table' &&
          normalizeSourceRef(entry.connection) !== normalizeSourceRef(resolvedIntegration)
        ) {
          neededRefs.set(normalizeSourceRef(ref), entry.sourceRef ?? ref);
        }
      }
    }
    // A staged-and-rewritten warehouse leaf is rewritten in the GLOBAL source
    // registry, so any other reader of that leaf would pick up the rewrite too.
    // Reject the two ways that breaks: a reader in another integration, and a
    // PUBLISHED model whose publisher would then re-read the rewritten
    // `sources.<name>` ref from the original (wrong) connection.
    for (const model of project.models) {
      if (orchestratedModels.includes(model)) continue;
      const clash = model.sourceRefs.find((ref) => neededRefs.has(normalizeSourceRef(ref)));
      if (!clash) continue;
      const reason = isPublishedModel(model)
        ? `the published model "${model.name}". Staging it into the engine would rewrite the leaf the publisher must read from its own warehouse. Point the published model at a separate warehouse table (one not staged by a DuckDB-engine view).`
        : `the model "${model.name}" in another integration. Staging it into the engine would redirect that model too. Split it into per-integration staging models.`;
      throw new CommandError(
        `Warehouse source "${clash}" is read by both a DuckDB-engine model and ${reason}`,
        2
      );
    }
    // The staged table name is the bare source name (the suffix after the
    // connection), so two foreign refs with the same source name — `crm.accounts`
    // and `erp.accounts` — would both stage to `sources.accounts`, silently
    // clobbering each other and rewriting both refs to the same data. Reject it.
    const stagedNames = new Map<string, string>();
    for (const ref of neededRefs.values()) {
      const sourceName = ref.slice(ref.indexOf('.') + 1);
      const normalizedName = normalizeSourceRef(sourceName);
      const prior = stagedNames.get(normalizedName);
      if (prior !== undefined) {
        throw new CommandError(
          `Warehouse sources "${prior}" and "${ref}" both stage into "sources.${sourceName}"; ` +
            'rename one source so the staged DuckDB tables do not collide.',
          2
        );
      }
      stagedNames.set(normalizedName, ref);
      warehouseLeavesToStage.push([
        ref,
        getSourceEntry(project.sourceEntries, ref) as WarehouseLeaf,
      ]);
    }
  }

  // The orchestrator only does real work — hydrate live/lazy leaves into a
  // shared DuckDB and stage foreign warehouse leaves — when a non-published
  // model is built in that DuckDB. When every consumer of the live/lazy leaves
  // is a published model (or there are no live-rooted views at all), there is
  // nothing to co-locate: delegate straight to `runProject` so the publisher
  // owns the run. This also avoids forcing the DuckDB-file invariants on a
  // warehouse `execution.engine`.
  const hasOrchestratedWork =
    warehouseLeavesToStage.length > 0 || orchestratedModels.some(modelReadsHydratedLeaf);

  // Same-file guard: a published model must NOT target the live source cache's
  // own DuckDB file. The orchestrator hydrates live/lazy leaves into the cache
  // file, and the publisher opens its target as a SEPARATE warehouse handle.
  // Two uncoordinated read-write handles to one DuckDB file corrupt it (the
  // publish silently succeeds, then the file fails to reopen). Require the
  // publish target to be a distinct warehouse / DuckDB file.
  if (leaves.length > 0) {
    const publishedTargets = new Map<string, string>(); // engine handle -> model name
    for (const model of project.models) {
      if (!isPublishedModel(model)) continue;
      const handle =
        getPublishTarget(model.parsedSpec.publish) ??
        getExecutionEngine(model.parsedSpec.execution);
      if (handle !== undefined && !publishedTargets.has(handle)) {
        publishedTargets.set(handle, model.name);
      }
    }
    if (publishedTargets.size > 0) {
      const cacheLeaf = leaves[0]!;
      const cacheDest = await resolveDestinationImpl({
        entry: cacheLeaf.mode === 'live' ? { ...cacheLeaf, mode: 'lazy' } : cacheLeaf,
        projectRoot: args.projectRoot,
        ...(args.defaultDestination !== undefined
          ? { defaultDestination: args.defaultDestination }
          : {}),
      });
      if (cacheDest.config.dest === 'duckdb' && cacheDest.config.dbPath !== ':memory:') {
        const cachePath = resolve(cacheDest.config.dbPath);
        for (const [handle, modelName] of publishedTargets) {
          const integ = await loadIntegrationImpl(args.projectRoot, handle);
          if (integ.source_type !== 'duckdb' || integ.auth.type !== 'file') continue;
          if (resolve(integ.auth.path) === cachePath) {
            throw new CommandError(
              `Published model "${modelName}" targets "${handle}", whose DuckDB file (${cachePath}) is also the live source cache. ` +
                'Publishing into the live cache file corrupts it — the orchestrator and the publisher open it as two uncoordinated handles. ' +
                'Point the published model at a separate warehouse (or a different DuckDB file) than the live/lazy source cache.',
              2
            );
          }
        }
      }
    }
  }

  const hydration: Receipt[] = [];

  if (leaves.length > 0 && hasOrchestratedWork) {
    // Resolve the shared destination from each leaf; all leaves must resolve to
    // the same physical DuckDB file (the same-destination contract). A `live`
    // leaf normally resolves to a transient `:memory:` table — but in the
    // derived-model path live data must be hydrated ONCE into the shared file so
    // the model build can read it (a run-scoped as-of snapshot; the view on top
    // still recomputes from a fresh fetch on each run). So resolve destinations
    // against a non-live clone to land every leaf in `sources.<name>` on the
    // shared file; hydration below still uses each leaf's real `mode`.
    const destinations = await Promise.all(
      leaves.map((entry) =>
        resolveDestinationImpl({
          entry: entry.mode === 'live' ? { ...entry, mode: 'lazy' } : entry,
          projectRoot: args.projectRoot,
          ...(args.defaultDestination !== undefined
            ? { defaultDestination: args.defaultDestination }
            : {}),
        })
      )
    );

    const sharedDbPath = fileBackedDuckDbPath(destinations[0]!);
    for (let index = 1; index < destinations.length; index += 1) {
      const path = fileBackedDuckDbPath(destinations[index]!);
      if (path !== sharedDbPath) {
        throw new CommandError(
          `live/lazy sources resolve to different DuckDB files (${sharedDbPath} vs ${path}); ` +
            'Phase 1 requires every live/lazy leaf to share one source cache destination.',
          2
        );
      }
    }

    // The model build resolves its own runner from integrations/<handle>.yml.
    // Enforce that it targets the SAME file so the hydrated sources.* tables are
    // visible to the model SELECTs.
    const integrationFile = await loadIntegrationImpl(args.projectRoot, resolvedIntegration!);
    const modelDbPath = modelIntegrationDuckDbPath(integrationFile);
    if (modelDbPath !== sharedDbPath) {
      throw new CommandError(
        `Source cache destination (${sharedDbPath}) does not match the model integration "${resolvedIntegration}" destination (${modelDbPath}). ` +
          'Derived models on live/lazy sources require both to point at the same DuckDB file so the hydrated sources.* tables are visible to the model build.',
        2
      );
    }

    const representative = destinations[0]!;
    const tempDir = join(localStateDir(args.projectRoot), 'tmp');
    await mkdir(tempDir, { recursive: true });

    const runner = await createSqlRunnerImpl({ destination: representative });
    try {
      // Hydrate-once: ensure the sources schema + metadata table, then fetch
      // each live/lazy leaf a single time up-front for a consistent as-of view.
      const schemas = new Set(destinations.map((destination) => destination.schema));
      for (const schema of schemas) {
        await runner.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema, 'duckdb')}`);
        await ensureMetadataTable({ runner, schema, dialect: 'duckdb' });
      }

      for (let index = 0; index < leaves.length; index += 1) {
        const entry = leaves[index]!;
        const destination = destinations[index]!;
        const currentFilterHash = filterHash(entry.filter, {
          nowIso,
          maxAge: entry.maxAge,
        });
        const database = createRunnerDuckDbDestination(runner);
        try {
          const receipt = await materializeOneSource({
            entry,
            destination,
            database,
            runner,
            nowIso,
            tempDir,
            currentFilterHash,
            isTransientLive: false,
            ...(args.queryResourceImpl !== undefined
              ? { queryResourceImpl: args.queryResourceImpl }
              : {}),
            ...(args.integrationSpecLoader !== undefined
              ? { integrationSpecLoader: args.integrationSpecLoader }
              : {}),
            ...(args.featureFlags !== undefined ? { featureFlags: args.featureFlags } : {}),
            ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
            physicalTableExists: async ({ schema, table }) => {
              if (!runner.query) return false;
              try {
                await runner.query(
                  `SELECT 1 FROM ${quoteIdentifier(schema, 'duckdb')}.${quoteIdentifier(table, 'duckdb')} LIMIT 0`
                );
                return true;
              } catch {
                return false;
              }
            },
            destinationIdentity: (dest) =>
              dest.config.dest === 'duckdb' ? `duckdb:${dest.config.dbPath}` : dest.fullyQualified,
          });
          hydration.push(receipt);
          const line = formatReceipt(receipt);
          args.onReceipt?.(line);
        } finally {
          await database.close();
        }
      }

      // Stage foreign warehouse leaves into the same `sources` schema so the
      // DuckDB-engine model build can read them as local tables.
      const sourcesSchema = representative.schema;
      const secretResolver = args.runProjectOptions?.secretResolver;
      const customRunners = args.runProjectOptions?.customRunners;
      for (const [ref, entry] of warehouseLeavesToStage) {
        const sourceName = ref.slice(ref.indexOf('.') + 1);
        const sourceIntegration = project.integrations.get(entry.connection);
        if (!sourceIntegration) {
          throw new CommandError(
            `Source "${ref}" references unknown integration "${entry.connection}".`,
            2
          );
        }
        const integrationSpec = secretResolver
          ? await interpolateSecrets(sourceIntegration.integration, secretResolver)
          : sourceIntegration.integration;
        const sourceRunner = await resolveRunner(integrationSpec, {
          ...(secretResolver !== undefined ? { secretResolver } : {}),
          ...(customRunners !== undefined ? { customRunners } : {}),
          ...(tokenProvider !== undefined ? { tokenProvider } : {}),
        });
        try {
          const database = createRunnerDuckDbDestination(runner);
          try {
            // The CLI orchestrator has no per-reference read mode yet, so it
            // stages every warehouse leaf `live` — a full re-read each run, the
            // behavior before the freshness wrapper existed — now bounded by the
            // OOM ceiling. The per-reference `lazy`/`maxAge` capability of
            // materializeWarehouseLeaf is for host applications that drive
            // staging directly with their own mode choice.
            const receipt = await materializeWarehouseLeaf({
              entry,
              sourceName,
              schema: sourcesSchema,
              database,
              engineRunner: runner,
              sourceRunner,
              dialect: sourceIntegration.dialect,
              tempDir,
              mode: 'live',
              currentFilterHash: filterHash(undefined, { nowIso }),
              nowIso,
              maxRows: DEFAULT_WAREHOUSE_LEAF_ROW_CEILING,
            });
            const stagedFqRef = `${sourcesSchema}.${receipt.source}`;
            warehouseRewrites.set(normalizeSourceRef(ref), stagedFqRef);
            args.onReceipt?.(`staged warehouse ${ref} -> ${stagedFqRef} (${receipt.records} rows)`);
          } finally {
            await database.close();
          }
        } finally {
          await sourceRunner.close?.();
        }
      }
    } finally {
      await runner.close?.();
    }
  }

  // Rewrite the project's source registry so staged warehouse leaves resolve to
  // their DuckDB `sources.<name>` tables instead of their physical warehouse
  // table. Safe because the clash guard proved only engine models read them. A
  // shallow clone keeps the originally-loaded project immutable.
  const projectForBuild: LoadedProject =
    warehouseRewrites.size === 0
      ? project
      : {
          ...project,
          sources: new Map(
            [...project.sources].map(([ref, fqRef]) => [
              ref,
              warehouseRewrites.get(normalizeSourceRef(ref)) ?? fqRef,
            ])
          ),
          sourceEntries: new Map(
            [...project.sourceEntries].map(([ref, entry]): [string, SourceRegistryEntry] => {
              const staged = warehouseRewrites.get(normalizeSourceRef(ref));
              // Only warehouse leaves are in warehouseRewrites, so `entry` is a
              // warehouse_table here; narrow it so the string fqRef is valid.
              return staged === undefined
                ? [ref, entry]
                : [ref, { ...(entry as WarehouseLeaf), fqRef: staged }];
            })
          ),
        };

  // Hand off to model-spec. It opens its own runner against the same DuckDB
  // file and builds the model DAG; the hydrated sources.* tables are now
  // physically present for the FROM sources.<name> refs.
  const run = await runProjectImpl(args.projectRoot, {
    integration: resolvedIntegration,
    ...(args.models !== undefined ? { models: args.models } : {}),
    project: projectForBuild,
    ...(args.runProjectOptions ?? {}),
    ...(tokenProvider !== undefined ? { tokenProvider } : {}),
  });

  return { hydration, run };
}
