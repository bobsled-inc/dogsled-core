import { CommandError } from '@bobsled-inc/protocol';

import { classifyProjectFile, visibleDeclaredTypeOf, visiblyOssie } from './classify.js';
import { isBobsledFileType, SINGLETON_PROJECT_FILE_KINDS } from './kinds.js';
import {
  compareProjectPaths,
  conventionalSkillPackageDirectory,
  conventionalProjectFileKind,
  isInConventionalObjectFolder,
  isProjectDocumentCandidate,
  markdownMayDeclareType,
  projectFileFormat,
  projectPathProblem,
  isSkillPackageResourcePath,
} from './paths.js';

import type { ProjectFileKind, SingletonProjectFileKind } from './kinds.js';
import type {
  ProjectFileClassification,
  ProjectFileInput,
  ProjectIndex,
  ProjectIndexEntry,
  ProjectIndexDeprecation,
  ProjectIndexIssue,
  ProjectIndexIssueCode,
  UnrecognizedProjectFile,
} from './types.js';

export const DEFAULT_MAX_PROJECT_FILES = 10_000;
export const DEFAULT_MAX_PROJECT_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PROJECT_TOTAL_BYTES = 64 * 1024 * 1024;

/** Leading bytes of an oversized file read to find the type it declares. */
export const DECLARED_TYPE_PROBE_BYTES = 64 * 1024;

export interface IndexProjectFilesOptions {
  /** Maximum number of YAML, JSON, and Markdown files (default 10,000). */
  readonly maxFiles?: number;
  /** Maximum size of one YAML, JSON, or Markdown file in bytes (default 1 MiB). */
  readonly maxFileBytes?: number;
  /** Maximum combined size of YAML, JSON, and Markdown files in bytes (default 64 MiB). */
  readonly maxTotalBytes?: number;
}

function sortByPath<T extends { readonly path: string }>(items: T[]): T[] {
  return items.sort((left, right) => compareProjectPaths(left.path, right.path));
}

/**
 * An issue for a file the index could not classify, carrying the type the
 * file's leading text visibly declares, so a typed Dogsled file that is too
 * large or not UTF-8 still stops the loaders that need it.
 */
export function unclassifiedFileIssue(
  path: string,
  code: ProjectIndexIssueCode,
  message: string,
  leadingText: string
): ProjectIndexIssue {
  if (visiblyOssie(path, leadingText)) return { path, code, message, kind: 'ossie' };
  const declaredType = visibleDeclaredTypeOf(path, leadingText);
  return declaredType === undefined
    ? { path, code, message }
    : { path, code, message, declaredType };
}

function duplicateConfigurationIssues(entries: readonly ProjectIndexEntry[]): ProjectIndexIssue[] {
  const byKind = new Map<ProjectFileKind, string[]>();
  const guidesByDirectory = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind === 'guide') {
      const directory = entry.path.includes('/')
        ? entry.path.slice(0, entry.path.lastIndexOf('/'))
        : '.';
      guidesByDirectory.set(directory, [...(guidesByDirectory.get(directory) ?? []), entry.path]);
    } else if (SINGLETON_PROJECT_FILE_KINDS.has(entry.kind)) {
      byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry.path]);
    }
  }
  const issues: ProjectIndexIssue[] = [];
  const conflicts: Array<readonly [string, string[]]> = [
    ...byKind.entries(),
    ...[...guidesByDirectory.values()].map((paths) => ['guide', paths] as const),
  ];
  for (const [kind, paths] of conflicts) {
    if (paths.length < 2) continue;
    for (const path of paths) {
      issues.push({
        path,
        code: 'duplicate_configuration',
        message:
          kind === 'guide'
            ? `A directory may contain one guide; found ${paths.join(', ')}.`
            : `A project may contain one ${kind} file; found ${paths.join(', ')}.`,
      });
    }
  }
  return issues;
}

/**
 * Assemble an index from per-file classifications and scan-level issues.
 * Shared by the in-memory indexer and the filesystem scanner so both apply
 * the same ordering and duplicate-configuration rules.
 */
export function buildProjectIndex(
  root: string | undefined,
  classifications: Iterable<ProjectFileClassification>,
  scanIssues: readonly ProjectIndexIssue[] = []
): ProjectIndex {
  const entries: ProjectIndexEntry[] = [];
  const deprecations: ProjectIndexDeprecation[] = [];
  const unrecognized: UnrecognizedProjectFile[] = [];
  const issues: ProjectIndexIssue[] = [...scanIssues];
  for (const classification of classifications) {
    switch (classification.status) {
      case 'recognized':
        entries.push(classification.entry);
        deprecations.push(...(classification.deprecations ?? []));
        break;
      case 'unrecognized':
        unrecognized.push(classification.file);
        break;
      case 'invalid':
        issues.push(classification.issue);
        break;
      case 'ignored':
        break;
    }
  }
  sortByPath(entries);
  issues.push(...duplicateConfigurationIssues(entries));
  return {
    root,
    entries,
    unrecognized: sortByPath(unrecognized),
    issues: sortByPath(issues),
    ...(deprecations.length > 0 ? { deprecations: sortByPath(deprecations) } : {}),
  };
}

/**
 * Index project files held in memory, for hosts that keep project content in
 * their own storage. Hidden paths and `node_modules` are skipped exactly as a
 * filesystem scan skips them. The limits apply to YAML, JSON, and Markdown files;
 * hosts bound the rest of their input themselves.
 */
export function indexProjectFiles(
  files: Iterable<ProjectFileInput>,
  options: IndexProjectFilesOptions = {}
): ProjectIndex {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_PROJECT_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_PROJECT_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_PROJECT_TOTAL_BYTES;
  const inputFiles = [...files];
  const classifications: ProjectFileClassification[] = [];
  const issues: ProjectIndexIssue[] = [];
  const seen = new Set<string>();
  const skillPackageDirectories = new Set(
    inputFiles
      .map((file) => conventionalSkillPackageDirectory(file.path))
      .filter((directory): directory is string => directory !== undefined)
  );
  let candidateCount = 0;
  let totalBytes = 0;

  for (const file of inputFiles) {
    if (seen.has(file.path)) {
      issues.push({
        path: file.path,
        code: 'invalid_path',
        message: 'The same path appears more than once.',
      });
      continue;
    }
    seen.add(file.path);
    if (!isProjectDocumentCandidate(file.path)) {
      const classification = classifyProjectFile(file);
      if (classification.status === 'invalid') issues.push(classification.issue);
      continue;
    }
    if (isSkillPackageResourcePath(file.path, skillPackageDirectories)) continue;
    candidateCount += 1;
    if (candidateCount > maxFiles) {
      issues.push({
        path: '.',
        code: 'too_many_files',
        message: `The project has more than ${maxFiles} YAML, JSON, and Markdown files.`,
      });
      break;
    }
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > maxFileBytes) {
      const leadingText = file.content.slice(0, DECLARED_TYPE_PROBE_BYTES);
      if (
        projectFileFormat(file.path) === 'markdown' &&
        !markdownMayDeclareType(file.path, leadingText)
      ) {
        classifications.push({
          status: 'unrecognized',
          file: { path: file.path, format: 'markdown' },
        });
      } else {
        issues.push(
          unclassifiedFileIssue(
            file.path,
            'file_too_large',
            `The file is ${bytes} bytes; the limit is ${maxFileBytes}.`,
            leadingText
          )
        );
      }
      continue;
    }
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) {
      issues.push({
        path: '.',
        code: 'total_size_exceeded',
        message: `The project's YAML, JSON, and Markdown files exceed ${maxTotalBytes} bytes.`,
      });
      break;
    }
    classifications.push(classifyProjectFile(file));
  }
  return buildProjectIndex(undefined, classifications, issues);
}

/** Every recognized entry of one kind, in path order. */
export function entriesOfKind(
  index: ProjectIndex,
  kind: ProjectFileKind
): readonly ProjectIndexEntry[] {
  return index.entries.filter((entry) => entry.kind === kind);
}

/**
 * The single entry of a singleton kind. A valid index never holds two; when
 * one does, the duplicate is already in `index.issues`.
 */
export function singleEntryOfKind(
  index: ProjectIndex,
  kind: SingletonProjectFileKind
): ProjectIndexEntry | undefined {
  return index.entries.find((entry) => entry.kind === kind);
}

export function formatProjectIndexIssues(issues: readonly ProjectIndexIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

/** Raised when a project contains files the index cannot classify safely. */
export class ProjectIndexError extends CommandError {
  readonly issues: readonly ProjectIndexIssue[];

  constructor(issues: readonly ProjectIndexIssue[]) {
    super(`Project files are invalid:\n${formatProjectIndexIssues(issues)}`, 2);
    this.name = 'ProjectIndexError';
    this.issues = issues;
  }
}

/** Problems that make the whole index untrustworthy, wherever they occur. */
const ALWAYS_BLOCKING_CODES: ReadonlySet<ProjectIndexIssueCode> = new Set([
  'LEGACY_KEY_CONFLICT',
  'ambiguous_source',
  'conflicting_format',
  'duplicate_configuration',
  'duplicate_identity',
  'invalid_path',
  'too_many_files',
  'too_many_entries',
  'total_size_exceeded',
]);

/** Issue codes that mean a scan stopped at a limit before it saw every file. */
const INCOMPLETE_SCAN_CODES: ReadonlySet<ProjectIndexIssueCode> = new Set([
  'too_many_files',
  'too_many_entries',
  'total_size_exceeded',
]);

/**
 * `model-spec.yml` and `extractor.yml` keys that name a folder of Dogsled objects,
 * with the camelCase aliases the extractor configuration accepts.
 */
const OBJECT_FOLDER_KEYS = [
  'entity_graph_dir',
  'integrations_dir',
  'integrationsDir',
  'mdm_dir',
  'metrics_dir',
  'models_dir',
  'relationships_dir',
  'resources_dir',
  'resourcesDir',
  'seeds_dir',
  'sources_dir',
  'targets_dir',
  'vqs_dir',
] as const;

const PROJECT_ROOT_FOLDER = '.';
const DEFAULT_RESOURCES_FOLDER = 'resources';
const PROJECT_SKILLS_FOLDER = 'skills';
const configuredFoldersByIndex = new WeakMap<ProjectIndex, readonly string[]>();

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** A configured folder as a project-relative path, `.` for the root, or `undefined`. */
function configuredFolder(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const folder = value
    .trim()
    .replace(/^(?:\.\/)+/u, '')
    .replace(/\/+$/u, '');
  if (folder === '' || folder === PROJECT_ROOT_FOLDER) return PROJECT_ROOT_FOLDER;
  return projectPathProblem(folder) === undefined ? folder : undefined;
}

/**
 * Folders the project's own Model Spec and extractor configurations name for Dogsled
 * objects. Dogsled read them strictly before type-based discovery, so a problem
 * inside one still stops loading.
 */
export function configuredObjectFolders(index: ProjectIndex): readonly string[] {
  const cached = configuredFoldersByIndex.get(index);
  if (cached) return cached;
  const folders = new Set<string>();
  for (const entry of index.entries) {
    if (entry.kind !== 'model_spec_config' && entry.kind !== 'extractor_config') continue;
    const document = recordOf(entry.document);
    if (!document) continue;
    for (const key of OBJECT_FOLDER_KEYS) {
      const folder = configuredFolder(document[key]);
      if (folder !== undefined) folders.add(folder);
    }
  }
  const result = [...folders].sort(compareProjectPaths);
  configuredFoldersByIndex.set(index, result);
  return result;
}

/**
 * The folder whose `<integration>/` subfolders own resources that declare no
 * integration: the extractor configuration's `resources_dir`, or `resources`.
 * The project root is `''`.
 */
export function configuredResourcesFolder(index: ProjectIndex): string {
  const document = recordOf(singleEntryOfKind(index, 'extractor_config')?.document);
  const folder = configuredFolder(document?.['resources_dir'] ?? document?.['resourcesDir']);
  if (folder === undefined) return DEFAULT_RESOURCES_FOLDER;
  return folder === PROJECT_ROOT_FOLDER ? '' : folder;
}

function isInConfiguredObjectFolder(index: ProjectIndex, issuePath: string): boolean {
  return configuredObjectFolders(index).some(
    (folder) =>
      folder === PROJECT_ROOT_FOLDER || issuePath === folder || issuePath.startsWith(`${folder}/`)
  );
}

function isInBobsledFolder(index: ProjectIndex, issuePath: string): boolean {
  return isInConventionalObjectFolder(issuePath) || isInConfiguredObjectFolder(index, issuePath);
}

/**
 * Whether an issue stops Dogsled loaders. Duplicate configurations, ambiguous
 * sources, duplicate identities, invalid paths, and incomplete scans always do.
 * A problem with one file stops them when the file declares a type Dogsled loads,
 * or lives in a folder Dogsled loaded objects from before type-based discovery:
 * a conventional folder, or one the project's `model-spec.yml` or `extractor.yml`
 * configures. Dogsled never follows a symbolic link. A link stops loaders where
 * Dogsled read or rejected links before: a root configuration file such as
 * `dogsled.yml`, a YAML file in one of those folders, or anything under
 * `skills/`. Problems with other files (documentation front matter, templated
 * YAML, files owned by other tools, other links) are reported but do not stop
 * loading.
 */
export function isBlockingProjectIndexIssue(
  index: ProjectIndex,
  issue: ProjectIndexIssue
): boolean {
  if (issue.kind === 'ossie') return true;
  if (ALWAYS_BLOCKING_CODES.has(issue.code)) return true;
  if (issue.kind !== undefined && isBobsledFileType(issue.kind)) return true;
  if (issue.code === 'symlink') {
    return (
      conventionalProjectFileKind(issue.path) !== undefined ||
      issue.path.split('/')[0] === PROJECT_SKILLS_FOLDER ||
      (['yaml', 'json'].includes(projectFileFormat(issue.path)) &&
        isInBobsledFolder(index, issue.path))
    );
  }
  if (issue.declaredType !== undefined && isBobsledFileType(issue.declaredType)) return true;
  return isInBobsledFolder(index, issue.path);
}

/** Throw a `ProjectIndexError` listing the issues that stop Dogsled loaders. */
export function assertValidProjectIndex(index: ProjectIndex): void {
  const blocking = index.issues.filter((issue) => isBlockingProjectIndexIssue(index, issue));
  if (blocking.length > 0) throw new ProjectIndexError(blocking);
}

/**
 * Throw a `ProjectIndexError` when the index stopped at a limit before it saw
 * every file. Readers that tolerate problems in other files still cannot trust
 * a partial index to hold every object.
 */
export function assertCompleteProjectIndex(index: ProjectIndex): void {
  const incomplete = index.issues.filter((issue) => INCOMPLETE_SCAN_CODES.has(issue.code));
  if (incomplete.length > 0) throw new ProjectIndexError(incomplete);
}
