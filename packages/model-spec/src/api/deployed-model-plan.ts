/**
 * File-less analysis and DuckDB planning for deployed model definitions.
 *
 * Hosts can keep committed source/model YAML in their own database, validate it
 * once, and ask Dogsled for the transitive execution closure without creating a
 * temporary project directory. The returned SQL uses deterministic internal
 * source aliases and contains no credentials or execution controls. The host
 * owns source reads, limits, staging, execution, cancellation, and cleanup.
 *
 * This module is an intentional exception to model-spec's general multi-dialect
 * code-generation rule. A deployed plan is a fixed contract for Dogsled's
 * query-time DuckDB runner, not portable warehouse SQL. The public API therefore
 * does not accept a dialect option.
 */

import {
  analyzeModelDependencies,
  buildInMemorySourceEntryRegistry,
  getSourceEntry,
  normalizeSourceRef,
  SourceSpecSchema,
  type SourceRegistryEntry,
  type ModelDependencyAnalysis,
  type ModelDependencyClosure,
  type ModelExecutionMode,
} from '../compiler/index.js';
import { ModelSpecSchema, type ModelSpec } from '../agentic/model.js';
import { CommandError } from '../errors.js';

import { compileInMemory } from './compile-in-memory.js';

export type DeployedModelExecutionMode = ModelExecutionMode;
export type DeployedModelExecutionClosure = ModelDependencyClosure;
export type DeployedModelAnalysis = ModelDependencyAnalysis;

export interface AnalyzeDeployedModelProjectOptions {
  sources: readonly unknown[];
  models: readonly unknown[];
}

export interface DeployedModelSourceBinding {
  ref: string;
  kind: SourceRegistryEntry['kind'];
  /** Logical table used by the compiled DuckDB SQL. */
  internalTable: string;
  /** Original deployed source definition used to fetch rows. */
  entry: SourceRegistryEntry;
  /** Same definition bound to `internalTable` for the query-time runner. */
  runtimeEntry: SourceRegistryEntry;
}

export interface PlanDeployedModelExecutionOptions extends AnalyzeDeployedModelProjectOptions {
  model: string;
}

export interface DeployedModelExecutionPlan extends DeployedModelAnalysis {
  /** Self-contained DuckDB SELECT with upstream models folded in as CTEs. */
  sql: string;
  sourceBindings: DeployedModelSourceBinding[];
}

interface ValidatedDefinitions {
  models: ModelSpec[];
  sourceEntries: ReturnType<typeof buildInMemorySourceEntryRegistry> & { ok: true };
}

function validationError(kind: 'source' | 'model', index: number, error: unknown): CommandError {
  return new CommandError(
    `Invalid deployed ${kind} definition at index ${index}: ${error instanceof Error ? error.message : String(error)}`,
    2
  );
}

function validateDefinitions(options: AnalyzeDeployedModelProjectOptions): ValidatedDefinitions {
  const sources = options.sources.map((value, index) => {
    const parsed = SourceSpecSchema.safeParse(value);
    if (!parsed.success) throw validationError('source', index, parsed.error);
    return parsed.data;
  });
  const models = options.models.map((value, index) => {
    const parsed = ModelSpecSchema.safeParse(value);
    if (!parsed.success) throw validationError('model', index, parsed.error);
    return parsed.data;
  });

  const sourceEntries = buildInMemorySourceEntryRegistry(sources);
  if (!sourceEntries.ok) throw new CommandError(sourceEntries.error, 2);

  return { models, sourceEntries };
}

function analyzeDefinitions(definitions: ValidatedDefinitions): DeployedModelAnalysis[] {
  const result = analyzeModelDependencies({
    models: definitions.models,
    sourceEntries: definitions.sourceEntries.entryRegistry,
  });
  if (!result.ok) throw new CommandError(result.error, 2);
  return result.analyses;
}

/** Analyze every deployed SQL or agentic model without reading a project directory. */
export function analyzeDeployedModelProject(
  options: AnalyzeDeployedModelProjectOptions
): DeployedModelAnalysis[] {
  const definitions = validateDefinitions(options);
  return analyzeDefinitions(definitions);
}

/**
 * Return a trusted, self-contained DuckDB plan for one deployed SQL model.
 * Agentic models in the requested closure require the agentic runtime and cannot
 * be executed as a query-time DuckDB SELECT.
 * The interface hides graph analysis, source aliasing, and SQL folding. It does
 * not execute the plan or enforce row, byte, or time limits. The host supplies
 * and enforces limits while it stages the source bindings and runs `sql`.
 */
export function planDeployedModelExecution(
  options: PlanDeployedModelExecutionOptions
): DeployedModelExecutionPlan {
  const definitions = validateDefinitions(options);
  const analyses = analyzeDefinitions(definitions);
  const analysis = analyses.find(
    (candidate) => candidate.modelName.toLowerCase() === options.model.toLowerCase()
  );
  if (!analysis) {
    throw new CommandError(`Unknown deployed model "${options.model}".`, 2);
  }
  const closureNames = new Set(analysis.closure.models.map((name) => name.toLowerCase()));
  const closureModels = definitions.models
    .filter((model) => closureNames.has(model.name.toLowerCase()))
    .map((model) => {
      if (model.model_kind === 'agentic') {
        throw new CommandError(
          `Cannot plan deployed model "${analysis.modelName}" as a DuckDB SELECT: its execution closure contains agentic model "${model.name}". Run it with the agentic runtime instead.`,
          2
        );
      }
      return model;
    });

  const runtimeSources = new Map(definitions.sourceEntries.registry);
  const runtimeEntries = new Map(definitions.sourceEntries.entryRegistry);
  const sourceBindings = analysis.closure.sources.map((ref, index): DeployedModelSourceBinding => {
    const entry = getSourceEntry(definitions.sourceEntries.entryRegistry, ref);
    if (!entry) throw new CommandError(`Missing source binding for "${ref}".`, 2);
    const internalTable = `sources.__bobsled_source_${index + 1}`;
    const runtimeEntry = { ...entry, fqRef: internalTable } as SourceRegistryEntry;
    const key = normalizeSourceRef(ref);
    for (const registryKey of runtimeSources.keys()) {
      if (normalizeSourceRef(registryKey) === key) runtimeSources.set(registryKey, internalTable);
    }
    for (const registryKey of runtimeEntries.keys()) {
      if (normalizeSourceRef(registryKey) === key) runtimeEntries.set(registryKey, runtimeEntry);
    }
    runtimeSources.set(key, internalTable);
    runtimeEntries.set(key, runtimeEntry);
    return {
      ref: entry.sourceRef ?? ref,
      kind: entry.kind,
      internalTable,
      entry,
      runtimeEntry,
    };
  });

  const compiled = compileInMemory({
    models: closureModels.map((model) => ({ name: model.name, spec: model })),
    sources: runtimeSources,
    entryRegistry: runtimeEntries,
    // Intentional fixed runtime contract. See the module note above.
    dialect: 'duckdb',
    targetSchema: '__bobsled_models',
    selectOnly: true,
    inlineDeps: true,
  });
  if (!compiled.ok) {
    const errors = compiled.results
      .filter((result) => !result.ok)
      .map((result) => result.error)
      .join('; ');
    throw new CommandError(`Could not compile deployed model "${options.model}": ${errors}`, 2);
  }
  const targetSql = compiled.results.find(
    (result) => result.ok && result.modelName.toLowerCase() === analysis.modelName.toLowerCase()
  );
  if (!targetSql?.ok) {
    throw new CommandError(`Deployed model "${options.model}" produced no DuckDB SELECT.`, 2);
  }

  return { ...analysis, sql: targetSql.sql, sourceBindings };
}
