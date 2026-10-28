/**
 * File loader for `integrations/<handle>.yml`.
 *
 * Resolves the file path under `<projectDir>/integrations/`, reads + parses
 * YAML, validates against `IntegrationFileSchema`, and returns the parsed
 * result. All validation failures surface as `CommandError(2)` so the Model Spec
 * CLI can report a clean exit code.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';
import YAML from 'yaml';

import type { IntegrationFile } from '../schemas/integration.js';
import { IntegrationFileSchema } from '../schemas/integration.js';

import {
  assertFileSizeUnder,
  assertProjectFileSafe,
  assertSafeDirName,
  assertSafeHandle,
  MAX_YAML_BYTES,
  YAML_EXTENSIONS,
} from './shared.js';

export interface LoadIntegrationOptions {
  /**
   * Override the directory name (default: `integrations`). Rarely needed —
   * exists so Model Spec can honor `model-spec.yml`'s `integrations_dir` field.
   */
  dirName?: string;
}

/**
 * Load and parse a single integration file by handle.
 */
export async function loadIntegration(
  projectDir: string,
  handle: string,
  options: LoadIntegrationOptions = {}
): Promise<IntegrationFile> {
  assertSafeHandle(handle, 'integration handle');
  const dirName = options.dirName ?? 'integrations';
  assertSafeDirName(dirName, 'integrations dirName');
  const dir = path.join(projectDir, dirName);

  const candidates = integrationFileCandidates(dir, handle);
  const filePath = await pickExistingFile(projectDir, handle, candidates);
  if (filePath === null) {
    throw new CommandError(
      `Integration "${handle}" not found: no ${candidates
        .map((c) => path.relative(projectDir, c))
        .join(' or ')}.`,
      2
    );
  }

  await assertProjectFileSafe(projectDir, filePath, 'integration file');
  const parsed = await parseIntegrationFile(filePath);
  if (parsed.name !== handle) {
    throw new CommandError(
      `Integration name "${parsed.name}" in ${path.relative(projectDir, filePath)} must match the filename stem "${handle}".`,
      2
    );
  }
  return parsed;
}

/**
 * Load every integration file from `<projectDir>/<dirName>/` into a map keyed
 * by integration name. Duplicate names (across files in the directory) throw.
 */
export async function loadIntegrationDirectory(
  projectDir: string,
  options: LoadIntegrationOptions = {}
): Promise<Map<string, IntegrationFile>> {
  const dirName = options.dirName ?? 'integrations';
  assertSafeDirName(dirName, 'integrations dirName');
  const dir = path.join(projectDir, dirName);

  let entries: string[];
  try {
    const dirStat = await fs.lstat(dir);
    if (dirStat.isSymbolicLink()) {
      throw new CommandError(`Refusing to use symlink integrations directory ${dir}.`, 2);
    }
    await assertProjectFileSafe(projectDir, dir, 'integrations directory');
    entries = (await fs.readdir(dir)).sort();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return new Map();
    throw new CommandError(
      `Failed to read integrations directory ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      2
    );
  }

  const candidates: Array<{ handle: string; filePath: string }> = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(fullPath);
    } catch (err) {
      throw new CommandError(
        `Failed to stat integration entry ${path.relative(projectDir, fullPath)}: ${describeError(err)}`,
        2
      );
    }

    if (stat.isSymbolicLink()) {
      throw new CommandError(
        `Refusing to use symlink integration entry ${path.relative(projectDir, fullPath)}.`,
        2
      );
    }

    if (stat.isFile() && YAML_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      candidates.push({ handle: stripYamlExtension(entry), filePath: fullPath });
      continue;
    }

    if (stat.isDirectory()) {
      const nested = await pickExistingFile(
        projectDir,
        entry,
        nestedIntegrationFileCandidates(dir, entry)
      );
      if (nested) candidates.push({ handle: entry, filePath: nested });
    }
  }

  const result = new Map<string, IntegrationFile>();
  for (const candidate of candidates) {
    const { handle, filePath } = candidate;
    await assertProjectFileSafe(projectDir, filePath, 'integration file');
    const parsed = await parseIntegrationFile(filePath);

    if (parsed.name !== handle) {
      throw new CommandError(
        `Integration name "${parsed.name}" in ${path.relative(projectDir, filePath)} must match the integration handle "${handle}".`,
        2
      );
    }

    if (result.has(handle)) {
      throw new CommandError(
        `Duplicate integration name "${handle}" in ${dirName}/. ` +
          `Each integration must have a unique name across all files.`,
        2
      );
    }
    result.set(handle, parsed);
  }

  return result;
}

function integrationFileCandidates(dir: string, handle: string): string[] {
  return [
    ...YAML_EXTENSIONS.map((ext) => path.join(dir, `${handle}${ext}`)),
    ...nestedIntegrationFileCandidates(dir, handle),
  ];
}

function nestedIntegrationFileCandidates(dir: string, handle: string): string[] {
  return [...YAML_EXTENSIONS.map((ext) => path.join(dir, handle, `integration${ext}`))];
}

function stripYamlExtension(filename: string): string {
  for (const ext of YAML_EXTENSIONS) {
    if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  return filename;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function pickExistingFile(
  projectDir: string,
  handle: string,
  candidates: readonly string[]
): Promise<string | null> {
  const matches: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      matches.push(candidate);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') continue;
      throw new CommandError(
        `Failed to access integration file ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
        2
      );
    }
  }

  if (matches.length > 1) {
    throw new CommandError(
      `Integration "${handle}" is ambiguous: ${matches
        .map((m) => path.relative(projectDir, m))
        .join(' and ')} both exist. Keep only one.`,
      2
    );
  }

  return matches[0] ?? null;
}

async function parseIntegrationFile(filePath: string): Promise<IntegrationFile> {
  await assertFileSizeUnder(filePath, MAX_YAML_BYTES, 'integration file');

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new CommandError(`Failed to read integration file ${filePath}: ${describeError(err)}`, 2);
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new CommandError(`Invalid YAML in ${filePath}: ${describeError(err)}`, 2);
  }

  const parsed = IntegrationFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('integration', filePath, parsed.error, {
        schema: IntegrationFileSchema,
      }),
      2
    );
  }

  return parsed.data;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
