import * as path from 'node:path';

import { resolveCliBobsledProject } from '../runner/config/cli-project-location.js';

/** Resolve the selected local Project; explicit --config retains legacy behavior. */
export function resolveActionProjectRoot(
  configPath?: string,
  projectRoot?: string,
  cwd: string = process.cwd()
): string {
  const project = resolveCliBobsledProject({ configPath, projectRoot, cwd });
  return project?.projectRoot ?? path.resolve(cwd, projectRoot ?? '.');
}
