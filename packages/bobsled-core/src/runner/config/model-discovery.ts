/**
 * Model Spec model discovery + model-pipeline membership validation.
 *
 * Extracted from `loader.ts` (which had grown past the source-file budget).
 * Walks a project's `models/` directory to infer per-model metadata
 * (`DiscoveredModel`: connection, materialization, upstream refs, tags) used by
 * the manifest generator, and validates that authored `type: models` pipelines
 * reference real derived models on the declared connection.
 *
 * The public surface (`discoverModels`, `isOrphanEligibleMaterialization`,
 * `DiscoveredModel`, `ModelNode`) is re-exported from `loader.js` so existing
 * importers keep importing from there.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { expandOssieIndex } from '@bobsled-inc/model-spec/ossie';
import {
  assertCompleteProjectIndex,
  entriesOfKind,
  ProjectIndexError,
  scanProject,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import type { ResolvedModelPipeline, ValidationIssue } from './loader.js';
import { openBobsledProject, projectFileIssues, type BobsledProject } from './project-files.js';
import type { BobsledConfig } from './schema.js';

/**
 * Resolve the root of the Model Spec project a Dogsled config points at.
 *
 * Dogsled's top-level `models: { project: <path> }` (when present) names the Model Spec
 * project root. When the field is absent, the Model Spec project is the Dogsled
 * project itself. Models are the `type: model` files anywhere below that root.
 */
export function resolveModelProjectRoot(config: BobsledConfig, projectRoot: string): string {
  return config.models?.project ? path.resolve(projectRoot, config.models.project) : projectRoot;
}

/**
 * Model metadata for the Model Spec project a Dogsled config points at, read from the
 * given project's index when the Model Spec project is the Dogsled project itself. A
 * separate Model Spec project is opened like the Dogsled project: one that does not
 * exist has no models, so validation reports the missing names, and its
 * blocking problems raise a `ProjectIndexError`, since its model runs would
 * stop on them.
 */
export function discoverProjectModels(
  config: BobsledConfig,
  project: BobsledProject
): Map<string, DiscoveredModel> {
  const modelRoot = path.resolve(resolveModelProjectRoot(config, project.root));
  return discoverModels(
    modelRoot === project.root ? project.index : openBobsledProject(modelRoot).index
  );
}

/**
 * Per-model metadata pulled from a project's Model Spec `models/` directory. The
 * manifest generator uses this to (a) expand `models: '*'` selections in
 * model pipelines, (b) decide which derived models are orphan-eligible
 * (materialization in `{table | incremental | snapshot}`), and (c) attribute
 * orphans to a connection so they can be grouped into synthetic pipelines.
 */
export interface DiscoveredModel {
  /** Owning connection slug, resolved by chasing `source.ref` to a dotted prefix. */
  connection: string | undefined;
  /** `materialization.type` from the spec; `undefined` when the spec omits it. */
  materialization: string | undefined;
  /**
   * Direct upstream MODEL dependencies — the bare (non-dotted) refs from this
   * model's `source.ref`, `joins[].ref`, and `union[].ref`. Dotted source refs
   * (`connection.source`) are excluded; only model-to-model edges land here.
   *
   * Used to derive the v3 manifest's per-model node edges. Matched
   * case-insensitively (the manifest builder lowercases both sides, mirroring
   * the Model Spec DAG which canonicalizes model names/refs to lowercase). Optional so
   * legacy callers that only supply `{ connection, materialization }` keep
   * working; the host application populates this disk-lessly to build v3 model DAGs.
   */
  refs?: string[];
  /**
   * Selector metadata — the model's `tags` (verbatim from the spec, matched
   * case-sensitively by `tag:` selectors). Optional for the same back-compat
   * reason as `refs`.
   */
  tags?: string[];
}

/**
 * A single model's manifest-facing identity: its name plus the refs/tags needed
 * to wire v3 per-model DAG nodes + edges. `refs` here are already intersected
 * with the owning pipeline's resolved model set (cross-pipeline refs dropped),
 * so the manifest builder can treat every ref as an in-pipeline edge.
 *
 * Shared by `ExpandedModelPipeline.modelNodes` and workflow consumers so the
 * topology is defined exactly once.
 */
export interface ModelNode {
  /** Model name, authored case (used verbatim in the node command). */
  name: string;
  /** In-pipeline upstream model deps (bare names). */
  refs: string[];
  /** Tags carried verbatim from the spec. */
  tags?: string[];
}

/**
 * Materializations that need cron-driven refresh and therefore qualify a
 * derived model as orphan-eligible when no explicit `pipelines.<name>.models`
 * mentions it. Views, ephemeral CTEs, and warehouse-managed materializations
 * (`dynamic_table`, `materialized_view`) refresh themselves and stay out.
 */
const ORPHAN_ELIGIBLE_MATERIALIZATIONS: ReadonlySet<string> = new Set([
  'table',
  'incremental',
  'snapshot',
]);

export function isOrphanEligibleMaterialization(materialization: string | undefined): boolean {
  return materialization !== undefined && ORPHAN_ELIGIBLE_MATERIALIZATIONS.has(materialization);
}

/**
 * Walk the Model Spec `models/` directory and infer per-model metadata
 * (owning connection + materialization type).
 *
 * Model Spec model specs reference data with `source.ref`. A `connection.source`
 * shape (`linear.linear_issues`) names the connection directly via the dotted
 * prefix; a bare model reference (`stg_linear_issues`) chains to another
 * model that itself eventually reaches a dotted ref. We resolve the chain
 * once per scan via `resolveConnection`. Files that aren't `type: model`
 * (e.g. accidentally placed sources) and unparseable YAMLs are skipped — the
 * full model-spec compiler runs separately and is the authority on those
 * failure modes. A scan that stopped at a limit is an error, because models
 * past it would be missing.
 */
export function discoverModels(source: string | ProjectIndex): Map<string, DiscoveredModel> {
  if (typeof source === 'string' && !fs.existsSync(source)) return new Map();
  const index = typeof source === 'string' ? scanProject(source) : source;
  assertCompleteProjectIndex(index);
  const hasOssie =
    index.entries.some((entry) => entry.kind === 'ossie') ||
    index.issues.some((issue) => issue.kind === 'ossie' || issue.code === 'conflicting_format');
  const modelIndex = hasOssie ? expandOssieIndex(index) : index;
  return discoverModelDocuments(entriesOfKind(modelIndex, 'model').map((entry) => entry.document));
}

function discoverModelDocuments(documents: readonly unknown[]): Map<string, DiscoveredModel> {
  const directRefs = new Map<string, string[]>();
  const declaredConnections = new Map<string, string>();
  const materializations = new Map<string, string | undefined>();
  const modelRefs = new Map<string, string[]>();
  const modelTags = new Map<string, string[]>();

  for (const parsed of documents) {
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj['type'] !== 'model') continue;
    const name = obj['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const source = obj['source'];
    let ref: string | undefined;
    if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
      const sref = (source as Record<string, unknown>)['ref'];
      if (typeof sref === 'string') ref = sref;
    }
    const canonical = name.toLowerCase();
    if (obj['model_kind'] === 'agentic') {
      directRefs.set(canonical, collectAgenticRefs(obj, true));
      const engine = objectString(obj['execution'], 'engine');
      const publish =
        typeof obj['publish'] === 'string'
          ? obj['publish']
          : objectString(obj['publish'], 'target');
      const declared = engine ?? publish;
      if (declared) declaredConnections.set(canonical, declared);
    } else {
      directRefs.set(canonical, ref ? [ref] : []);
    }

    // Collect the full set of upstream MODEL refs (bare, non-dotted) from
    // source + joins + union — same classification the Model Spec DAG uses (dotted =
    // source ref, bare = model ref). These drive the v3 manifest edge wiring.
    modelRefs.set(name, collectBareModelRefs(obj));

    const tags = obj['tags'];
    if (Array.isArray(tags)) {
      const stringTags = tags.filter((t): t is string => typeof t === 'string');
      if (stringTags.length > 0) modelTags.set(name, stringTags);
    }

    const mat = obj['materialization'];
    if (typeof mat === 'object' && mat !== null && !Array.isArray(mat)) {
      const mtype = (mat as Record<string, unknown>)['type'];
      materializations.set(name, typeof mtype === 'string' ? mtype : undefined);
    } else {
      materializations.set(name, undefined);
    }
  }

  const out = new Map<string, DiscoveredModel>();
  const connectionCache = new Map<string, string>();
  for (const name of materializations.keys()) {
    const model: DiscoveredModel = {
      connection: resolveConnection(
        name.toLowerCase(),
        directRefs,
        declaredConnections,
        new Set(),
        connectionCache
      ),
      materialization: materializations.get(name),
      refs: modelRefs.get(name) ?? [],
    };
    const tags = modelTags.get(name);
    if (tags) model.tags = tags;
    out.set(name, model);
  }
  return out;
}

/**
 * Pull a single `ref` string off an object shaped like `{ ref: string }`.
 */
function refFromEntry(entry: unknown): string | undefined {
  return objectString(entry, 'ref');
}

function objectString(entry: unknown, key: string): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const ref = (entry as Record<string, unknown>)[key];
  return typeof ref === 'string' ? ref : undefined;
}

/** Agentic aliases may read sources, upstream models, or the old published target. */
function collectAgenticRefs(obj: Record<string, unknown>, preparedOnly = false): string[] {
  const sources = obj['sources'];
  if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) return [];
  const plan = obj['plan'];
  const steps =
    typeof plan === 'object' && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>)['steps']
      : undefined;
  // Match inferDagIntegrations: tools do not select the compute warehouse.
  // Keep the legacy scan for incomplete specs; full validation rejects them later.
  const prepared =
    preparedOnly && Array.isArray(steps)
      ? new Set(
          steps.flatMap((step: unknown) => {
            if (typeof step !== 'object' || step === null || Array.isArray(step)) return [];
            const alias = refFromEntry((step as Record<string, unknown>)['source']);
            return alias ? [alias] : [];
          })
        )
      : undefined;
  return [
    ...new Set(
      Object.entries(sources).flatMap(([alias, entry]: [string, unknown]) => {
        if (prepared && !prepared.has(alias)) return [];
        const ref = refFromEntry(entry);
        // Only the exact self-target reference has old-output semantics in the contract.
        return ref && ref !== obj['name'] ? [ref] : [];
      })
    ),
  ];
}

/**
 * Collect a model's direct upstream MODEL refs (bare names) from `source.ref`,
 * `joins[].ref`, and `union[].ref`. Dotted refs (`connection.source`) are
 * source refs, not model edges, and are dropped. De-duplicated, declaration
 * order preserved.
 */
function collectBareModelRefs(obj: Record<string, unknown>): string[] {
  if (obj['model_kind'] === 'agentic') {
    return collectAgenticRefs(obj).filter((ref) => !ref.includes('.'));
  }
  const raw: string[] = [];
  const sourceRef = refFromEntry(obj['source']);
  if (sourceRef !== undefined) raw.push(sourceRef);
  for (const key of ['joins', 'union'] as const) {
    const entries = obj[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const ref = refFromEntry(entry);
      if (ref !== undefined) raw.push(ref);
    }
  }

  const seen = new Set<string>();
  const bare: string[] = [];
  for (const ref of raw) {
    if (ref.includes('.')) continue; // dotted = source ref, not a model edge
    if (seen.has(ref)) continue;
    seen.add(ref);
    bare.push(ref);
  }
  return bare;
}

/**
 * Backwards-compatible thin wrapper around `discoverModels` that keeps only
 * the connection slug for callers that don't care about materialization.
 */
function discoverModelConnections(
  config: BobsledConfig,
  project: BobsledProject
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const [name, meta] of discoverProjectModels(config, project).entries()) {
    out.set(name, meta.connection);
  }
  return out;
}

function resolveConnection(
  name: string,
  refs: Map<string, string[]>,
  declared: Map<string, string>,
  seen: Set<string>,
  cache: Map<string, string>
): string | undefined {
  const cached = cache.get(name);
  if (cached) return cached;
  const explicit = declared.get(name);
  if (explicit) return explicit;
  if (seen.has(name)) return undefined;
  const inputs = refs.get(name);
  if (!inputs?.length) return undefined;
  const path = new Set(seen).add(name);
  const connections = new Set<string>();
  for (const ref of inputs) {
    const dot = ref.indexOf('.');
    const connection =
      dot >= 0
        ? ref.slice(0, dot)
        : resolveConnection(ref.toLowerCase(), refs, declared, path, cache);
    if (!connection) return undefined;
    connections.add(connection);
  }
  const connection = connections.size === 1 ? [...connections][0] : undefined;
  if (connection) cache.set(name, connection);
  return connection;
}

export function validateModelPipelineMembership(
  modelPipelines: ResolvedModelPipeline[],
  config: BobsledConfig,
  project: BobsledProject,
  errors: ValidationIssue[],
  warnings: string[]
): void {
  if (modelPipelines.length === 0) return;

  let modelConnections: Map<string, string | undefined>;
  try {
    modelConnections = discoverModelConnections(config, project);
  } catch (error) {
    if (!(error instanceof ProjectIndexError)) throw error;
    errors.push(...projectFileIssues(error, config.models?.project));
    return;
  }
  // Look up model ownership case-insensitively — the Model Spec DAG canonicalizes
  // model names to lowercase, so a `bobsled.yml` pipeline may list a model in a
  // different case than the spec's `name:`. Exact-case lookups would wrongly
  // reject such pipelines (and must match the case-insensitive expansion in
  // `buildModelNodes` / `computeSyntheticModelPipelines`).
  const connectionByCanonical = new Map<string, string | undefined>();
  for (const [name, conn] of modelConnections) connectionByCanonical.set(name.toLowerCase(), conn);

  for (const pipeline of modelPipelines) {
    if (pipeline.models === '*') {
      const matches = [...modelConnections.entries()].filter(
        ([, conn]) => conn === pipeline.connection
      );
      if (matches.length === 0) {
        warnings.push(
          `Pipeline "${pipeline.name}": models: '*' matched zero derived models for connection "${pipeline.connection}".`
        );
      }
      continue;
    }

    for (const modelName of pipeline.models) {
      const canonical = modelName.toLowerCase();
      const conn = connectionByCanonical.get(canonical);
      if (conn === undefined && !connectionByCanonical.has(canonical)) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.models`,
          message: `Model "${modelName}" not found as a derived model in the project (no type: model file declares that name).`,
        });
        continue;
      }
      if (conn !== pipeline.connection) {
        const actual = conn ?? '<unresolved>';
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.models`,
          message: `Model "${modelName}" belongs to connection "${actual}" but pipeline "${pipeline.name}" declares connection "${pipeline.connection}".`,
        });
      }
    }
  }
}
