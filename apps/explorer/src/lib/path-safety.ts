import * as path from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';

function isPathWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolve a path inside `root`, rejecting anything that escapes via symlinks,
 * `..`, or absolute paths. Handles partially-existing paths (e.g., a duckdb
 * file that has not been created yet) by resolving existing segments through
 * realpath and checking the final target stays within the realpath of `root`.
 */
export function resolveSafePathWithinRoot(root: string, subpath: string): string {
  if (subpath.includes('\0')) {
    throw new Error('Path contains null byte');
  }
  const realRoot = realpathSync(root);
  const resolved = path.resolve(realRoot, subpath);
  const relative = path.relative(realRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes root');
  }

  const parts = relative.split(path.sep).filter(Boolean);
  let current = realRoot;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const candidate = path.join(current, part);
    if (!existsSync(candidate)) {
      const remaining = parts.slice(index);
      const finalPath = path.join(current, ...remaining);
      if (!isPathWithinRoot(realRoot, finalPath)) {
        throw new Error('Path escapes root');
      }
      return finalPath;
    }

    current = realpathSync(candidate);
    if (!isPathWithinRoot(realRoot, current)) {
      throw new Error('Path escapes root');
    }

    if (index < parts.length - 1 && !lstatSync(current).isDirectory()) {
      throw new Error('Path escapes root');
    }
  }

  return current;
}
