import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { BUILT_IN_SOURCE_FILES, BUILT_IN_SOURCES_SHA256 } from './generated-data.js';

const PREFIX = 'dogsled-integrations-';
const FALLBACK_ROOTS_KEY = Symbol.for('@bobsled-inc/integrations/materialized-sources');

let verifiedRoot: string | undefined;

function ownerTag(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** A real directory (not a symlink) that only the current user can read or change. */
function isPrivateDirectory(stats: Stats | undefined): boolean {
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if (typeof process.getuid !== 'function') return true;
  return stats.uid === process.getuid() && (stats.mode & 0o077) === 0;
}

function hasExactContent(root: string): boolean {
  for (const [key, content] of Object.entries(BUILT_IN_SOURCE_FILES)) {
    try {
      if (readFileSync(join(root, ...key.split('/')), 'utf-8') !== content) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writeTree(root: string): void {
  for (const [key, content] of Object.entries(BUILT_IN_SOURCE_FILES)) {
    const target = join(root, ...key.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx' });
  }
}

function removeOnExit(path: string): void {
  const registry = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let roots = registry[FALLBACK_ROOTS_KEY];
  if (!roots) {
    const created = new Set<string>();
    registry[FALLBACK_ROOTS_KEY] = created;
    process.once('exit', () => {
      for (const root of created) rmSync(root, { recursive: true, force: true });
    });
    roots = created;
  }
  roots.add(path);
}

/**
 * Folder with a copy of the built-in sources, for callers that need real files
 * (extractor subprocesses, the `integrations` copy command). Lookups never use it.
 *
 * The copy is shared per user and content version:
 * `<tmpdir>/dogsled-integrations-<uid>-<sha256 prefix>/sources`. It is built in a
 * private `mkdtemp` sibling and renamed into place, and reused only when it is a
 * real directory owned by this user with mode 0700 and exactly the embedded
 * content. Otherwise this process uses its own private copy, removed on exit.
 */
export function materializeBuiltInSources(): string {
  if (verifiedRoot !== undefined && isPrivateDirectory(lstatOrUndefined(dirname(verifiedRoot)))) {
    return verifiedRoot;
  }

  const base = tmpdir();
  const target = join(base, `${PREFIX}${ownerTag()}-${BUILT_IN_SOURCES_SHA256.slice(0, 16)}`);
  const targetSources = join(target, 'sources');
  const existing = lstatOrUndefined(target);
  if (isPrivateDirectory(existing) && hasExactContent(targetSources)) {
    verifiedRoot = targetSources;
    return verifiedRoot;
  }

  const staging = mkdtempSync(join(base, `${PREFIX}${ownerTag()}-staging-`));
  try {
    writeTree(join(staging, 'sources'));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  if (isPrivateDirectory(existing)) {
    rmSync(target, { recursive: true, force: true });
  }
  if (existing === undefined || isPrivateDirectory(existing)) {
    try {
      renameSync(staging, target);
      verifiedRoot = targetSources;
      return verifiedRoot;
    } catch {
      if (isPrivateDirectory(lstatOrUndefined(target)) && hasExactContent(targetSources)) {
        rmSync(staging, { recursive: true, force: true });
        verifiedRoot = targetSources;
        return verifiedRoot;
      }
    }
  }

  removeOnExit(staging);
  verifiedRoot = join(staging, 'sources');
  return verifiedRoot;
}
