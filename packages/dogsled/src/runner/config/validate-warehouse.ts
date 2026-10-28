import type {
  IntegrationsLib,
  ResolvedModelPipeline,
  ResolvedPipeline,
  ValidationIssue,
} from './loader.js';

/**
 * The exact message emitted when a per-resource `warehouse:` override is
 * found. Per-resource (and per-model) warehouse selection is deferred: the
 * runtime opens a single Snowflake session per run, so only pipeline-grained
 * selection is implementable today. Rejected (CommandError(2)) rather than
 * silently ignored so authors get a clear signal.
 */
export const PER_RESOURCE_WAREHOUSE_REJECTION =
  'Per-resource warehouse selection is not supported yet. ' +
  'Set `warehouse:` at the pipeline level instead.';

// ---------------------------------------------------------------------------
// Shared membership check
// ---------------------------------------------------------------------------

/**
 * Check whether `selector` appears in `declared` as a warehouse ID. A selector
 * is intentionally never matched against its configured warehouse-name value:
 * IDs are stable programmatic handles, while names are provider-specific
 * session values that can change independently.
 */
function checkWarehouseMembership(
  selector: string,
  declared: Record<string, string> | undefined
): { valid: true } | { valid: false; declaredIds: string[] } {
  const ids = Object.keys(declared ?? {});
  if (ids.includes(selector)) return { valid: true };
  return { valid: false, declaredIds: ids };
}

// ---------------------------------------------------------------------------
// Extract pipelines
// ---------------------------------------------------------------------------

/**
 * Cross-validate warehouse selectors on an (extract) pipeline:
 *
 *   (a) Any per-resource `warehouse:` override is rejected with the exact
 *       {@link PER_RESOURCE_WAREHOUSE_REJECTION} message.
 *   (b) A pipeline-level `warehouse:` selector is validated against the source
 *       integration's declared warehouse IDs. A selector is rejected when the
 *       provider has no warehouse-ID map, rather than silently ignored.
 */
export function validateWarehouseSelections(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib | undefined,
  errors: ValidationIssue[]
): void {
  // (a) Reject per-resource overrides UNCONDITIONALLY — the runtime can never
  //     honor them, so this must fire even when the integrations lib is
  //     unavailable (it needs no source metadata).
  for (const resource of pipeline.resources) {
    if (resource.override?.warehouse === undefined) continue;
    errors.push({
      path: `dogsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.warehouse`,
      message: PER_RESOURCE_WAREHOUSE_REJECTION,
    });
  }

  // (b) A selector is an execution contract, not a best-effort preference.
  //     Reject it when provider metadata is unavailable or has no map instead
  //     of emitting a manifest the runner cannot honor.
  if (pipeline.warehouse === undefined) return;
  if (lib === undefined) {
    errors.push({
      path: `dogsled.yml:pipelines.${pipeline.name}.warehouse`,
      message:
        `warehouse "${pipeline.warehouse}" cannot be validated for source "${pipeline.source}". ` +
        'Declared warehouse IDs: (unavailable).',
    });
    return;
  }

  let integration: ReturnType<IntegrationsLib['getIntegration']>;
  try {
    integration = lib.getIntegration(pipeline.source);
  } catch {
    // Source-not-found is already reported in validateDogsledConfig step 4.
    return;
  }

  const result = checkWarehouseMembership(pipeline.warehouse, integration.warehouses);
  if (!result.valid) {
    errors.push({
      path: `dogsled.yml:pipelines.${pipeline.name}.warehouse`,
      message:
        result.declaredIds.length === 0
          ? `warehouse "${pipeline.warehouse}" is not supported by source "${pipeline.source}" because it declares no warehouse IDs. ` +
            'Declared warehouse IDs: (none).'
          : `warehouse "${pipeline.warehouse}" is not a declared warehouse ID on source "${pipeline.source}". ` +
            `Declared warehouse IDs: ${result.declaredIds.join(', ')}.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Model pipelines
// ---------------------------------------------------------------------------

/**
 * Cross-validate warehouse selectors on `type: models` pipelines. Model
 * pipelines have no `resources` (per-resource rejection is N/A), so this
 * validates only the pipeline-level `warehouse:` against the connection's
 * declared warehouse IDs.
 *
 * The `connection` field on a models pipeline names a Model Spec integration handle
 * (e.g. `snowflake_prod`), looked up through `lib.getIntegration`.
 */
export function validateModelWarehouseSelections(
  pipeline: ResolvedModelPipeline,
  lib: IntegrationsLib | undefined,
  errors: ValidationIssue[]
): void {
  // Model pipelines carry no per-resource overrides. A supplied selector must
  // still resolve to a provider-declared ID, however.
  if (pipeline.warehouse === undefined) return;
  if (lib === undefined) {
    errors.push({
      path: `dogsled.yml:pipelines.${pipeline.name}.warehouse`,
      message:
        `warehouse "${pipeline.warehouse}" cannot be validated for connection "${pipeline.connection}". ` +
        'Declared warehouse IDs: (unavailable).',
    });
    return;
  }

  let integration: ReturnType<IntegrationsLib['getIntegration']>;
  try {
    integration = lib.getIntegration(pipeline.connection);
  } catch {
    // Connection-not-found is reported by validateModelPipelineMembership.
    return;
  }

  const result = checkWarehouseMembership(pipeline.warehouse, integration.warehouses);
  if (!result.valid) {
    errors.push({
      path: `dogsled.yml:pipelines.${pipeline.name}.warehouse`,
      message:
        result.declaredIds.length === 0
          ? `warehouse "${pipeline.warehouse}" is not supported by connection "${pipeline.connection}" because it declares no warehouse IDs. ` +
            'Declared warehouse IDs: (none).'
          : `warehouse "${pipeline.warehouse}" is not a declared warehouse ID on connection "${pipeline.connection}". ` +
            `Declared warehouse IDs: ${result.declaredIds.join(', ')}.`,
    });
  }
}
