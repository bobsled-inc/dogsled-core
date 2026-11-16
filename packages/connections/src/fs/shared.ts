/**
 * Shared filesystem helpers for the `loadIntegration` / `loadTarget` readers.
 *
 * Handle validation lives with the Zod schemas; the helpers here cover
 * path-traversal safety and YAML parsing with typed `CommandError`s so that
 * Model Spec CLI exit codes match the project convention (`2` = validation error).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

/**
 * Reject handles that could escape the target directory when interpolated
 * into `<handle>.yml`. We also reject path separators and uppercase — the
 * schema already enforces snake_case at parse time, but the CLI may invoke
 * these loaders with handles that have not been schema-checked yet (e.g.
 * `--integration foo`), so we re-check here.
 */
export function assertSafeHandle(handle: string, fieldName = 'handle'): void {
  if (!/^[a-z][a-z0-9_]*$/.test(handle)) {
    throw new CommandError(
      `Invalid ${fieldName} "${handle}": must be snake_case ` +
        `(lowercase letters, digits, underscores; starting with a letter).`,
      2
    );
  }
}

/**
 * Extensions the loaders accept, in preference order. If both exist we emit
 * a warning and use the first (matching `bobsled.yml` behavior).
 */
export const YAML_EXTENSIONS = ['.yml', '.yaml'] as const;

/**
 * Reject directory names that could escape the project root when joined
 * with `<projectDir>`. Allows simple identifiers and single-level relative
 * subpaths (e.g. `integrations`, `config/integrations`) but blocks `..`
 * segments, absolute paths, and empty strings.
 */
export function assertSafeDirName(dirName: string, fieldName = 'dirName'): void {
  if (dirName.length === 0) {
    throw new CommandError(`Invalid ${fieldName}: must not be empty.`, 2);
  }
  const segments = dirName.split(/[/\\]/);
  if (segments.some((s) => s === '' || s === '..' || s === '.')) {
    throw new CommandError(
      `Invalid ${fieldName} "${dirName}": must be a relative path without "..", ".", or empty segments.`,
      2
    );
  }
  if (/^([a-zA-Z]:)?[/\\]/.test(dirName)) {
    throw new CommandError(`Invalid ${fieldName} "${dirName}": absolute paths are not allowed.`, 2);
  }
}

/**
 * Max size for a single YAML file. The loaders read the whole file into
 * memory before parsing, so a truly large file would balloon the process.
 * 1 MiB is well above any realistic integration/target spec (tens of KB at
 * most) but still small enough to fail fast on pathological input.
 */
export const MAX_YAML_BYTES = 1024 * 1024;

/**
 * Require an existing project file to stay inside `projectDir` without using
 * symlinks in any path component below that root.
 */
export async function assertProjectFileSafe(
  projectDir: string,
  filePath: string,
  fieldName = 'file'
): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(projectDir);
  } catch (err) {
    throw new CommandError(
      `Failed to resolve project directory ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }

  const rootResolved = path.resolve(projectDir);
  const candidateResolved = path.resolve(filePath);
  const lexicalRelative = path.relative(rootResolved, candidateResolved);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`)) {
    throw new CommandError(`${fieldName} ${filePath} resolves outside the project directory.`, 2);
  }

  let current = rootResolved;
  for (const part of lexicalRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      throw new CommandError(
        `Failed to inspect ${fieldName} ${current}: ${err instanceof Error ? err.message : String(err)}`,
        2
      );
    }
    if (stat.isSymbolicLink()) {
      throw new CommandError(`Refusing to use symlink ${fieldName} ${current}.`, 2);
    }
  }

  let candidateReal: string;
  try {
    candidateReal = await fs.realpath(candidateResolved);
  } catch (err) {
    throw new CommandError(
      `Failed to resolve ${fieldName} ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }
  const resolvedRelative = path.relative(rootReal, candidateReal);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`)) {
    throw new CommandError(`${fieldName} ${filePath} resolves outside the project directory.`, 2);
  }
}

export async function assertFileSizeUnder(
  filePath: string,
  maxBytes: number,
  fieldName = 'file'
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new CommandError(
      `Failed to stat ${fieldName} ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      2
    );
  }
  if (stat.size > maxBytes) {
    throw new CommandError(
      `${fieldName} ${filePath} is ${stat.size} bytes; exceeds the ${maxBytes}-byte limit.`,
      2
    );
  }
}
