/**
 * `autoEmitDocumentSpec` — write a default document `entity_resolution`
 * spec for a `format: document` resource.
 *
 * Helper retained for programmatic callers. The extractor
 * runtime does not call this implicitly; use `entity-graph scaffold document`
 * for the CLI workflow.
 *
 * Returns a structured result instead of throwing on the "already exists"
 * branch so callers can distinguish "wrote a new spec" from "left
 * existing spec untouched" in their logs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import { renderDocumentResolutionSpec } from '../templates/document.js';

export interface AutoEmitDocumentSpecOptions {
  /** Project root (defaults to `process.cwd()`). */
  cwd?: string;
  /** mdmDir from model-spec.yml — typically `entity-graph` or `mdm`. */
  mdmDir: string;
  /** Resource name (e.g. `support`, `confluence_pages`). Validated as identifier. */
  resourceName: string;
  /** Override the recency column (default: extracted_at). */
  recencyColumn?: string;
}

export type AutoEmitDocumentSpecResult =
  | { written: true; path: string; reason: 'created' }
  | { written: false; path: string; reason: 'already_exists' };

/**
 * Emit `<mdmDir>/document/<resourceName>/spec.yml` when missing. Idempotent;
 * an existing file is never overwritten.
 *
 * `mdmDir` is treated as untrusted user input. The resolved target path is
 * validated to stay within `cwd` so values like `../../outside` cannot
 * escape the project root.
 *
 * The "create-if-missing" semantic uses `writeFileSync` with the `wx`
 * flag so the existence check and the write are atomic; concurrent
 * writers can't race past `existsSync` and clobber each other.
 */
export function autoEmitDocumentSpec(
  options: AutoEmitDocumentSpecOptions
): AutoEmitDocumentSpecResult {
  if (!options.mdmDir || typeof options.mdmDir !== 'string') {
    throw new CommandError(`autoEmitDocumentSpec: mdmDir is required and must be a string`, 2);
  }
  const cwd = options.cwd ?? process.cwd();
  const root = resolve(cwd);
  const target = resolve(root, options.mdmDir, 'document', options.resourceName, 'spec.yml');
  const rel = relative(root, target);
  if (rel.length === 0 || isAbsolute(rel) || rel.startsWith('..')) {
    throw new CommandError(
      `autoEmitDocumentSpec: resolved target path escapes cwd (mdmDir='${options.mdmDir}').`,
      2
    );
  }

  // renderDocumentResolutionSpec validates resourceName / recencyColumn
  // identifiers; if they're unsafe it throws CommandError(2) before any
  // FS write happens.
  const yaml = renderDocumentResolutionSpec({
    resourceName: options.resourceName,
    ...(options.recencyColumn ? { recencyColumn: options.recencyColumn } : {}),
  });

  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, yaml, { encoding: 'utf8', flag: 'wx' });
    return { written: true, path: target, reason: 'created' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { written: false, path: target, reason: 'already_exists' };
    }
    throw err;
  }
}
