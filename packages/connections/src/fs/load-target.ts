/**
 * File loader for `targets/<handle>.yml`.
 *
 * Reads + parses YAML, validates against `TargetFileSchema`. Resolution of
 * the referenced integration is NOT performed here — callers compose
 * `loadTarget` with `loadIntegration` when they need the full view.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';
import YAML from 'yaml';

import type { TargetFile } from '../schemas/target.js';
import { TargetFileSchema } from '../schemas/target.js';

import {
  assertFileSizeUnder,
  assertProjectFileSafe,
  assertSafeDirName,
  assertSafeHandle,
  MAX_YAML_BYTES,
  YAML_EXTENSIONS,
} from './shared.js';

export interface LoadTargetOptions {
  /** Override the directory name (default: `targets`). */
  dirName?: string;
}

export async function loadTarget(
  projectDir: string,
  handle: string,
  options: LoadTargetOptions = {}
): Promise<TargetFile> {
  assertSafeHandle(handle, 'target handle');
  const dirName = options.dirName ?? 'targets';
  assertSafeDirName(dirName, 'targets dirName');
  const dir = path.join(projectDir, dirName);

  const candidates = YAML_EXTENSIONS.map((ext) => path.join(dir, `${handle}${ext}`));

  const matches: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      matches.push(candidate);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') continue;
      throw new CommandError(
        `Failed to access target file ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
        2
      );
    }
  }

  if (matches.length > 1) {
    throw new CommandError(
      `Target "${handle}" is ambiguous: ${matches
        .map((m) => path.relative(projectDir, m))
        .join(' and ')} both exist. Keep only one.`,
      2
    );
  }

  const filePath = matches[0] ?? null;
  if (filePath === null) {
    throw new CommandError(
      `Target "${handle}" not found: no ${candidates
        .map((c) => path.relative(projectDir, c))
        .join(' or ')}.`,
      2
    );
  }

  await assertProjectFileSafe(projectDir, filePath, 'target file');
  await assertFileSizeUnder(filePath, MAX_YAML_BYTES, 'target file');

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new CommandError(
      `Failed to read target file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new CommandError(
      `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }

  const parsed = TargetFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('target', filePath, parsed.error, {
        schema: TargetFileSchema,
      }),
      2
    );
  }

  if (parsed.data.name !== handle) {
    throw new CommandError(
      `Target name "${parsed.data.name}" in ${path.relative(projectDir, filePath)} must match the filename stem "${handle}".`,
      2
    );
  }

  return parsed.data;
}
