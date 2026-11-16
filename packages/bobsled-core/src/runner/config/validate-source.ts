import { documentName, entriesOfKind } from '@bobsled-inc/project-index';

import type { IntegrationsLib, ResolvedPipeline, ValidationIssue } from './loader.js';
import type { BobsledProject } from './project-files.js';

/** Accept both bundled integrations and authored project-local sources. */
export function validateSourcePresence(
  pipelines: ResolvedPipeline[],
  lib: IntegrationsLib,
  project: BobsledProject,
  errors: ValidationIssue[]
): void {
  const localSources = new Set(
    entriesOfKind(project.index, 'integration')
      .map(documentName)
      .filter((name): name is string => name !== undefined)
  );
  for (const pipeline of pipelines) {
    if (localSources.has(pipeline.source)) continue;
    try {
      lib.getIntegration(pipeline.source);
    } catch {
      errors.push({
        path: `dogsled.yml:pipelines.${pipeline.name}.source`,
        message: `Source "${pipeline.source}" not found in bundled or project-local integrations`,
      });
    }
  }
}
