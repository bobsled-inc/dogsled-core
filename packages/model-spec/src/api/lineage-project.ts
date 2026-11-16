/**
 * `lineageProject` — Layer 3 orchestrator for `bobsled model lineage`.
 *
 * Returns per-integration lineage data (DAG nodes + effective trust tiers)
 * without doing any rendering. The CLI layer composes `renderLineage` for
 * ASCII output; hosts can build their own visualizations directly off
 * `models` and `effectiveTiers`.
 */

import {
  computeEffectiveTiers,
  extractColumnLineage,
  parseTransformSpecFromParsed,
  type DagNode,
  type SourceColumnState,
  type SupportedDialect,
  type TrustTier,
} from '../compiler/index.js';

import { getModelOutputColumns } from '../agentic/model.js';
import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';
import { CommandError } from '../errors.js';
import path from 'node:path';

import type { ColumnLineageEntry } from '../compiler/index.js';

export interface LineageProjectOptions {
  /** Restrict lineage to a single integration handle. */
  integration?: string;
  /** Restrict lineage to these model names. */
  models?: string[];
  /** Optional preloaded project for callers that already paid the load cost. */
  project?: LoadedProject;
}

export interface LineageProjectIntegrationResult {
  /** Integration handle that owns the returned DAG. */
  handle: string;
  /** SQL dialect selected for this integration. */
  dialect: SupportedDialect;
  /** Topologically ordered model DAG nodes. */
  models: DagNode[];
  /** Column-level upstream references for the selected model DAG. */
  columnLineage: ColumnLineageEntry[];
  /** Effective trust tier per model after upstream downgrades are applied. */
  effectiveTiers: Map<string, TrustTier>;
}

export interface LineageProjectResult {
  /** Per-integration lineage results. */
  byIntegration: LineageProjectIntegrationResult[];
  /** Non-fatal project load warnings. */
  warnings: string[];
  /** Integrations skipped because the model selection did not apply. */
  skipped: Array<{ handle: string; message: string }>;
}

/**
 * Loads a Model Spec project and returns render-neutral model and column lineage data.
 */
export async function lineageProject(
  cwd: string,
  opts: LineageProjectOptions = {}
): Promise<LineageProjectResult> {
  const project = opts.project ?? (await loadProject(cwd));

  const skipped: LineageProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    models: opts.models,
    onSkipped: (reason) => skipped.push(reason),
  });

  const byIntegration: LineageProjectIntegrationResult[] = [];

  for (const ictx of perIntegration) {
    const sourceColumns = new Map<string, SourceColumnState>();
    for (const [ref, entry] of ictx.entryRegistry) {
      sourceColumns.set(ref, {
        columns: entry.columns.map((column) => column.name),
        hasUnknownPassthrough: false,
      });
    }
    const columnLineage: ColumnLineageEntry[] = [];
    for (const node of ictx.orderedNodes) {
      let nodeLineage: ColumnLineageEntry[];
      if (node.parsedSpec.model_kind === 'agentic') {
        // Output names are known, but executor reasoning supplies no SQL column provenance.
        nodeLineage = getModelOutputColumns(node.parsedSpec).map((column) => ({
          model: node.name,
          column: column.name,
          upstream: [],
          isComplete: false,
        }));
      } else {
        const parsed = parseTransformSpecFromParsed(node.parsedSpec, ictx.registry, ictx.modelReg);
        if (!parsed.ok) {
          throw new CommandError(`${path.relative(cwd, node.filePath)}: ${parsed.error}`, 2);
        }
        nodeLineage = extractColumnLineage(parsed.spec, { sourceColumns });
      }
      columnLineage.push(...nodeLineage);
      const modelColumns: string[] = [];
      for (const entry of nodeLineage) {
        if (entry.column !== '*') modelColumns.push(entry.column);
      }
      sourceColumns.set(node.name, {
        columns: dedupeColumns(modelColumns),
        hasUnknownPassthrough: nodeLineage.some((entry) => entry.column === '*'),
      });
    }

    byIntegration.push({
      handle: ictx.integration.handle,
      dialect: ictx.dialect,
      models: ictx.orderedNodes,
      columnLineage,
      effectiveTiers: computeEffectiveTiers(ictx.orderedNodes),
    });
  }

  return {
    byIntegration,
    warnings: [...project.warnings],
    skipped,
  };
}

function dedupeColumns(columns: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const column of columns) {
    const key = column.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(column);
  }
  return deduped;
}
