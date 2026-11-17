import * as path from 'node:path';

import { ProjectIndexError, type ProjectIndex } from '@bobsled-inc/project-index';

import { modelProjectIndex, resolveModelProjectRoot } from './model-discovery.js';
import type { DogsledProject } from './project-files.js';
import type { DogsledConfig } from './schema.js';

/**
 * Warn about relationships in the config's Model Spec project whose one side does not
 * join on that dataset's declared primary key. A separate Model Spec project that does
 * not open is left to model validation. The Model Spec project API loads only when the
 * project has relationship or Ossie files.
 */
export async function projectRelationshipKeyWarnings(
  config: DogsledConfig,
  project: DogsledProject
): Promise<string[]> {
  let index: ProjectIndex;
  try {
    index = modelProjectIndex(config, project);
  } catch (error) {
    if (error instanceof ProjectIndexError) return [];
    throw error;
  }
  if (!index.entries.some((entry) => entry.kind === 'relationship' || entry.kind === 'ossie')) {
    return [];
  }
  const { indexedRelationshipKeyWarnings } = await import('@bobsled-inc/model-spec/project');
  const modelRoot = path.resolve(resolveModelProjectRoot(config, project.root));
  const folder = modelRoot === project.root ? undefined : config.models?.project;
  return indexedRelationshipKeyWarnings(index).map((warning) => {
    const file = folder === undefined ? warning.path : path.posix.join(folder, warning.path);
    return `${file}: ${warning.message} ${warning.remedy}`;
  });
}
