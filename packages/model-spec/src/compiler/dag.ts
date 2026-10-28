/**
 * DAG construction and topological sort for model dependencies.
 *
 * Uses Kahn's algorithm (BFS-based) to produce a deterministic
 * compilation order. Models at the same topological level are
 * sorted alphabetically.
 */

import * as path from 'node:path';

import { readYamlFile } from '../files/reader.js';

import { getOrThrow } from './dialect.js';
import { nodeFs } from './node-fs.js';
import { getPublishTarget, getExecutionEngine } from './schemas.js';

import type { MaterializationType, TrustTier } from './schemas.js';
import { describeModelSpecIssues, ModelSpecSchema, type ModelSpec } from '../agentic/model.js';

import type { FileSystem } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagNode {
  /** Model name (lowercase). */
  name: string;
  /** Path to the YAML spec file. */
  filePath: string;
  /** Direct model dependencies (bare ref names, lowercase). */
  refs: string[];
  /** Source references (dotted ref names, e.g. "ecom.raw_orders"). */
  sourceRefs: string[];
  /** Cached parsed spec from DAG build (avoids re-parsing in compile step). */
  parsedSpec: ModelSpec;
  /** Materialization type for this model. */
  materialization: MaterializationType;
  /**
   * Integration handle the model belongs to, inferred by `inferDagIntegrations`
   * by walking source refs + transitive upstream models. Optional on the type
   * because `buildDag` does not set it — legacy callers (Entity Graph, the
   * model-packages compile loop) consume `DagNode` without integration
   * awareness. `buildCompileContext` populates it before compile/run/test.
   */
  integration?: string;
}

export type DagResult = { ok: true; order: DagNode[] } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a DAG from model YAML files and return topologically sorted nodes.
 *
 * 1. Parse each YAML to extract name + refs
 * 2. Separate source refs (dotted) from model refs (bare)
 * 3. Detect duplicate model names
 * 4. Kahn's algorithm for topological sort
 * 5. Alphabetical within each level for determinism
 */
export function buildDag(modelFiles: string[]): DagResult {
  const documents: ModelDocument[] = [];
  for (const filePath of modelFiles) {
    const readResult = readYamlFile(filePath);
    if (!readResult.ok) {
      return { ok: false, error: `${filePath}: ${readResult.error}` };
    }
    documents.push({ filePath, data: readResult.data });
  }
  return buildDagFromDocuments(documents);
}

/** A model spec already read from disk or a project index. */
export interface ModelDocument {
  /** Path reported in errors and kept on the resulting `DagNode`. */
  filePath: string;
  data: unknown;
}

/**
 * `buildDag` over model documents a caller already parsed, such as the
 * `type: model` entries of a project index.
 */
export function buildDagFromDocuments(modelDocuments: readonly ModelDocument[]): DagResult {
  // Step 1: Parse all models to extract names and refs
  const nodes: DagNode[] = [];
  const nameToFile = new Map<string, string>();

  for (const { filePath, data } of modelDocuments) {
    const parsed = ModelSpecSchema.safeParse(data);
    if (!parsed.success) {
      const messages = describeModelSpecIssues(data, parsed.error);
      return { ok: false, error: `${filePath}: Validation failed: ${messages}` };
    }

    const spec = parsed.data;
    const name = spec.name.toLowerCase();

    // Detect duplicates
    const existing = nameToFile.get(name);
    if (existing) {
      return {
        ok: false,
        error: `Duplicate model name "${spec.name}" defined in:\n  - ${existing}\n  - ${filePath}`,
      };
    }
    nameToFile.set(name, filePath);

    // Collect all refs from source + joins + union branches
    const allRefs =
      spec.model_kind === 'agentic'
        ? Object.values(spec.sources)
            .map((source) => source.ref)
            .filter((ref) => ref !== spec.name)
        : [
            spec.source.ref,
            ...spec.joins.map((j) => j.ref),
            ...(spec.union ?? []).map((u) => u.ref),
            // Only an explicit recursive source adds an edge. `prior` names
            // the in-progress result, so the recursive model stays acyclic.
            ...(spec.recurse?.step.source.ref ? [spec.recurse.step.source.ref] : []),
          ];

    // Separate: dotted = source ref, bare = model ref
    const modelRefs = allRefs.filter((ref) => !ref.includes('.')).map((ref) => ref.toLowerCase());

    const sourceRefs = allRefs.filter((ref) => ref.includes('.'));

    nodes.push({
      name,
      filePath,
      refs: modelRefs,
      sourceRefs,
      parsedSpec: spec,
      materialization: spec.materialization.type,
    });
  }

  // Step 2: Build adjacency list and in-degree map
  const nodeMap = new Map<string, DagNode>();
  for (const node of nodes) {
    nodeMap.set(node.name, node);
  }

  // Validate model refs exist
  for (const node of nodes) {
    for (const ref of node.refs) {
      if (!nodeMap.has(ref)) {
        return {
          ok: false,
          error: `Model "${node.name}" references unknown model "${ref}". Available models: ${[...nodeMap.keys()].join(', ') || '(none)'}`,
        };
      }
      // Self-reference check
      if (ref === node.name) {
        return {
          ok: false,
          error: `Model "${node.name}" references itself (cycle).`,
        };
      }
    }
  }

  // adjacency: model → models that depend on it
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacency.set(node.name, []);
    inDegree.set(node.name, 0);
  }

  for (const node of nodes) {
    for (const ref of node.refs) {
      getOrThrow(adjacency, ref, 'adjacency').push(node.name);
      inDegree.set(node.name, (inDegree.get(node.name) ?? 0) + 1);
    }
  }

  // Step 3: Kahn's algorithm
  const result: DagNode[] = [];
  // Seed with zero in-degree nodes, sorted alphabetically
  let queue = nodes
    .filter((n) => inDegree.get(n.name) === 0)
    .map((n) => n.name)
    .sort();

  while (queue.length > 0) {
    // Process current level (all items in queue at this point)
    const nextQueue: string[] = [];

    for (const name of queue) {
      result.push(getOrThrow(nodeMap, name, 'nodeMap'));
      for (const dependent of getOrThrow(adjacency, name, 'adjacency')) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dependent);
        }
      }
    }

    // Sort next level alphabetically for determinism
    queue = nextQueue.sort();
  }

  // Cycle detection: any node still with non-zero in-degree is in a cycle
  if (result.length < nodes.length) {
    const remaining = nodes.filter((n) => (inDegree.get(n.name) ?? 0) > 0).map((n) => n.name);
    return {
      ok: false,
      error: `Circular dependency detected among models: ${remaining.join(', ')}`,
    };
  }

  return { ok: true, order: result };
}

/**
 * Compute effective trust tier for each model in the DAG.
 *
 * effective_tier(model) = min(declared_tier, min(effective_tier(upstream) for upstream in dependencies))
 *
 * A Gold model whose upstream is Bronze has effective_tier = bronze.
 * Source trust tiers can be provided via sourceTiers map.
 */
export function computeEffectiveTiers(
  dag: DagNode[],
  sourceTiers?: Map<string, TrustTier>
): Map<string, TrustTier> {
  const tierOrder: Record<TrustTier, number> = { bronze: 0, silver: 1, gold: 2 };
  const tierFromOrder = ['bronze', 'silver', 'gold'] as const;
  const effectiveTiers = new Map<string, TrustTier>();

  // Process in topological order (guaranteed by buildDag)
  for (const node of dag) {
    const declared =
      (node.parsedSpec.model_kind === 'agentic' ? undefined : node.parsedSpec.trust_tier) ??
      'bronze';
    let minUpstream = tierOrder[declared];

    // Check model dependencies
    for (const ref of node.refs) {
      const upstreamTier = effectiveTiers.get(ref) ?? 'bronze';
      minUpstream = Math.min(minUpstream, tierOrder[upstreamTier]);
    }

    // Check source dependencies
    if (sourceTiers) {
      for (const sourceRef of node.sourceRefs) {
        const sourceTier = sourceTiers.get(sourceRef) ?? 'bronze';
        minUpstream = Math.min(minUpstream, tierOrder[sourceTier]);
      }
    }

    const tier = tierFromOrder[minUpstream];
    if (!tier) throw new Error(`Invalid tier index ${minUpstream}`);
    effectiveTiers.set(node.name, tier);
  }

  return effectiveTiers;
}

/**
 * Mutating: stamp each node in the DAG with the integration handle it
 * belongs to, inferred by walking source refs and transitive upstream
 * models. Enforces the V0 single-integration invariant: a single model must
 * not mix sources (directly or transitively) from more than one integration.
 *
 * Relies on `dag` being in topological order (as produced by `buildDag`) so
 * upstream nodes always carry an `integration` value when their downstream
 * consumers are visited.
 */
export function inferDagIntegrations(dag: DagNode[]): void {
  const nodeByName = new Map<string, DagNode>();
  for (const node of dag) {
    nodeByName.set(node.name, node);
  }

  for (const node of dag) {
    const handles = new Set<string>();
    // Agent tool reads can use another connection. Only prepared inputs select
    // the output integration; the full dependency graph is still retained.
    const model = node.parsedSpec;
    const preparedRefs =
      model.model_kind === 'agentic'
        ? new Set(
            model.plan.steps.flatMap((step) => {
              const source = model.sources[step.source.ref];
              return source ? [source.ref.toLowerCase()] : [];
            })
          )
        : undefined;
    for (const sr of node.sourceRefs.filter(
      (ref) => !preparedRefs || preparedRefs.has(ref.toLowerCase())
    )) {
      const dot = sr.indexOf('.');
      if (dot > 0) handles.add(sr.slice(0, dot));
    }
    for (const ref of node.refs.filter(
      (ref) => !preparedRefs || preparedRefs.has(ref.toLowerCase())
    )) {
      const upstream = nodeByName.get(ref);
      if (upstream?.integration) handles.add(upstream.integration);
    }

    // `execution.engine` declares the engine integration the model runs in and
    // is the explicit signal that a cross-handle (mixed) model is intentional.
    // It overrides inferred source/upstream handles and skips the mixed-handle
    // throw below — the engine *is* the declared co-location point, so staging
    // foreign sources into it is the whole point. Resolve before `publish:` so
    // an explicit engine wins over the publish alias if both are set.
    const engine = getExecutionEngine(node.parsedSpec.execution);
    if (engine) {
      node.integration = engine;
      continue;
    }

    // `publish:` declares the destination integration directly and overrides
    // any inferred source/upstream handles. Resolve it before the
    // empty-handles early-exit so publish-only models (and models whose
    // upstream chains can't supply an integration) still get stamped.
    const publish = getPublishTarget(node.parsedSpec.publish);
    if (publish) {
      node.integration = publish;
      continue;
    }

    if (handles.size === 0) {
      // No source refs, no upstream model refs, no publish target — leave
      // integration unset so downstream filter drops it.
      continue;
    }

    if (handles.size > 1) {
      const list = [...handles].sort().join('", "');
      throw new Error(
        `Model "${node.name}" mixes sources from multiple integrations ["${list}"]. ` +
          `A single model must use sources from one integration. Split the model, ` +
          `or route the foreign sources through intermediate models.`
      );
    }

    // handles.size === 1 is guaranteed by the guards above.
    for (const only of handles) {
      node.integration = only;
      break;
    }
  }
}

/**
 * Return the subset of nodes whose inferred integration matches the given
 * handle, preserving topological order. Callers should run
 * `inferDagIntegrations` first.
 */
export function filterDagByIntegration(dag: DagNode[], handle: string): DagNode[] {
  return dag.filter((node) => node.integration === handle);
}

/**
 * Extract the subgraph needed to compile the requested models, including all
 * transitive UPSTREAM dependencies (ancestors).
 *
 * @deprecated The Model Spec CLI and orchestrators now select via the dbt-style
 * grammar in `@bobsled-inc/model-spec/selection`. `subgraph(dag, [X])` is
 * equivalent to `resolveSelection(nodes, ['+X'])` (model + ancestors); a bare
 * selection (`resolveSelection(nodes, ['X'])`) now means EXACTLY X. This helper
 * is retained for back-compat for external consumers that want upstream-closure
 * semantics; new code should use `resolveSelection`.
 */
export function subgraph(dag: DagNode[], requested: string[]): DagNode[] {
  const requestedSet = new Set(requested.map((r) => r.toLowerCase()));
  const needed = new Set<string>();

  // Build a lookup for quick access
  const nodeMap = new Map<string, DagNode>();
  for (const node of dag) {
    nodeMap.set(node.name, node);
  }

  // Recursively collect transitive deps
  function collect(name: string): void {
    if (needed.has(name)) return;
    needed.add(name);
    const node = nodeMap.get(name);
    if (node) {
      for (const ref of node.refs) {
        collect(ref);
      }
    }
  }

  for (const name of requestedSet) {
    collect(name);
  }

  // Return in original topological order, filtered to needed set
  return dag.filter((n) => needed.has(n.name));
}

/**
 * Expand an exact model selection to the minimal EXECUTION set: the selected
 * models plus their transitive EPHEMERAL ancestors.
 *
 * Ephemeral models emit no DDL — they are inlined as CTEs into their dependents
 * — so a selected model that refs an ephemeral upstream needs that upstream in
 * the same compile pass to be inlined, even under exact selection. Non-ephemeral
 * ancestors are intentionally NOT pulled in: they resolve to their physical
 * table via the model registry (see `buildIntegrationContext`'s `registryNodes`)
 * and must not be re-materialized by an exact selection.
 *
 * Returns the execution nodes in the DAG's topological order. Names are matched
 * case-insensitively (the DAG canonicalizes to lowercase).
 */
export function withEphemeralAncestors(dag: DagNode[], selected: Set<string>): DagNode[] {
  const byName = new Map<string, DagNode>();
  for (const node of dag) byName.set(node.name, node);

  const execution = new Set<string>();
  const stack: string[] = [];
  for (const name of selected) {
    const canonical = name.toLowerCase();
    if (!execution.has(canonical)) {
      execution.add(canonical);
      stack.push(canonical);
    }
  }

  while (stack.length > 0) {
    const node = byName.get(stack.pop()!);
    if (!node) continue;
    for (const ref of node.refs) {
      const canonical = ref.toLowerCase();
      const upstream = byName.get(canonical);
      if (upstream?.materialization === 'ephemeral' && !execution.has(canonical)) {
        execution.add(canonical);
        stack.push(canonical);
      }
    }
  }

  return dag.filter((node) => execution.has(node.name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .yml/.yaml files in a directory. */
export function collectYamlFiles(
  dir: string,
  results: string[] = [],
  fsImpl: FileSystem = nodeFs
): string[] {
  if (!fsImpl.existsSync(dir)) return results;

  const entries = fsImpl.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectYamlFiles(fullPath, results, fsImpl);
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      results.push(fullPath);
    }
  }

  return results;
}
