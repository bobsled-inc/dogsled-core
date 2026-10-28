/**
 * Pure dependency analysis for derived and agentic models.
 *
 * This module is the single source of truth for deciding whether a model runs
 * from materialized data or has a transitive live root. It does not read files,
 * compile SQL, fetch data, or execute a model.
 */

import { getSourceEntry, normalizeSourceRef } from './parser.js';

import type { SourceEntryRegistry } from './parser.js';
import type { ModelSpec } from '../agentic/model.js';

export type ModelExecutionMode = 'materialized' | 'on_read';

export interface ModelDependencyClosure {
  /** Dependency-first model names. The selected model is last. */
  models: string[];
  /** Authored qualified source refs in stable order. */
  sources: string[];
  liveSources: string[];
  materializedSources: string[];
}

export interface ModelDependencyAnalysis {
  modelName: string;
  executionMode: ModelExecutionMode;
  mixed: boolean;
  closure: ModelDependencyClosure;
}

export interface AnalyzeModelDependenciesOptions {
  models: readonly ModelSpec[];
  sourceEntries: SourceEntryRegistry;
}

export type AnalyzeModelDependenciesResult =
  | { ok: true; analyses: ModelDependencyAnalysis[] }
  | { ok: false; error: string };

function modelRefs(model: ModelSpec, sourceEntries: SourceEntryRegistry): string[] {
  if (model.model_kind === 'agentic') {
    const prepared = new Set(model.plan.steps.map((step) => step.source.ref));
    return Object.entries(model.sources)
      .filter(([alias, source]) => {
        // Adaptive API tools are capabilities, not SQL inputs to hydrate before the run.
        // The DAG still validates all declared refs and retains table/model dependencies.
        const entry = getSourceEntry(sourceEntries, source.ref);
        return prepared.has(alias) || entry?.kind !== 'api_resource';
      })
      .map(([, source]) => source.ref)
      .filter((ref) => ref !== model.name);
  }
  return [
    model.source.ref,
    ...(model.joins ?? []).map((join) => join.ref),
    ...(model.union ?? []).map((branch) => branch.ref),
  ];
}

/**
 * Analyze all models against one validated source registry.
 *
 * The result contains one entry for each input model, in input order. Each
 * closure uses dependency-first model order and stable source order.
 */
export function analyzeModelDependencies(
  options: AnalyzeModelDependenciesOptions
): AnalyzeModelDependenciesResult {
  const modelByName = new Map<string, ModelSpec>();
  for (const model of options.models) {
    const key = model.name.toLowerCase();
    if (modelByName.has(key)) {
      return {
        ok: false,
        error: `Duplicate model name "${model.name}" detected (case-insensitive).`,
      };
    }
    modelByName.set(key, model);
  }

  const analyzeOne = (target: ModelSpec): ModelDependencyAnalysis | string => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const orderedModels: ModelSpec[] = [];
    const sourceRefs = new Map<string, string>();

    const visit = (model: ModelSpec): string | undefined => {
      const key = model.name.toLowerCase();
      if (visited.has(key)) return undefined;
      if (visiting.has(key)) {
        return `Circular dependency detected at model "${model.name}".`;
      }
      visiting.add(key);

      for (const ref of modelRefs(model, options.sourceEntries)) {
        const upstream = !ref.includes('.') ? modelByName.get(ref.toLowerCase()) : undefined;
        if (upstream) {
          const error = visit(upstream);
          if (error) return error;
          continue;
        }

        const source = getSourceEntry(options.sourceEntries, ref);
        if (!source) {
          return `Model "${model.name}" references unknown source or model "${ref}".`;
        }
        sourceRefs.set(normalizeSourceRef(ref), source.sourceRef ?? ref);
      }

      visiting.delete(key);
      visited.add(key);
      orderedModels.push(model);
      return undefined;
    };

    const error = visit(target);
    if (error) return error;

    const orderedSources = [...sourceRefs]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, authoredRef]) => ({
        authoredRef,
        entry: getSourceEntry(options.sourceEntries, key)!,
      }));
    const liveSources = orderedSources.filter(
      ({ entry }) => entry.kind === 'api_resource' && entry.mode === 'live'
    );
    const materializedSources = orderedSources.filter(
      ({ entry }) => entry.kind !== 'api_resource' || entry.mode !== 'live'
    );

    return {
      modelName: target.name,
      executionMode: liveSources.length > 0 ? 'on_read' : 'materialized',
      mixed: liveSources.length > 0 && materializedSources.length > 0,
      closure: {
        models: orderedModels.map((model) => model.name),
        sources: orderedSources.map(({ authoredRef }) => authoredRef),
        liveSources: liveSources.map(({ authoredRef }) => authoredRef),
        materializedSources: materializedSources.map(({ authoredRef }) => authoredRef),
      },
    };
  };

  const analyses: ModelDependencyAnalysis[] = [];
  for (const model of options.models) {
    const analysis = analyzeOne(model);
    if (typeof analysis === 'string') return { ok: false, error: analysis };
    analyses.push(analysis);
  }
  return { ok: true, analyses };
}
