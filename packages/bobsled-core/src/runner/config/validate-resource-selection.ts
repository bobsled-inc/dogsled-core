import type { ResolvedPipeline, ValidationIssue } from './loader.js';

/**
 * A pipeline launches each resolved resource spec once and keys every override
 * map by that spec name. Duplicate authored refs (including entity + concrete
 * variant aliases) would therefore collapse and silently overwrite overrides.
 */
export function validateUniqueResolvedResources(
  pipeline: ResolvedPipeline,
  errors: ValidationIssue[]
): void {
  const firstByName = new Map<string, string>();
  const duplicates = new Set<string>();

  for (const resource of pipeline.resources) {
    const authored = resource.requestedName ?? resource.name;
    if (firstByName.has(resource.name)) {
      duplicates.add(`${firstByName.get(resource.name)} / ${authored} → ${resource.name}`);
    } else {
      firstByName.set(resource.name, authored);
    }
  }

  if (duplicates.size > 0) {
    errors.push({
      path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
      message:
        'Duplicate resources resolve to the same extractor stream: ' +
        `${[...duplicates].join(', ')}. Keep exactly one reference per resolved stream.`,
    });
  }
}
