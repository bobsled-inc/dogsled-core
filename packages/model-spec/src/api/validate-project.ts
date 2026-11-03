/**
 * `validateProject` — Layer 3 orchestrator for `dogsled model validate`.
 *
 * Returns per-integration validation findings plus metadata cross-reference
 * results without touching stdout. Metadata validation always runs against the
 * full DAG (not the `models` subset) so metric/relationship/VQ refs are never
 * silently ignored when the caller scopes validation to a subset.
 */

import { deprecatedAssignmentLimitFields, unsupportedAgenticFeatures } from '../agentic/limits.js';
import { resolveProjectIndex } from '@bobsled-inc/project-index';

import { validateAll, type SupportedDialect, type ValidateModelResult } from '../compiler/index.js';
import {
  loadIndexedMetadataRegistry,
  validateMetadataReferences,
  type MetadataRegistry,
} from '../entities/index.js';

import { toModelSpecRuntimeError } from '../errors.js';
import { checkpointIntegration } from './checkpoint-config.js';
import { loadProject, selectIntegrationContexts, type LoadedProject } from './load-project.js';
import { collectPhysicalFqnCollisions, formatFqnCollisionError } from './validate-physical-fqn.js';

export interface ValidateProjectOptions {
  integration?: string;
  models?: string[];
  /** Reject implicit raw_sql fallbacks. Defaults to true. */
  strict?: boolean;
  /** Add semantic metadata checks. Warn by default; strict promotes findings to errors. */
  semanticCheck?: 'warn' | 'strict';
  project?: LoadedProject;
}

export interface ValidateProjectIntegrationResult {
  handle: string;
  dialect: SupportedDialect;
  results: ValidateModelResult[];
}

export interface ValidateProjectResult {
  ok: boolean;
  byIntegration: ValidateProjectIntegrationResult[];
  metadata: MetadataRegistry;
  warnings: string[];
  skipped: Array<{ handle: string; message: string }>;
}

export async function validateProject(
  cwd: string,
  opts: ValidateProjectOptions = {}
): Promise<ValidateProjectResult> {
  try {
    return await validateProjectUnchecked(cwd, opts);
  } catch (error) {
    throw toModelSpecRuntimeError(error, {
      codePrefix: 'MODEL_PROJECT_VALIDATE',
      operation: 'model.project.validate',
    });
  }
}

async function validateProjectUnchecked(
  cwd: string,
  opts: ValidateProjectOptions = {}
): Promise<ValidateProjectResult> {
  const project = opts.project ?? (await loadProject(cwd));
  checkpointIntegration(project);
  const strict = opts.strict ?? true;

  // Metadata cross-reference validation always uses the full project graph so
  // metric/relationship/VQ refs are checked end-to-end even when the caller
  // scopes the compile pass to a subset of models. If the caller loaded the
  // project with `skipEntities`, reload the registry here so validation never
  // silently passes on an empty set.
  const entities =
    project.entities.metrics.size > 0 ||
    project.entities.relationships.size > 0 ||
    project.entities.entityRelationships.size > 0 ||
    project.entities.vqs.size > 0
      ? project.entities
      : loadIndexedMetadataRegistry(resolveProjectIndex(project.cwd, project.index));

  const fullModelNames = new Set(project.models.map((n) => n.name));
  const fullSourceKeys = new Set(project.sources.keys());
  // Derive integration handles from the loaded project so callers that
  // pre-populate `project.integrations` (e.g. via `loadProject({ skipIntegrations: true })`
  // and an in-memory map) avoid a redundant disk re-read of `integrations/*.yml`.
  const integrationHandles = new Set(project.integrations.keys());
  validateMetadataReferences(entities, {
    modelNames: fullModelNames,
    sourceKeys: fullSourceKeys,
    integrationHandles,
  });

  const skipped: ValidateProjectResult['skipped'] = [];
  const perIntegration = selectIntegrationContexts(project, {
    integration: opts.integration,
    models: opts.models,
    onSkipped: (reason) => skipped.push(reason),
  });

  const byIntegration: ValidateProjectIntegrationResult[] = [];
  let ok = true;

  for (const ictx of perIntegration) {
    const { dialect, modelReg, orderedNodes, registry, entryRegistry, integration } = ictx;
    const results = validateAll(orderedNodes, registry, modelReg, {
      dialect,
      strict,
      semanticCheck: opts.semanticCheck,
      entryRegistry,
    });
    // Agentic settings the schema accepts but runs reject, reported before any run.
    for (const result of results) {
      const node = project.models.find((model) => model.name === result.name);
      if (node?.parsedSpec.model_kind !== 'agentic') continue;
      result.errors.push(...unsupportedAgenticFeatures(node.parsedSpec));
      const deprecated = deprecatedAssignmentLimitFields(node.parsedSpec);
      if (deprecated.length) {
        result.warnings.push(
          `${deprecated.join(', ')} ${deprecated.length === 1 ? 'is' : 'are'} deprecated and ignored by new runs. Use limits.tokens or limits.max_cost_usd to cap a run.`
        );
      }
    }
    if (results.some((r) => r.errors.length > 0)) ok = false;
    byIntegration.push({
      handle: integration.handle,
      dialect,
      results,
    });
  }

  // Per-integration physical-FQN uniqueness. The collector keys on
  // `(integration_handle, normalized_fqn)` — cross-integration matches
  // are NOT collisions because two integrations are two different
  // connections (different warehouses, or different databases on the
  // same warehouse server). Runs over the same `perIntegration` set so
  // the check is naturally scoped to the same `opts.integration` /
  // `opts.models` filter the per-integration loop honored above.
  // Collisions are attached to every colliding model's
  // `ValidateModelResult.errors` array so the user sees the pairing
  // from any side. We also flip `ok` to false — a project with a
  // physical-FQN collision must not deploy.
  const collisions = collectPhysicalFqnCollisions(perIntegration);
  if (collisions.length > 0) {
    ok = false;
    // Build a quick lookup so we can attach the collision error to
    // every model that participates in it. Every model in one
    // collision shares the same integration handle (the collector's
    // grouping key), so the `(integration, name)` lookup is precise.
    const errorsByModel = new Map<string, string[]>();
    for (const collision of collisions) {
      for (const model of collision.models) {
        const key = `${model.integration}::${model.name}`;
        const list = errorsByModel.get(key) ?? [];
        list.push(formatFqnCollisionError(collision, model.integration, model.name));
        errorsByModel.set(key, list);
      }
    }
    for (const entry of byIntegration) {
      for (const result of entry.results) {
        const key = `${entry.handle}::${result.name}`;
        const extra = errorsByModel.get(key);
        if (extra) result.errors.push(...extra);
      }
    }
  }

  return {
    ok,
    byIntegration,
    metadata: entities,
    warnings: [...project.warnings],
    skipped,
  };
}
