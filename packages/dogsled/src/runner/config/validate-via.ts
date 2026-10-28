import type { IntegrationsLib, ResolvedPipeline, ValidationIssue } from './loader.js';

export function validateViaSelections(
  pipeline: ResolvedPipeline,
  lib: IntegrationsLib,
  errors: ValidationIssue[]
): void {
  let integration: ReturnType<IntegrationsLib['getIntegration']>;
  try {
    integration = lib.getIntegration(pipeline.source);
  } catch {
    // Source-not-found is already reported in validateDogsledConfig step 4; skip here.
    return;
  }
  const transportIds = new Set(integration.transports.map((t) => t.id));
  const available = integration.transports.map((t) => t.id).join(', ');

  if (pipeline.via !== undefined && !transportIds.has(pipeline.via)) {
    errors.push({
      path: `dogsled.yml:pipelines.${pipeline.name}.via`,
      message:
        `transport "${pipeline.via}" not found on source "${pipeline.source}". ` +
        `Available: ${available}.`,
    });
  }

  for (const resource of pipeline.resources) {
    const resourceVia = resource.override?.via;
    if (resourceVia === undefined) continue;
    if (!transportIds.has(resourceVia)) {
      errors.push({
        path: `dogsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.via`,
        message:
          `transport "${resourceVia}" not found on source "${pipeline.source}". ` +
          `Available: ${available}.`,
      });
    }
  }
}
