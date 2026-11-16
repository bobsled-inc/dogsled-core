import * as fs from 'node:fs';
import * as path from 'node:path';

import { entryFilePath, entriesOfKind, scanProject } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';

import { bobsledProjectForConfig, type BobsledProjectLocation } from './loader.js';
import { openBobsledProject } from './project-files.js';

export interface ResolveCliBobsledProjectOptions {
  /** Explicit Project root. Relative paths resolve from cwd. */
  projectRoot?: string;
  /** Explicit config file. Relative paths resolve from projectRoot when given. */
  configPath?: string;
  /** Working directory used for relative paths and the default Project root. */
  cwd?: string;
}

/** Resolve a local CLI Project without searching parent directories by default. */
export function resolveCliBobsledProject(
  options: ResolveCliBobsledProjectOptions = {}
): BobsledProjectLocation | null {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.projectRoot !== undefined) {
    const projectRoot = path.resolve(cwd, options.projectRoot);
    const configPath =
      options.configPath === undefined ? undefined : path.resolve(projectRoot, options.configPath);
    if (configPath !== undefined) {
      const relativePath = path.relative(projectRoot, configPath);
      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new CommandError('configPath must live inside projectRoot.', 2);
      }
      try {
        const realRoot = fs.realpathSync(projectRoot);
        const realConfig = fs.realpathSync(configPath);
        const realRelative = path.relative(realRoot, realConfig);
        if (
          realRelative === '..' ||
          realRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(realRelative)
        ) {
          throw new CommandError('configPath must live inside projectRoot.', 2);
        }
      } catch (error) {
        if (error instanceof CommandError) throw error;
        // Let the Project scanner or config loader report missing paths.
      }
    }
    const index = openBobsledProject(projectRoot).index;
    if (configPath === undefined) {
      return {
        projectRoot,
        configPaths: entriesOfKind(index, 'pipeline_config').map((entry) =>
          entryFilePath(index, entry)
        ),
        index,
      };
    }
    return { projectRoot, configPaths: [configPath], index };
  }

  if (options.configPath !== undefined) return bobsledProjectForConfig(options.configPath, cwd);

  try {
    const index = scanProject(cwd);
    return index.entries.length > 0
      ? {
          projectRoot: cwd,
          configPaths: entriesOfKind(index, 'pipeline_config').map((entry) =>
            entryFilePath(index, entry)
          ),
          index,
        }
      : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}
