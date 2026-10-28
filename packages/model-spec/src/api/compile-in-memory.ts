/**
 * `compileInMemory` — file-less variant of `compileProject`.
 *
 * For hosts whose models and sources do not live on disk (e.g. database-backed
 * YAML, REPL-style tooling). The caller hands over already-parsed model specs
 * plus a source registry; this function builds the DAG, sorts it, builds a
 * model registry, and runs `compileAll`. No `model-spec.yml` discovery, no YAML IO,
 * no integration fan-out — one dialect + schema per call.
 *
 * Thin wrapper around the Layer 1 primitives (`buildDag`-equivalent topo sort,
 * `buildModelRegistry`, `compileAll`) so hosts don't have to copy/paste the
 * orchestration boilerplate into their own data-model compilation service.
 */

import {
  buildModelRegistry,
  compileAll,
  type CompileResult,
  type DagNode,
  type MaterializationType,
  type ModelRegistry,
  type SourceEntryRegistry,
  type SourceRegistry,
  type SupportedDialect,
  type TransformSpec,
} from '../compiler/index.js';

export interface InMemoryModel {
  /** Canonical model name. Case-insensitive match against ref strings. */
  name: string;
  /** Already-validated transform spec (caller is responsible for `TransformSpecSchema.parse`). */
  spec: TransformSpec;
}

export interface CompileInMemoryOptions {
  models: InMemoryModel[];
  /**
   * Map of source ref (`connection.name` or bare `name`) → fully-qualified
   * warehouse identifier. Qualified source lookup does not depend on case.
   * Authored keys remain unchanged for display.
   */
  sources: SourceRegistry;
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  /** Emit SELECT-only SQL (no DDL wrapper). */
  selectOnly?: boolean;
  /** Reject implicit `raw_sql` passthrough. Default: false (mirrors CLI). */
  strict?: boolean;
  /**
   * Inline upstream model dependencies as CTEs instead of emitting them as
   * references to physical tables/views. `true` inlines every upstream model;
   * a `Set<string>` inlines only the named drafts (case-insensitive). See
   * `CompileAllOptions.inlineDeps` for the full semantics and caveats.
   */
  inlineDeps?: boolean | ReadonlySet<string>;
  /**
   * Source entry registry keyed by `connection.name`. Required by BigQuery
   * union models that use `include_all_columns: true` — the canonical
   * projection looks up source column lists here. Hosts can build one from
   * their parsed `SourceSpec`s via `buildInMemorySourceEntryRegistry`.
   *
   * Without it, BigQuery `include_all_columns` models will trip the
   * `bigquery_union_drift_guard` even when the source is otherwise present in
   * `sources`. Optional for all other dialects and for models that enumerate
   * columns explicitly.
   */
  entryRegistry?: SourceEntryRegistry;
}

export interface CompileInMemoryResult {
  ok: boolean;
  results: CompileResult[];
  /** The model registry used — exposed for hosts that need it for downstream queries. */
  modelRegistry: ModelRegistry;
}

interface SortInput {
  model: InMemoryModel;
  modelRefs: string[];
  sourceRefs: string[];
}

function collectRefs(spec: TransformSpec): string[] {
  const refs: string[] = [spec.source.ref];
  for (const join of spec.joins ?? []) refs.push(join.ref);
  for (const branch of spec.union ?? []) refs.push(branch.ref);
  return refs;
}

function topologicalSort(
  entries: SortInput[]
): { ok: true; order: DagNode[] } | { ok: false; error: string } {
  const nodeMap = new Map<string, DagNode>();
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const { model, modelRefs, sourceRefs } of entries) {
    const name = model.name.toLowerCase();
    const node: DagNode = {
      name,
      filePath: `<memory:${model.name}>`,
      refs: modelRefs,
      sourceRefs,
      parsedSpec: model.spec,
      materialization: (model.spec.materialization?.type ?? 'view') as MaterializationType,
    };
    nodeMap.set(name, node);
    adjacency.set(name, []);
    inDegree.set(name, 0);
  }

  for (const { model, modelRefs } of entries) {
    const name = model.name.toLowerCase();
    for (const ref of modelRefs) {
      if (!nodeMap.has(ref)) {
        return {
          ok: false,
          error: `Model "${model.name}" references unknown model "${ref}".`,
        };
      }
      if (ref === name) {
        return {
          ok: false,
          error: `Model "${model.name}" references itself (cycle).`,
        };
      }
      adjacency.get(ref)!.push(name);
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  const result: DagNode[] = [];
  let queue = [...nodeMap.keys()].filter((n) => inDegree.get(n) === 0).sort();

  while (queue.length > 0) {
    const next: string[] = [];
    for (const name of queue) {
      result.push(nodeMap.get(name)!);
      for (const dep of adjacency.get(name) ?? []) {
        const d = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, d);
        if (d === 0) next.push(dep);
      }
    }
    queue = next.sort();
  }

  if (result.length < entries.length) {
    const remaining = entries
      .filter((e) => (inDegree.get(e.model.name.toLowerCase()) ?? 0) > 0)
      .map((e) => e.model.name);
    return {
      ok: false,
      error: `Circular dependency detected among models: ${remaining.join(', ')}`,
    };
  }

  return { ok: true, order: result };
}

export function compileInMemory(opts: CompileInMemoryOptions): CompileInMemoryResult {
  const {
    models,
    sources,
    dialect,
    targetSchema,
    targetDatabase,
    selectOnly,
    strict,
    inlineDeps,
    entryRegistry,
  } = opts;

  if (models.length === 0) {
    return {
      ok: true,
      results: [],
      modelRegistry: new Map<string, string>(),
    };
  }

  const modelNameSet = new Set<string>();
  for (const model of models) {
    const lower = model.name.toLowerCase();
    if (modelNameSet.has(lower)) {
      return {
        ok: false,
        results: [
          {
            ok: false,
            modelName: '_dag_error',
            error: `Duplicate model name "${model.name}" (case-insensitive).`,
          },
        ],
        modelRegistry: new Map<string, string>(),
      };
    }
    modelNameSet.add(lower);
  }

  const sortEntries: SortInput[] = models.map((model) => {
    const refs = collectRefs(model.spec);
    const modelRefs: string[] = [];
    const sourceRefs: string[] = [];
    for (const ref of refs) {
      const lower = ref.toLowerCase();
      if (modelNameSet.has(lower)) {
        modelRefs.push(lower);
      } else {
        sourceRefs.push(ref);
      }
    }
    return { model, modelRefs, sourceRefs };
  });

  const sorted = topologicalSort(sortEntries);
  if (!sorted.ok) {
    return {
      ok: false,
      results: [{ ok: false, modelName: '_dag_error', error: sorted.error }],
      modelRegistry: new Map<string, string>(),
    };
  }

  const modelNames = sorted.order.map((n) => n.name);
  const modelRegistry = buildModelRegistry(
    modelNames,
    targetSchema,
    dialect,
    targetDatabase ? new Map(modelNames.map((n) => [n, { targetDatabase }])) : undefined
  );

  const results = compileAll(sorted.order, sources, modelRegistry, {
    dialect,
    targetSchema,
    targetDatabase,
    selectOnly,
    strict,
    inlineDeps,
    entryRegistry,
  });

  return {
    ok: results.every((r) => r.ok),
    results,
    modelRegistry,
  };
}
