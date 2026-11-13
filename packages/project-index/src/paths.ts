import type { ProjectFileKind } from './kinds.js';
import { ROOT_CONFIG_FILE_SPELLINGS } from './legacy-names.js';

export type ProjectFileFormat = 'yaml' | 'json' | 'markdown' | 'other';

/**
 * Untyped files Dogsled still recognizes at their historical locations. Every
 * other untyped file is left unrecognized; a file that declares a type is
 * classified by that type wherever it lives.
 */
const CONVENTIONAL_ROOT_FILES: ReadonlyMap<string, ProjectFileKind> = new Map([
  ['dogsled.yml', 'pipeline_config'],
  ['dogsled.yaml', 'pipeline_config'],
  // Every Core generation's root configuration name is read as pipeline configuration.
  ...ROOT_CONFIG_FILE_SPELLINGS.map((name): [string, ProjectFileKind] => [name, 'pipeline_config']),
  ['model-spec.yml', 'model_spec_config'],
  ['model-spec.yaml', 'model_spec_config'],
  ['extractor.yml', 'extractor_config'],
  ['extract-intents.yml', 'extract-intents'],
  ['extract-intents.yaml', 'extract-intents'],
  ['AGENTS.md', 'guide'],
]);

const CONVENTIONAL_SKILL_PATH = /^(?:[^/]+\/)*skills\/[^/]+\/SKILL\.md$/;

/** The conventional package directory for a `skills/<name>/SKILL.md` entrypoint. */
export function conventionalSkillPackageDirectory(filePath: string): string | undefined {
  if (!CONVENTIONAL_SKILL_PATH.test(filePath)) return undefined;
  return filePath.slice(0, filePath.lastIndexOf('/'));
}

/** Files below a discovered conventional Skill folder belong to its package. */
export function isSkillPackageResourcePath(
  filePath: string,
  skillPackageDirectories: ReadonlySet<string>
): boolean {
  if (projectPathProblem(filePath) !== undefined) return false;
  return [...skillPackageDirectories].some(
    (directory) => filePath.startsWith(`${directory}/`) && filePath !== `${directory}/SKILL.md`
  );
}

/**
 * Top-level folders Dogsled loaded project objects from before it discovered
 * files by type. A problem with a file inside one of them still stops loading,
 * as it did then; problems elsewhere are reported without stopping loaders.
 */
const CONVENTIONAL_OBJECT_FOLDERS: ReadonlySet<string> = new Set([
  'actions',
  'agents',
  'entity-graph',
  'integrations',
  'mdm',
  'metrics',
  'models',
  'relationships',
  'resources',
  'seeds',
  'skills',
  'sources',
  'syncs',
  'targets',
  'vqs',
]);

/** True for a conventional object folder itself or any path below it. */
export function isInConventionalObjectFolder(filePath: string): boolean {
  return filePath.split('/').some((segment) => CONVENTIONAL_OBJECT_FOLDERS.has(segment));
}

/** Directory name skipped in every scan, alongside hidden (dot-prefixed) entries. */
export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['node_modules']);

/** The root Project guide keeps its historical path and manifest hash. */
export const PROJECT_GUIDE_PATH = 'AGENTS.md';

export function projectFileFormat(filePath: string): ProjectFileFormat {
  if (/\.ya?ml$/i.test(filePath)) return 'yaml';
  if (/\.json$/i.test(filePath)) return 'json';
  if (/\.md$/i.test(filePath)) return 'markdown';
  return 'other';
}

export function conventionalProjectFileKind(filePath: string): ProjectFileKind | undefined {
  const rootKind = CONVENTIONAL_ROOT_FILES.get(filePath);
  if (rootKind) return rootKind;
  if (filePath.endsWith('/AGENTS.md')) return 'guide';
  return CONVENTIONAL_SKILL_PATH.test(filePath) ? 'skill' : undefined;
}

/**
 * A Markdown file without front matter outside every conventional path cannot
 * declare a type, so it is unrecognized whatever its size or encoding. `head`
 * is the start of the file's text.
 */
export function markdownMayDeclareType(filePath: string, head: string): boolean {
  const text = head.replace(/^\uFEFF/, '');
  return (
    conventionalProjectFileKind(filePath) !== undefined ||
    text.startsWith('---\n') ||
    text.startsWith('---\r\n')
  );
}

export function isIgnoredPathSegment(segment: string): boolean {
  return segment.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(segment);
}

/**
 * Files below a hidden directory, a hidden file, or anything under
 * `node_modules` are never project files. Filesystem scans do not descend into
 * them, and in-memory indexes skip them the same way.
 */
export function isIgnoredProjectPath(filePath: string): boolean {
  return filePath.split('/').some(isIgnoredPathSegment);
}

/**
 * Validate a project-relative POSIX path. Returns a reason when the path is
 * absolute, uses backslashes, or contains empty, `.`, or `..` segments.
 */
export function projectPathProblem(filePath: string): string | undefined {
  if (filePath.length === 0) return 'path must not be empty';
  if (filePath.includes('\0')) return 'path must not contain NUL bytes';
  if (filePath.includes('\\')) return 'path must use forward slashes';
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return 'path must be relative';
  const segments = filePath.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return 'path must not contain empty segments';
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'path must not contain "." or ".." segments';
  }
  return undefined;
}

/** True for a valid, non-ignored YAML, JSON, or Markdown path: the files the index reads. */
export function isProjectDocumentCandidate(filePath: string): boolean {
  return (
    projectFileFormat(filePath) !== 'other' &&
    projectPathProblem(filePath) === undefined &&
    !isIgnoredProjectPath(filePath)
  );
}

/** Code-unit ordering, so every host sorts project paths identically. */
export function compareProjectPaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
