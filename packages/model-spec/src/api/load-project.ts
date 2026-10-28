/**
 * `loadProject` — the file-system loader (Layer 2).
 *
 * Scans a Model Spec project directory once, indexes every file by its declared
 * `type`, and reads the Model Spec configuration, integrations, sources, models, and
 * metadata entities from that index into a typed `LoadedProject` without
 * compiling or executing. Files may live in any folder layout. Every Layer 3
 * orchestrator (`compileProject`, `runProject`, `validateProject`, …) either
 * calls this internally or accepts a caller-supplied `LoadedProject` so hosts
 * can avoid double I/O.
 *
 * The loader stays deliberately orthogonal to per-integration filtering —
 * orchestrators apply `--integration <handle>` narrowing on top of a fully
 * loaded project.
 */

import {
  entriesOfKind,
  entryFilePath,
  resolveProjectIndex,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import {
  buildDagFromDocuments,
  buildIndexedSourceRegistry,
  filterDagByIntegration,
  filterSourceEntryRegistry,
  filterSourceRegistry,
  getExecutionEngine,
  getPublishTarget,
  getSourceEntry,
  inferDagIntegrations,
  normalizeSourceRef,
  withEphemeralAncestors,
} from '../compiler/index.js';
import { expandOssieIndex } from '../ossie/index.js';
import { registerOssieBindings, validateOssiePublishBindings } from './ossie-bindings.js';
import { resolveSelection } from '../selection.js';
import { loadProjectConfig, resolveConfig, type ResolvedProjectConfig } from '../config.js';
import {
  createEmptyMetadataRegistry,
  loadIndexedMetadataRegistry,
  type MetadataRegistry,
} from '../entities/index.js';
import {
  pickIntegrationsByHandle,
  resolveIndexedIntegrations,
  validateSourceIntegrationRefs,
  type ResolvedIntegration,
} from '../integrations.js';
import { CommandError, toModelSpecRuntimeError } from '../errors.js';

import { buildIntegrationContext, type IntegrationCompileContext } from './integration-context.js';

import type {
  DagNode,
  SourceColumnRegistry,
  SourceEntryRegistry,
  SourceRegistry,
} from '../compiler/index.js';

/**
 * The fully loaded shape of a Model Spec project on disk: config + integrations +
 * sources + models + metadata entities, with the DAG already topologically
 * sorted and each node's owning integration inferred.
 */
export interface LoadedProject {
  cwd: string;
  config: ResolvedProjectConfig;
  integrations: Map<string, ResolvedIntegration>;
  sources: SourceRegistry;
  sourceColumns: SourceColumnRegistry;
  sourceEntries: SourceEntryRegistry;
  models: DagNode[];
  entities: MetadataRegistry;
  warnings: string[];
  /**
   * The type index the project was loaded from, so later reads (metadata,
   * validation) reuse the same scan. Absent on hand-built projects.
   */
  index?: ProjectIndex;
}

export interface LoadProjectOptions {
  /**
   * Prebuilt index of the project directory, so one scan serves every
   * loader. Scanned from `cwd` when omitted.
   */
  index?: ProjectIndex;
  /**
   * Skip integration loading entirely. Useful for hosts that already hold
   * integration context in memory — the resulting `integrations` map is empty
   * and no cross-reference check runs against source handles.
   */
  skipIntegrations?: boolean;
  /**
   * Skip metadata (metrics/relationships/VQs) loading. Useful for orchestrators
   * that only care about the compile graph and want to trim I/O.
   */
  skipEntities?: boolean;
}

/**
 * Load a Model Spec project directory into a `LoadedProject`.
 *
 * Fatal project-structure errors (malformed or unknown project files, invalid
 * specs, duplicate names, unknown source refs, mixed-handle models, removed
 * `model-spec.yml` keys) surface as `CommandError(2)`. The `warnings` field is always
 * empty; it is kept for API backwards-compatibility.
 */
export async function loadProject(
  cwd: string,
  opts: LoadProjectOptions = {}
): Promise<LoadedProject> {
  try {
    return await loadProjectUnchecked(cwd, opts);
  } catch (error) {
    throw toModelSpecRuntimeError(error);
  }
}

async function loadProjectUnchecked(
  cwd: string,
  opts: LoadProjectOptions = {}
): Promise<LoadedProject> {
  const warnings: string[] = [];

  // ---- 0. One type index for every loader ----
  const index = expandOssieIndex(resolveProjectIndex(cwd, opts.index));

  // ---- 1. Project config ----
  const { config } = loadProjectConfig(cwd, { index });
  const resolved = resolveConfig({}, config);

  // ---- 2. Source registry ----
  const registryResult = buildIndexedSourceRegistry(index);
  if (!registryResult.ok) {
    throw new CommandError(registryResult.error, 2);
  }
  const {
    registry: sources,
    columnRegistry: sourceColumns,
    entryRegistry: sourceEntries,
  } = registryResult;

  // ---- 3. Integrations ----
  const integrations = opts.skipIntegrations
    ? new Map<string, ResolvedIntegration>()
    : resolveIndexedIntegrations(index);

  if (!opts.skipIntegrations) {
    validateSourceIntegrationRefs(sources.keys(), new Set(integrations.keys()));
  }

  // ---- 4. Model DAG ----
  const modelDocuments = entriesOfKind(index, 'model').map((entry) => ({
    filePath: entryFilePath(index, entry),
    data: entry.document,
  }));
  let models: DagNode[] = [];
  if (modelDocuments.length > 0) {
    const dagResult = buildDagFromDocuments(modelDocuments);
    if (!dagResult.ok) {
      throw new CommandError(dagResult.error, 2);
    }
    models = dagResult.order;
    registerOssieBindings(index, models, sourceEntries);
  }

  if (!opts.skipIntegrations) {
    validateExecutionEngines(models, integrations, sourceEntries);
    validatePublishTargets(models, integrations, sourceEntries);
  }

  try {
    inferDagIntegrations(models);
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err), 2);
  }

  // ---- 5. Metadata registry ----
  const entities = opts.skipEntities
    ? createEmptyMetadataRegistry()
    : loadIndexedMetadataRegistry(index);

  return {
    cwd,
    config: resolved,
    integrations,
    sources,
    sourceColumns,
    sourceEntries,
    models,
    entities,
    warnings,
    index,
  };
}

/**
 * Options for `selectIntegrationContexts`. Mirrors the narrowing applied by the
 * CLI's `--integration <handle>` / `[model...]` arguments so orchestrators can
 * reuse the same filtering semantics without re-reading the project.
 */
export interface SelectIntegrationsOptions {
  /** Narrow to a single integration handle (or omit for fan-out across all). */
  integration?: string;
  /**
   * Model selection — dbt-style selector tokens resolved by `resolveSelection`.
   * A bare name selects EXACTLY that model (no upstream closure — the v3
   * dbt-parity behavior); use `+X` for ancestors, `X+` for descendants, `+X+`
   * for both, and `tag:foo` for tag selection. Omit (or pass `[]`) for all
   * models.
   */
  models?: string[];
  /**
   * Called with each integration that is declared but has no referencing
   * model. Lets callers surface per-CLI advisory warnings without the selector
   * owning an opinion on output formatting.
   */
  onSkipped?: (reason: { handle: string; message: string }) => void;
}

/**
 * Narrow a `LoadedProject` into the per-integration compile contexts the CLI
 * (and orchestrators) consume. Mirrors `buildMultiCompileContext`'s selection
 * semantics exactly:
 *
 *   - With `integration` set: narrow to that handle. If at least one model
 *     references it via a `connection:`-prefixed source, compile only those
 *     models against that integration's sources. Otherwise fall back to
 *     uniform-stamp mode (every model compiles through the integration, so a
 *     `--integration snowflake` flag picks a dialect even when source handles
 *     are a logical namespace like `ecom`).
 *   - Without `integration`: fan out one context per integration that has at
 *     least one referencing model. Integrations with no consumers are passed
 *     to `onSkipped` and omitted.
 */
export function selectIntegrationContexts(
  project: LoadedProject,
  opts: SelectIntegrationsOptions = {}
): IntegrationCompileContext[] {
  // Ref resolution always sees the FULL project model set, so a selected
  // model's `ref` to an unselected upstream still resolves to that upstream's
  // physical table (dbt parity). Only `orderedNodes` (the EXECUTION set) is
  // narrowed by the selection.
  validateOssiePublishBindings(project.models, project.integrations);
  const registryNodes = project.models;
  let orderedNodes = project.models;
  if (opts.models && opts.models.length > 0) {
    // dbt-style exact selection: a bare name resolves to EXACTLY that model
    // (no upstream closure). `resolveSelection` throws on an unknown name; the
    // empty guard below only fires when every selector resolves to nothing
    // (e.g. a lone unknown `tag:`). Ephemeral ancestors are pulled into the
    // execution set so they can be inlined as CTEs (they emit no DDL).
    const selected = new Set(
      resolveSelection(
        project.models.map((node) => ({
          name: node.name,
          refs: node.refs,
          tags: node.parsedSpec.model_kind === 'agentic' ? [] : node.parsedSpec.tags,
        })),
        opts.models
      )
    );
    orderedNodes = withEphemeralAncestors(project.models, selected);
    if (orderedNodes.length === 0) {
      throw new CommandError(`No models found matching: ${opts.models.join(', ')}`);
    }
  }

  const perIntegration: IntegrationCompileContext[] = [];
  const explicitHandle = opts.integration;

  if (explicitHandle !== undefined) {
    const [integration] = pickIntegrationsByHandle(project.integrations, explicitHandle);
    if (!integration) {
      // pickIntegrationsByHandle throws on unknown handle, but guard anyway.
      throw new CommandError(`Unknown integration handle: ${explicitHandle}`, 2);
    }
    const scopedNodes = filterDagByIntegration(orderedNodes, explicitHandle);
    if (scopedNodes.length > 0) {
      const needsFullRegistry = scopedNodes.some(
        (node) =>
          node.parsedSpec.model_kind === 'agentic' ||
          getPublishTarget(node.parsedSpec.publish) !== undefined ||
          getExecutionEngine(node.parsedSpec.execution) !== undefined
      );
      const scopedRegistry = needsFullRegistry
        ? project.sources
        : filterSourceRegistry(project.sources, explicitHandle);
      const scopedEntries = needsFullRegistry
        ? project.sourceEntries
        : filterSourceEntryRegistry(project.sourceEntries, explicitHandle);
      perIntegration.push(
        buildIntegrationContext(
          integration,
          scopedNodes,
          scopedRegistry,
          scopedEntries,
          filterDagByIntegration(registryNodes, explicitHandle)
        )
      );
    } else {
      // Uniform-stamp fallback assumes the project is single-warehouse and any
      // model can be re-targeted to the requested handle. That assumption
      // breaks for cross-warehouse projects where `publish: <handle>` already
      // names the canonical target — stamping over it would plan/state under
      // the wrong handle while the publisher still writes to `spec.publish`.
      if (
        orderedNodes.some(
          (node) =>
            getPublishTarget(node.parsedSpec.publish) !== undefined ||
            getExecutionEngine(node.parsedSpec.execution) !== undefined
        )
      ) {
        throw new CommandError(
          `No models target integration "${explicitHandle}". Cross-warehouse projects must run against a handle that owns at least one model (typically the \`publish:\` or \`execution.engine\` target).`,
          2
        );
      }
      // Stamp every node with the explicit handle via a non-mutating copy so
      // the loaded project graph stays immutable. The registry gets the full
      // project (stamped) so refs to unselected models still resolve.
      const stampedNodes = orderedNodes.map((node) => ({ ...node, integration: explicitHandle }));
      const stampedRegistryNodes = registryNodes.map((node) => ({
        ...node,
        integration: explicitHandle,
      }));
      perIntegration.push(
        buildIntegrationContext(
          integration,
          stampedNodes,
          project.sources,
          project.sourceEntries,
          stampedRegistryNodes
        )
      );
    }
    return perIntegration;
  }

  for (const integration of project.integrations.values()) {
    const integrationNodes = filterDagByIntegration(orderedNodes, integration.handle);
    if (integrationNodes.length === 0) {
      opts.onSkipped?.({
        handle: integration.handle,
        message: `Integration "${integration.handle}" declared but no models reference it — skipping.`,
      });
      continue;
    }
    const needsFullRegistry = integrationNodes.some(
      (node) =>
        node.parsedSpec.model_kind === 'agentic' ||
        getPublishTarget(node.parsedSpec.publish) !== undefined ||
        getExecutionEngine(node.parsedSpec.execution) !== undefined
    );
    const scopedRegistry = needsFullRegistry
      ? project.sources
      : filterSourceRegistry(project.sources, integration.handle);
    const scopedEntries = needsFullRegistry
      ? project.sourceEntries
      : filterSourceEntryRegistry(project.sourceEntries, integration.handle);
    perIntegration.push(
      buildIntegrationContext(
        integration,
        integrationNodes,
        scopedRegistry,
        scopedEntries,
        filterDagByIntegration(registryNodes, integration.handle)
      )
    );
  }
  return perIntegration;
}

const WAREHOUSE_PUBLISH_TYPES = new Set([
  'snowflake',
  'bigquery',
  'postgres',
  'databricks',
  'duckdb',
]);

function oauthAlternativeHint(sourceType: string): string {
  switch (sourceType) {
    case 'snowflake':
      return 'Use rsa_key (preferred) or pat auth for Snowflake sources in published models.';
    case 'databricks':
      return 'Use pat auth for Databricks sources in published models.';
    default:
      return 'Use a non-OAuth auth variant for sources in published models.';
  }
}

/**
 * Validate `execution.engine` on models:
 *   - it must name a declared integration (an unknown handle would otherwise be
 *     stamped verbatim by `inferDagIntegrations` and silently dropped from the
 *     per-integration fan-out).
 *   - a non-persisted materialization (view/ephemeral/…) over a foreign
 *     `warehouse_table` leaf only runs on the live DuckDB-engine staging path,
 *     and only when the project has a live/lazy `api_resource` source to trigger
 *     it. Every other shape (a warehouse engine, or a DuckDB engine with no live
 *     source) has no staging step and would fail later with a missing-table SQL
 *     error — reject it clearly here instead. Persisted models stage + publish
 *     regardless, so they are unaffected.
 */
function validateExecutionEngines(
  models: DagNode[],
  integrations: ReadonlyMap<string, ResolvedIntegration>,
  sourceEntries: SourceEntryRegistry
): void {
  const persisted = new Set(['table', 'incremental', 'snapshot']);
  const hasLiveApiSource = [...sourceEntries.values()].some(
    (entry) => entry.kind === 'api_resource' && (entry.mode ?? 'lazy') !== 'extract'
  );
  for (const node of models) {
    const engine = getExecutionEngine(node.parsedSpec.execution);
    if (!engine) continue;
    const target = integrations.get(engine);
    if (!target) {
      const available = [...integrations.keys()].sort().join(', ') || '(none)';
      throw new CommandError(
        `Model "${node.name}" sets execution.engine: "${engine}", but no integration with that handle exists. Available: ${available}.`,
        2
      );
    }
    if (persisted.has(node.materialization)) continue;
    const foreignWarehouseRef = node.sourceRefs.find((ref) => {
      const entry = getSourceEntry(sourceEntries, ref);
      return (
        entry?.kind === 'warehouse_table' &&
        normalizeSourceRef(entry.connection) !== normalizeSourceRef(engine)
      );
    });
    if (!foreignWarehouseRef) continue;
    if (target.dialect === 'duckdb' && hasLiveApiSource) continue;
    throw new CommandError(
      `Model "${node.name}" runs a non-persisted (${node.materialization}) join over warehouse source "${foreignWarehouseRef}" from another integration in engine "${engine}". ` +
        (target.dialect === 'duckdb'
          ? 'The live DuckDB-engine path needs a live/lazy api_resource source in the project to stage it — add one, or use materialization.type: table.'
          : 'A warehouse engine can only materialize this join — use materialization.type: table (or incremental/snapshot).'),
      2
    );
  }
}

function validatePublishTargets(
  models: DagNode[],
  integrations: ReadonlyMap<string, ResolvedIntegration>,
  sourceEntries: SourceEntryRegistry
): void {
  for (const node of models) {
    const publish = getPublishTarget(node.parsedSpec.publish);
    if (!publish) continue;

    const target = integrations.get(publish);
    if (!target) {
      const available = [...integrations.keys()].sort().join(', ') || '(none)';
      throw new CommandError(
        `Model "${node.name}" sets publish: "${publish}", but no integration with that handle exists. Available: ${available}.`,
        2
      );
    }

    if (!WAREHOUSE_PUBLISH_TYPES.has(target.integration.source_type)) {
      throw new CommandError(
        `Model "${node.name}" sets publish: "${publish}", but publish: requires a warehouse destination.`,
        2
      );
    }

    const supportedPublishMaterializations = new Set(['table', 'incremental', 'snapshot']);
    if (!supportedPublishMaterializations.has(node.materialization)) {
      throw new CommandError(
        [
          `Model "${node.name}" sets publish: "${publish}" with materialization "${node.materialization}".`,
          'publish: supports materialization.type: table, incremental, or snapshot.',
          'view, materialized_view, dynamic_table, and ephemeral remain unsupported because',
          'they imply zero data movement and cannot be published into a separate warehouse.',
        ].join(' '),
        2
      );
    }

    // OAuth tokens have short TTLs (Snowflake default 1h) that cannot cover
    // multi-hour cross-warehouse publishes. Reject at validation time so
    // operators discover the limit at compile time rather than 11 hours into
    // a run. Document key-pair/PAT alternatives in the error message.
    for (const ref of node.sourceRefs) {
      // Carve-out: an `api_resource` leaf is a short fetch-then-stage, not a
      // multi-hour warehouse-to-warehouse publish, so the OAuth-TTL rationale
      // does not apply. OAuth-authed APIs (Google, Salesforce, HubSpot, …) are
      // allowed as inputs to a published mixed model.
      const sourceEntry = getSourceEntry(sourceEntries, ref);
      if (sourceEntry?.kind === 'api_resource') continue;
      if (sourceEntry?.kind !== 'warehouse_table') continue;
      const sourceIntegration = integrations.get(sourceEntry.connection);
      if (!sourceIntegration) continue;
      const sourceAuth = sourceIntegration.integration.auth as { type?: string } | undefined;
      if (sourceAuth?.type === 'oauth' || sourceAuth?.type === 'oauth_m2m') {
        throw new CommandError(
          [
            `Model "${node.name}" sets publish: "${publish}" but source "${ref}" uses ${sourceAuth.type} auth.`,
            'OAuth tokens have short TTLs that cannot cover long-running cross-warehouse publishes.',
            oauthAlternativeHint(sourceIntegration.integration.source_type),
          ].join(' '),
          2
        );
      }
    }
  }
}
