/**
 * `compileProject` — Layer 3 orchestrator for `bobsled model compile`.
 *
 * Accepts a Model Spec project directory (or a pre-loaded `LoadedProject`) and returns
 * typed per-integration `CompileResult[]` groups. Does not touch stdout; the
 * CLI handler formats the structured result for display. `compileInMemory`
 * covers the file-less variant for DB-backed hosts (see `./compile-in-memory.ts`).
 */

import { resolveProjectIndex } from '@bobsled-inc/project-index';

import {
  getModelOutputColumns,
  type AgenticColumn,
  type AgenticModelSpec,
} from '../agentic/model.js';
import {
  compileAll,
  validateAll,
  subgraph,
  type CompileResult,
  type SupportedDialect,
} from '../compiler/index.js';
import {
  loadIndexedMetadataRegistry,
  validateMetadataReferences,
  type MetadataRegistry,
} from '../entities/index.js';
import { CommandError } from '../errors.js';
import { resolveSelection } from '../selection.js';

import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';

/**
 * Per-integration compile output. `results` is a mix of `{ ok: true, sql }`
 * and `{ ok: false, error }` entries — callers decide whether a partial
 * failure is fatal. Successes and errors are kept interleaved so the original
 * DAG order is preserved.
 */
export interface CompileProjectIntegrationResult {
  handle: string;
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  results: CompileResult[];
  /** Agentic plans are never SQL compile results. Present only for mixed projects. */
  agenticPlans?: Array<{ model: AgenticModelSpec; outputColumns: AgenticColumn[]; refs: string[] }>;
}

export interface CompileProjectResult {
  ok: boolean;
  byIntegration: CompileProjectIntegrationResult[];
  warnings: string[];
  /** Integrations declared but with no referencing model. */
  skipped: Array<{ handle: string; message: string }>;
  /**
   * Loaded metadata (metrics/relationships/VQs) cross-validated against the
   * full project graph. Only present when `includeMetadata` is set.
   */
  metadata?: MetadataRegistry;
}

export interface CompileProjectOptions {
  /** Narrow compile to a single integration handle. Omit for fan-out. */
  integration?: string;
  /**
   * Model selection — dbt-style selector tokens (`X`, `+X`, `X+`, `+X+`,
   * `tag:foo`). A bare name compiles EXACTLY that model. When `inlineDeps` is
   * set, the selection is expanded to its upstream closure so the inlined deps
   * are available to hoist.
   */
  models?: string[];
  /** Enable compiler warnings in the per-model results. */
  warnings?: boolean;
  /**
   * Also load + validate metrics / relationships / VQs and return them in
   * `result.metadata`. Cross-references are checked against the full project
   * DAG, not the `--models` subset.
   */
  includeMetadata?: boolean;
  /**
   * Pre-loaded project to reuse — skips the FS load entirely. When provided,
   * `cwd` is ignored for I/O purposes (still used for metadata lookup when
   * `includeMetadata` is set and `project.entities` is empty).
   */
  project?: LoadedProject;
  /**
   * Inline upstream model dependencies as CTEs instead of referencing them by
   * fully-qualified physical name. `true` inlines every upstream model; a
   * `Set<string>` inlines only the named drafts (case-insensitive). Sources
   * always stay as physical refs. See `CompileAllOptions.inlineDeps`.
   */
  inlineDeps?: boolean | ReadonlySet<string>;
  /** Emit SELECT-only SQL (no DDL wrapper). Useful for inline-deps preview. */
  selectOnly?: boolean;
}

/**
 * Compile all referenced models and return structured per-integration results.
 *
 * Fatal project-structure errors (missing models/, unknown refs) surface as
 * `CommandError`. Per-model compile failures are returned inside
 * `result.byIntegration[*].results` as `{ ok: false }` entries; the top-level
 * `ok` field reflects whether any model failed across all integrations.
 */
export async function compileProject(
  cwd: string,
  opts: CompileProjectOptions = {}
): Promise<CompileProjectResult> {
  const project = opts.project ?? (await loadProject(cwd));

  // `inlineDeps` hoists upstream models as CTEs, which requires those upstreams
  // to be in the compiled (execution) set. Under exact selection a bare
  // `models: ['X']` would compile only X, leaving an inlined ref to its
  // upstream unresolved — so when inlining is requested we expand the selection
  // to its upstream closure. (`compile` without `inlineDeps` stays exact.)
  let models = opts.models;
  if (opts.inlineDeps && models && models.length > 0) {
    const selected = resolveSelection(
      project.models.map((node) => ({
        name: node.name,
        refs: node.refs,
        tags: node.parsedSpec.model_kind === 'agentic' ? [] : node.parsedSpec.tags,
      })),
      models
    );
    const expanded = subgraph(project.models, selected).map((node) => node.name);
    // Only override when the expansion is non-empty. An empty result (e.g. a
    // `tag:nonexistent` selector) must keep the ORIGINAL selectors so
    // `selectIntegrationContexts` surfaces the proper "No models found matching"
    // error instead of an empty `models: []` being read as "compile everything".
    if (expanded.length > 0) {
      models = expanded;
    }
  }

  const skipped: CompileProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    models,
    onSkipped: (reason) => skipped.push(reason),
  });

  const byIntegration: CompileProjectIntegrationResult[] = [];
  let ok = true;

  for (const ictx of perIntegration) {
    const {
      dialect,
      targetSchema,
      targetDatabase,
      targetWarehouse,
      modelReg,
      orderedNodes,
      registry,
      entryRegistry,
      integration,
    } = ictx;
    const agenticPlans = orderedNodes.flatMap((node) =>
      node.parsedSpec.model_kind === 'agentic'
        ? [
            {
              model: node.parsedSpec,
              outputColumns: getModelOutputColumns(node.parsedSpec) as AgenticColumn[],
              refs: node.refs,
            },
          ]
        : []
    );
    const results = compileAll(
      orderedNodes.filter((node) => node.parsedSpec.model_kind !== 'agentic'),
      registry,
      modelReg,
      {
        dialect,
        targetSchema,
        targetDatabase,
        defaultDynamicTableWarehouse: targetWarehouse,
        entryRegistry,
        warnings: opts.warnings ?? false,
        inlineDeps: opts.inlineDeps,
        selectOnly: opts.selectOnly,
      }
    );
    for (const validation of validateAll(
      orderedNodes.filter((node) => node.parsedSpec.model_kind === 'agentic'),
      registry,
      modelReg,
      { dialect, entryRegistry }
    )) {
      for (const error of validation.errors) {
        results.push({ ok: false, error, modelName: validation.name });
      }
    }
    if (results.some((r) => !r.ok)) ok = false;
    byIntegration.push({
      handle: integration.handle,
      dialect,
      targetSchema,
      targetDatabase,
      results,
      ...(agenticPlans.length ? { agenticPlans } : {}),
    });
  }

  const result: CompileProjectResult = {
    ok,
    byIntegration,
    warnings: [...project.warnings],
    skipped,
  };

  if (opts.includeMetadata) {
    const hasEntities =
      project.entities.metrics.size > 0 ||
      project.entities.relationships.size > 0 ||
      project.entities.entityRelationships.size > 0 ||
      project.entities.vqs.size > 0;
    const metadata = hasEntities
      ? project.entities
      : loadIndexedMetadataRegistry(resolveProjectIndex(project.cwd, project.index));

    const modelNames = new Set(project.models.map((n) => n.name));
    const sourceKeys = new Set(project.sources.keys());
    // Derive integration handles from the loaded project so hosts that pre-populate
    // `project.integrations` (e.g. via `loadProject({ skipIntegrations: true })`
    // and an in-memory map) avoid a redundant disk re-read of `integrations/*.yml`.
    const integrationHandles = new Set(project.integrations.keys());
    validateMetadataReferences(metadata, { modelNames, sourceKeys, integrationHandles });
    result.metadata = metadata;
  }

  return result;
}

/**
 * `compileProject` guarantee check — every per-integration result must flag a
 * failure if any model failed. Callers that need to throw on first error can
 * use this helper.
 */
export function firstCompileError(result: CompileProjectResult): string | undefined {
  for (const group of result.byIntegration) {
    const errors = group.results.filter((r): r is CompileResult & { ok: false } => !r.ok);
    if (errors.length > 0) {
      return errors
        .map((e) => `[${group.handle}] ${e.modelName ?? 'unknown'}: ${e.error}`)
        .join('\n');
    }
  }
  return undefined;
}

// Re-export CommandError for callers that want to throw on compile failure.
export { CommandError };
