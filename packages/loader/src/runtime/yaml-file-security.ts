import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

export const MAX_YAML_FILE_BYTES = 1024 * 1024;

export async function assertYamlFileSize(
  filePath: string,
  label: string,
  maxBytes = MAX_YAML_FILE_BYTES
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CommandError(`${label} not found at ${filePath}`, 2);
    }
    throw new CommandError(
      `Failed to inspect ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      2
    );
  }
  if (stat.size > maxBytes) {
    throw new CommandError(
      `${label} ${filePath} is ${stat.size} bytes; exceeds the ${maxBytes}-byte limit.`,
      2
    );
  }
}

export async function assertProjectYamlFileSafe(
  projectDir: string,
  filePath: string,
  label: string
): Promise<void> {
  const rootResolved = path.resolve(projectDir);
  const candidateResolved = path.resolve(filePath);
  const lexicalRelative = path.relative(rootResolved, candidateResolved);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`)) {
    throw new CommandError(`${label} ${filePath} resolves outside the project directory.`, 2);
  }

  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootResolved);
  } catch (error) {
    throw new CommandError(
      `Failed to resolve project directory ${projectDir}: ${error instanceof Error ? error.message : String(error)}`,
      2
    );
  }

  let current = rootResolved;
  for (const part of lexicalRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      throw new CommandError(
        `Failed to inspect ${label} ${current}: ${error instanceof Error ? error.message : String(error)}`,
        2
      );
    }
    if (stat.isSymbolicLink()) {
      throw new CommandError(`Refusing to use symlink ${label} ${current}.`, 2);
    }
  }

  const candidateReal = await fs.realpath(candidateResolved);
  const resolvedRelative = path.relative(rootReal, candidateReal);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`)) {
    throw new CommandError(`${label} ${filePath} resolves outside the project directory.`, 2);
  }
}
