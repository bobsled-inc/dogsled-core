import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import * as path from 'node:path';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import { configureRenderedProjectSkills } from './project-skills.js';

import type { RenderedSetupFile, RenderedSetupWriteResult } from './types.js';

interface SafeRenderedParent {
  path: string;
  stat: Stats;
}

interface PreparedRenderedFile {
  file: RenderedSetupFile;
  filePath: string;
  parent: SafeRenderedParent;
}

function lstatIfPresent(filePath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertRenderedPathContained(outDir: string, candidate: string, displayPath: string): void {
  const relative = path.relative(outDir, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CommandError(
      `Rendered setup path "${displayPath}" escapes the output directory`,
      EXIT_VALIDATION
    );
  }
}

function resolveRenderedFilePath(outDir: string, relativePath: string): string {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new CommandError(
      `Rendered setup path "${relativePath}" must be a non-empty relative path`,
      EXIT_VALIDATION
    );
  }
  const filePath = path.resolve(outDir, relativePath);
  assertRenderedPathContained(outDir, filePath, relativePath);
  return filePath;
}

function assertNoRenderedSymlinks(
  outDir: string,
  candidate: string,
  requireDirectory: boolean
): void {
  const relative = path.relative(outDir, candidate);
  let current = outDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const entries = readdirSync(current);
    if (
      !entries.includes(segment) &&
      entries.some(
        (entry) => entry.toLocaleLowerCase('en-US') === segment.toLocaleLowerCase('en-US')
      )
    ) {
      throw new CommandError(
        `Rendered setup path "${path.relative(outDir, candidate)}" conflicts with existing path casing`,
        EXIT_VALIDATION
      );
    }
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new CommandError(
        `Refusing to write through symbolic link "${path.relative(outDir, current)}"`,
        EXIT_VALIDATION
      );
    }
    if ((requireDirectory || current !== candidate) && !stat.isDirectory()) {
      throw new CommandError(
        `Rendered setup parent "${path.relative(outDir, current)}" is not a directory`,
        EXIT_VALIDATION
      );
    }
  }
}

function ensureSafeRenderedParent(outDir: string, filePath: string): SafeRenderedParent {
  const parent = path.dirname(filePath);
  assertNoRenderedSymlinks(outDir, parent, true);
  mkdirSync(parent, { recursive: true });
  assertNoRenderedSymlinks(outDir, parent, true);
  const realParent = realpathSync(parent);
  assertRenderedPathContained(outDir, realParent, parent);
  return { path: realParent, stat: statSync(realParent) };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertExactLeafCase(parent: string, file: RenderedSetupFile): void {
  const expected = path.basename(file.path);
  const entries = readdirSync(parent);
  if (entries.includes(expected)) return;
  const collision = entries.find(
    (entry) => entry.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
  );
  if (collision) {
    throw new CommandError(
      `Rendered setup path "${file.path}" conflicts with existing "${collision}"; rename it to match exact casing`,
      EXIT_VALIDATION
    );
  }
}

function assertCurrentParent(
  filePath: string,
  file: RenderedSetupFile,
  parent: SafeRenderedParent
): void {
  const currentParent = realpathSync(path.dirname(filePath));
  if (currentParent !== parent.path || !sameFile(parent.stat, statSync(currentParent))) {
    throw new CommandError(
      `Rendered setup path "${file.path}" changed while it was being written`,
      EXIT_VALIDATION
    );
  }
}

function assertGeneratedLeaf(filePath: string, file: RenderedSetupFile): void {
  const existing = lstatIfPresent(filePath);
  if (existing?.isSymbolicLink()) {
    throw new CommandError(
      `Refusing to write through symbolic link "${file.path}"`,
      EXIT_VALIDATION
    );
  }
  if (existing && !existing.isFile()) {
    throw new CommandError(
      `Rendered setup path "${file.path}" must be a regular file`,
      EXIT_VALIDATION
    );
  }
  if (existing && existing.nlink > 1) {
    throw new CommandError(
      `Rendered setup path "${file.path}" must not be a hard link`,
      EXIT_VALIDATION
    );
  }
}

function assertOpenedSetupFile(
  descriptor: number,
  filePath: string,
  file: RenderedSetupFile,
  parent: SafeRenderedParent
): void {
  const opened = fstatSync(descriptor);
  if (!opened.isFile()) {
    throw new CommandError(
      `Rendered setup path "${file.path}" must be a regular file`,
      EXIT_VALIDATION
    );
  }
  if (opened.nlink > 1) {
    throw new CommandError(
      `Rendered setup path "${file.path}" must not be a hard link`,
      EXIT_VALIDATION
    );
  }
  assertCurrentParent(filePath, file, parent);
  assertExactLeafCase(parent.path, file);
  const currentPath = lstatSync(filePath);
  if (currentPath.isSymbolicLink() || !sameFile(opened, currentPath)) {
    throw new CommandError(
      `Rendered setup path "${file.path}" changed while it was being written`,
      EXIT_VALIDATION
    );
  }
}

function writeGeneratedSetupFile(
  file: RenderedSetupFile,
  filePath: string,
  parent: SafeRenderedParent
): void {
  assertGeneratedLeaf(filePath, file);
  assertExactLeafCase(parent.path, file);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new CommandError(
        `Refusing to write through symbolic link "${file.path}"`,
        EXIT_VALIDATION
      );
    }
    throw error;
  }
  try {
    assertOpenedSetupFile(descriptor, filePath, file, parent);
    if (fstatSync(descriptor).nlink > 1) {
      throw new CommandError(
        `Rendered setup path "${file.path}" must not be a hard link`,
        EXIT_VALIDATION
      );
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, file.content, 'utf-8');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writePreservedSetupFile(
  file: RenderedSetupFile,
  filePath: string,
  parent: SafeRenderedParent
): boolean {
  assertCurrentParent(filePath, file, parent);
  assertExactLeafCase(parent.path, file);
  if (lstatIfPresent(filePath)) {
    assertExactLeafCase(parent.path, file);
    assertCurrentParent(filePath, file, parent);
    return false;
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0)
    );
    assertOpenedSetupFile(descriptor, filePath, file, parent);
    if (fstatSync(descriptor).nlink > 1) {
      throw new CommandError(
        `Rendered setup path "${file.path}" must not be a hard link`,
        EXIT_VALIDATION
      );
    }
    writeFileSync(descriptor, file.content, 'utf-8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assertCurrentParent(filePath, file, parent);
    assertExactLeafCase(parent.path, file);
    assertCurrentParent(filePath, file, parent);
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeRenderedSetupFiles(
  files: RenderedSetupFile[],
  outDir: string
): RenderedSetupWriteResult {
  mkdirSync(outDir, { recursive: true });
  const realOutDir = realpathSync(outDir);
  const prepared: PreparedRenderedFile[] = files.map((file) => {
    const filePath = resolveRenderedFilePath(realOutDir, file.path);
    const parent = ensureSafeRenderedParent(realOutDir, filePath);
    assertExactLeafCase(parent.path, file);
    if (!file.preserveExisting) assertGeneratedLeaf(filePath, file);
    return { file, filePath, parent };
  });
  const written: string[] = [];
  const preserved: string[] = [];
  for (const { file, filePath, parent } of prepared) {
    if (file.preserveExisting) {
      if (writePreservedSetupFile(file, filePath, parent)) {
        written.push(file.path);
      } else {
        preserved.push(file.path);
      }
      continue;
    }
    writeGeneratedSetupFile(file, filePath, parent);
    written.push(file.path);
  }
  configureRenderedProjectSkills(files, realOutDir);
  return { written, preserved };
}
