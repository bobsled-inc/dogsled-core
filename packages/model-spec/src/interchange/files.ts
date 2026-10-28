import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectPathProblem } from '@bobsled-inc/project-index';
import { CommandError } from '../errors.js';
import { parseInterchangeInput, type ConversionResult } from './common.js';

export function readConversionInput(path: string): unknown {
  return parseInterchangeInput(readConversionText(path), path);
}

export function readConversionText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_000_000) {
      throw new CommandError(`${path}: Expected a regular file of at most 1 MB`, 2);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
/** Write into a new directory only. Never merges with or overwrites a user's project. */
export function writeConversionFiles(result: ConversionResult, outputDirectory: string): void {
  if (!result.ok) throw new CommandError('Cannot write a failed conversion', 2);
  const paths = new Set<string>();
  for (const item of result.files) {
    const problem = projectPathProblem(item.path);
    if (problem || paths.has(item.path)) {
      throw new CommandError(`Invalid or duplicate conversion path: ${item.path}`, 2);
    }
    paths.add(item.path);
  }
  const root = resolve(outputDirectory);
  // Atomic directory creation prevents replacing existing files, directories or symlinks.
  mkdirSync(root);
  try {
    for (const item of result.files) {
      const target = join(root, item.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, item.content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Write a one-document conversion to a new file. */
export function writeConversionFile(result: ConversionResult, outputFile: string): void {
  if (!result.ok || result.files.length !== 1) {
    throw new CommandError('Expected one successful conversion file', 2);
  }
  const target = resolve(outputFile);
  let fd: number | undefined;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(fd, result.files[0]!.content);
  } catch (error) {
    if (fd !== undefined) rmSync(target, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
