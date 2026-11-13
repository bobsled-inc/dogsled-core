import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { ProjectSkill } from '@bobsled-inc/skills/project';

import { COPY_MARKER_SPELLINGS } from './legacy-names.js';

export const COPY_MARKER_FILE = '.dogsled-project-skill.json';
/** Every marker name a managed copy may carry, the current one first. */
const COPY_MARKER_FILES = [...new Set([COPY_MARKER_FILE, ...COPY_MARKER_SPELLINGS])];

interface ManagedCopyMarker {
  schemaVersion: 1;
  source: string;
  sourceContentHash: string;
  generatedFileHash: string;
}

export interface InspectedAdapterEntry {
  kind: 'missing' | 'link' | 'copy' | 'conflict';
  message?: string;
  marker?: ManagedCopyMarker;
}

export function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function ensureAdapterDirectory(projectRoot: string, relativeDirectory: string): string {
  let current = path.resolve(projectRoot);
  for (const segment of relativeDirectory.split('/')) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current);
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${relativeDirectory}: adapter parent must be a regular directory`);
    }
  }
  return current;
}

export function expectedLinkTarget(adapterDirectory: string, sourceDirectory: string): string {
  return path.relative(adapterDirectory, sourceDirectory).split(path.sep).join('/');
}

/** The marker file a copy carries, under the current name or an earlier one. */
function markerPathOf(destination: string): string | undefined {
  return COPY_MARKER_FILES.map((name) => path.join(destination, name)).find(
    (markerPath) => existsSync(markerPath) && !lstatSync(markerPath).isSymbolicLink()
  );
}

/** Removes markers under earlier names once the current one is written. */
function dropEarlierMarkers(destination: string): void {
  for (const name of COPY_MARKER_FILES) {
    if (name !== COPY_MARKER_FILE && lstatIfPresent(path.join(destination, name))) {
      unlinkSync(path.join(destination, name));
    }
  }
}

function readMarker(destination: string): ManagedCopyMarker | undefined {
  const markerPath = markerPathOf(destination);
  if (!markerPath) return undefined;
  try {
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<ManagedCopyMarker>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.source !== 'string' ||
      typeof value.sourceContentHash !== 'string' ||
      typeof value.generatedFileHash !== 'string'
    ) {
      return undefined;
    }
    return value as ManagedCopyMarker;
  } catch {
    return undefined;
  }
}

/** Where a symbolic-link adapter entry points, or `undefined` for anything else. */
export function readLinkTarget(destination: string): string | undefined {
  const stat = lstatIfPresent(destination);
  return stat?.isSymbolicLink() ? readlinkSync(destination).split(path.sep).join('/') : undefined;
}

/** The Skill file a Dogsled-managed copy was made from, read from its marker. */
export function managedCopySource(destination: string): string | undefined {
  const stat = lstatIfPresent(destination);
  return stat?.isDirectory() ? readMarker(destination)?.source : undefined;
}

export function inspectAdapterEntry(
  destination: string,
  expectedTarget: string,
  expectedSource: string
): InspectedAdapterEntry {
  if (!existsSync(destination) && !lstatIfPresent(destination)) return { kind: 'missing' };
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(destination).split(path.sep).join('/');
    return target === expectedTarget
      ? { kind: 'link' }
      : { kind: 'conflict', message: `link points to ${target}, expected ${expectedTarget}` };
  }
  if (!stat.isDirectory()) return { kind: 'conflict', message: 'destination is not a directory' };

  const marker = readMarker(destination);
  if (!marker || marker.source !== expectedSource) {
    return { kind: 'conflict', message: 'destination is not a Dogsled-managed copy' };
  }
  const skillFile = path.join(destination, 'SKILL.md');
  if (
    !existsSync(skillFile) ||
    lstatSync(skillFile).isSymbolicLink() ||
    !lstatSync(skillFile).isFile()
  ) {
    return { kind: 'conflict', message: 'managed copy is missing its regular SKILL.md file' };
  }
  const unexpected = readdirSync(destination).filter(
    (name) => name !== 'SKILL.md' && !COPY_MARKER_FILES.includes(name)
  );
  if (unexpected.length > 0) {
    return {
      kind: 'conflict',
      message: `managed copy contains local files: ${unexpected.join(', ')}`,
    };
  }
  if (hashFile(skillFile) !== marker.generatedFileHash) {
    return { kind: 'conflict', message: 'managed copy was edited locally' };
  }
  return { kind: 'copy', marker };
}

function lstatIfPresent(filePath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function markerFor(skill: ProjectSkill, sourceFile: string): ManagedCopyMarker {
  return {
    schemaVersion: 1,
    source: skill.filePath,
    sourceContentHash: skill.contentHash,
    generatedFileHash: hashFile(sourceFile),
  };
}

export function createLink(destination: string, target: string): void {
  symlinkSync(target, destination, 'dir');
}

export function createManagedCopy(
  destination: string,
  sourceFile: string,
  skill: ProjectSkill
): void {
  mkdirSync(destination);
  writeFileSync(path.join(destination, 'SKILL.md'), readFileSync(sourceFile), { flag: 'wx' });
  writeFileSync(
    path.join(destination, COPY_MARKER_FILE),
    `${JSON.stringify(markerFor(skill, sourceFile), null, 2)}\n`,
    { flag: 'wx' }
  );
}

export function updateManagedCopy(
  destination: string,
  sourceFile: string,
  skill: ProjectSkill
): void {
  writeFileSync(path.join(destination, 'SKILL.md'), readFileSync(sourceFile));
  writeFileSync(
    path.join(destination, COPY_MARKER_FILE),
    `${JSON.stringify(markerFor(skill, sourceFile), null, 2)}\n`
  );
  dropEarlierMarkers(destination);
}

export function removeManagedLink(destination: string): void {
  unlinkSync(destination);
}

export function removeManagedCopy(destination: string): void {
  unlinkSync(path.join(destination, 'SKILL.md'));
  for (const name of COPY_MARKER_FILES) {
    if (lstatIfPresent(path.join(destination, name))) unlinkSync(path.join(destination, name));
  }
  rmdirSync(destination);
}
