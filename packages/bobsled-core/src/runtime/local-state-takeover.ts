import * as os from 'node:os';
import * as path from 'node:path';

import {
  duckDbFileInUse,
  duckDbLakeDataPathStore,
  localStateTakeoverRoot,
  prepareLocalStateDir,
} from '@bobsled-inc/connections';
import { entryFilePath, type ProjectIndex } from '@bobsled-inc/project-index';

import { findBobsledProject, hasRootConfig } from '../runner/config/loader.js';

/** The `--project-root` a command names, in either form, else undefined. */
function projectRootArg(argv: readonly string[]): string | undefined {
  for (const [i, arg] of argv.entries()) {
    if (arg === '--project-root' && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith('--project-root=')) return arg.slice('--project-root='.length);
  }
  return undefined;
}

/** A path into the folder: at the start of a value, after a separator, or after a slash. */
const naming = (folder: string) =>
  new RegExp(`(^|[\\s'":=,[/])${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'm');

/** Project YAML files, without comment lines, and the command line that name the folder. */
function references(root: string, index: ProjectIndex, argv: readonly string[]) {
  return (folder: string): string[] => {
    const pattern = naming(folder);
    const files = index.entries
      .filter((entry) => entry.format === 'yaml')
      .filter((entry) =>
        pattern.test(
          entry.content
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n')
        )
      )
      .map((entry) => path.relative(root, entryFilePath(index, entry)));
    return argv.some((arg) => pattern.test(arg)) ? [...files, 'this command'] : files;
  };
}

/**
 * Takes over an earlier local state folder once, before any command or delegated subprocess
 * reads it: only the folder at the root of the Project this command resolves, never one above
 * it, and the home folder only when it is itself a Project. Never fails the command: on any
 * problem the earlier folder is read in place.
 */
export async function takeOverLocalState(argv: readonly string[]): Promise<void> {
  const start = path.resolve(projectRootArg(argv) ?? process.cwd());
  const stateRoot = localStateTakeoverRoot(start);
  if (!stateRoot) return;
  if (stateRoot === os.homedir() && !hasRootConfig(stateRoot)) return;
  const project = findBobsledProject(start);
  if (!project?.index || path.resolve(project.projectRoot) !== stateRoot) return;
  await prepareLocalStateDir(stateRoot, {
    lake: duckDbLakeDataPathStore(),
    databaseInUse: duckDbFileInUse(),
    referencedBy: references(stateRoot, project.index, argv),
  }).catch(() => undefined);
}
