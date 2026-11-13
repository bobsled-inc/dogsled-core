/**
 * Shared utilities for rename and privacy ratchet guards.
 *
 * Both guards share file-listing, area classification, baseline comparison,
 * and CLI argument parsing. This module keeps that logic in one place.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceFiles } from '../ci/source-files.mjs';
import { validateOldNameExceptions } from './old-name-exceptions.mjs';

const currentFile = fileURLToPath(import.meta.url);
export const guardsDir = path.dirname(currentFile);
export const repoRoot = path.resolve(guardsDir, '..', '..');

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.webm',
  '.zip',
  '.tar',
  '.gz',
  '.br',
  '.bz2',
  '.pdf',
  '.wasm',
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.pyc',
]);

/**
 * Parse CLI arguments. Supports `--flag` and `--key=value`.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (const token of argv) {
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=', 2);
      result[key] = value ?? true;
    } else {
      result._.push(token);
    }
  }
  return result;
}

/**
 * List git-tracked files, excluding pnpm-lock.yaml and binary extensions.
 * Returns relative paths (forward-slash separated).
 */
export function listScanFiles({ includeLockfile = false, includeSvg = false } = {}) {
  return sourceFiles(repoRoot).filter((rel) => {
    if (rel === 'pnpm-lock.yaml') return includeLockfile;
    if (path.extname(rel).toLowerCase() === '.svg' && includeSvg) return true;
    return !BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase());
  });
}

/**
 * Classify a repo-relative path into a top-level area for per-area counting.
 *
 * `packages/<name>` and `apps/<name>` are broken out individually.
 * Known top-level directories get their own area. Everything else is `<root>`.
 */
export function classifyArea(relativePath) {
  const parts = relativePath.split('/');
  if (parts[0] === 'packages' && parts.length > 1) {
    return `packages/${parts[1]}`;
  }
  if (parts[0] === 'apps' && parts.length > 1) return `apps/${parts[1]}`;
  const topDirs = [
    'docs',
    'examples',
    '.agents',
    'scripts',
    'tests',
    'actions',
    'workspace',
    '.github',
    '.claude',
  ];
  if (topDirs.includes(parts[0])) return parts[0];
  return '<root>';
}

/**
 * Read a JSON baseline file. Returns `null` when the file is missing.
 */
export function readBaseline(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Write a JSON baseline file atomically.
 */
export function writeBaseline(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Compare current counts against a baseline section.
 *
 * Returns `{ ok, increases, decreases }`. The guard fails when `ok` is false
 * (any count increased).
 */
export function compareSection(baseline, current, label) {
  const increases = [];
  const decreases = [];

  for (const [key, currentCount] of Object.entries(current)) {
    const baselineCount = baseline[key] ?? 0;
    if (currentCount > baselineCount) {
      increases.push({ key, label, baseline: baselineCount, current: currentCount });
    } else if (currentCount < baselineCount) {
      decreases.push({ key, label, baseline: baselineCount, current: currentCount });
    }
  }

  for (const [key, baselineCount] of Object.entries(baseline)) {
    if (!(key in current) && baselineCount > 0) {
      decreases.push({ key, label, baseline: baselineCount, current: 0 });
    }
  }

  return { ok: increases.length === 0, increases, decreases };
}

/**
 * Scan a file's lines against a list of patterns. Each pattern must have
 * `id` (string) and either `regex` (RegExp with `g` flag) or `scan(line)`
 * returning an array of `{ column }` match objects.
 *
 * Returns a map of `patternId -> [{ file, line, column }]`.
 */
export function scanFileLines(relativePath, lines, patterns) {
  const results = new Map();
  for (const pattern of patterns) {
    results.set(pattern.id, []);
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineNumber = lineIndex + 1;

    for (const pattern of patterns) {
      let matches;
      if (pattern.scan) {
        matches = pattern.scan(line, relativePath);
      } else {
        matches = [];
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = regex.exec(line)) !== null) {
          matches.push({ column: m.index + 1 });
          if (!regex.global) break;
        }
      }

      for (const match of matches) {
        results.get(pattern.id).push({
          file: relativePath,
          line: lineNumber,
          column: match.column,
        });
      }
    }
  }

  return results;
}

/**
 * Print up to `max` example locations for a set of findings.
 * Prints `rule-id file:line` without matched text to avoid leaking content.
 */
export function printExamples(findings, patternId, max = 10) {
  const examples = findings.slice(0, max);
  for (const finding of examples) {
    process.stderr.write(`  ${patternId} ${finding.file}:${finding.line}\n`);
  }
  if (findings.length > max) {
    process.stderr.write(`  ... and ${findings.length - max} more\n`);
  }
}

export const GUARD_SELF_REFERENCE_PATHS = new Set([
  'scripts/guards/lib.mjs',
  'scripts/guards/old-name-exceptions.mjs',
  'scripts/guards/privacy.mjs',
  'scripts/guards/privacy-baseline.json',
  'scripts/guards/privacy-exceptions.json',
  'tests/unit/guard-privacy.test.mjs',
  'tests/unit/security-runtime-policy.test.mjs',
]);

export function loadGuardSidecar(moduleFile = currentFile, root = repoRoot) {
  const sidecarPath = `${moduleFile}.private.json`;
  if (!existsSync(sidecarPath)) return { exceptions: [], selfReferences: [] };
  const data = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  if (
    data?.version !== 1 ||
    Object.keys(data).sort().join(',') !== 'exceptions,selfReferences,version' ||
    !Array.isArray(data.selfReferences) ||
    !Array.isArray(data.exceptions)
  )
    throw new Error('Invalid optional guard sidecar.');
  const assertFile = (relative) => {
    if (
      typeof relative !== 'string' ||
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes('\\') ||
      /[\*?\[\]{}]/.test(relative) ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Guard sidecar requires exact paths.');
    const file = path.join(root, relative);
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Error(`Guard sidecar points at a missing file: ${relative}`);
    const resolved = path.relative(realpathSync(root), realpathSync(file));
    if (resolved.startsWith('..') || path.isAbsolute(resolved))
      throw new Error('Guard sidecar path escapes source.');
  };
  const seen = new Set();
  for (const entry of data.selfReferences) {
    if (
      Object.keys(entry ?? {})
        .sort()
        .join(',') !== 'path,reason' ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim() ||
      seen.has(entry.path)
    )
      throw new Error('Guard sidecar self-references need exact paths and reasons.');
    assertFile(entry.path);
    seen.add(entry.path);
  }
  const exceptions = validateOldNameExceptions(
    { version: 1, exceptions: data.exceptions },
    data.exceptions.map((entry) => entry.patternId)
  );
  for (const entry of exceptions) assertFile(entry.path);
  return {
    exceptions,
    selfReferences: [
      ...data.selfReferences.map((entry) => entry.path),
      path.relative(root, sidecarPath),
    ],
  };
}

const sidecar = loadGuardSidecar();
export const PRIVATE_OLD_NAME_EXCEPTIONS = sidecar.exceptions;
for (const relative of sidecar.selfReferences) GUARD_SELF_REFERENCE_PATHS.add(relative);
