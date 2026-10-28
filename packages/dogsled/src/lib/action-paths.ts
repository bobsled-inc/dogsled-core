import * as path from 'node:path';

import { resolveCliDogsledProject } from '../runner/config/cli-project-location.js';

/** Resolve the selected local Project; explicit --config retains legacy behavior. */
export function resolveActionProjectRoot(
  configPath?: string,
  projectRoot?: string,
  cwd: string = process.cwd()
): string {
  const project = resolveCliDogsledProject({ configPath, projectRoot, cwd });
  return project?.projectRoot ?? path.resolve(cwd, projectRoot ?? '.');
}
