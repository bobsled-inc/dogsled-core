import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { classifyProjectFile } from './classify.js';
import {
  compareProjectPaths,
  conventionalProjectFileKind,
  isIgnoredPathSegment,
  isSkillPackageResourcePath,
  markdownMayDeclareType,
  projectFileFormat,
} from './paths.js';
import {
  assertCompleteProjectIndex,
  assertValidProjectIndex,
  buildProjectIndex,
  DECLARED_TYPE_PROBE_BYTES,
  DEFAULT_MAX_PROJECT_FILE_BYTES,
  DEFAULT_MAX_PROJECT_FILES,
  DEFAULT_MAX_PROJECT_TOTAL_BYTES,
  entriesOfKind,
  ProjectIndexError,
  unclassifiedFileIssue,
  type IndexProjectFilesOptions,
} from './project-index.js';

import type { SingletonProjectFileKind } from './kinds.js';
import type {
  ProjectFileClassification,
  ProjectIndex,
  ProjectIndexEntry,
  ProjectIndexIssue,
  ProjectIndexIssueCode,
} from './types.js';

export const DEFAULT_MAX_PROJECT_DEPTH = 32;
export const DEFAULT_MAX_PROJECT_ENTRIES = 250_000;

export interface ScanProjectOptions extends IndexProjectFilesOptions {
  /** Maximum directory nesting below the project root (default 32). */
  readonly maxDepth?: number;
  /** Maximum directory entries visited, of any file type (default 250,000). */
  readonly maxEntries?: number;
}

type EntryType = 'file' | 'directory' | 'symlink' | 'other';

type CandidateRead =
  | { readonly status: 'content'; readonly content: string }
  | { readonly status: 'unrecognized_markdown' }
  | { readonly status: 'ignored' }
  | {
      readonly status: 'issue';
      readonly code: ProjectIndexIssueCode;
      readonly message: string;
      /** Text the file starts with, read to find the type it declares. */
      readonly leadingText?: string;
    };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const SYMLINK_MESSAGE = 'Dogsled does not follow symbolic links.';
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryType(dirent: Dirent, absolutePath: string): EntryType {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  // Filesystems that do not report entry types need an explicit lstat.
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return stat.isFile() ? 'file' : 'other';
}

function readBytes(descriptor: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(descriptor, buffer, offset, length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset);
}

class ProjectScanner {
  readonly classifications: ProjectFileClassification[] = [];
  readonly issues: ProjectIndexIssue[] = [];
  private readonly skillPackageDirectories = new Set<string>();
  private entries = 0;
  private candidates = 0;
  private totalBytes = 0;
  private stopped = false;

  constructor(
    private readonly maxDepth: number,
    private readonly maxEntries: number,
    private readonly maxFiles: number,
    private readonly maxFileBytes: number,
    private readonly maxTotalBytes: number
  ) {}

  private issue(relativePath: string, code: ProjectIndexIssueCode, message: string): void {
    this.issues.push({ path: relativePath, code, message });
  }

  private stop(code: ProjectIndexIssueCode, message: string): void {
    this.issue('.', code, message);
    this.stopped = true;
  }

  walkRoot(root: string): void {
    this.visitDirectory(root, '', 0, readdirSync(root, { withFileTypes: true }));
  }

  private walk(directory: string, relativeDirectory: string, depth: number): void {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      this.issue(relativeDirectory, 'unreadable', `Cannot read directory: ${errorMessage(error)}`);
      return;
    }
    this.visitDirectory(directory, relativeDirectory, depth, dirents);
  }

  private visitDirectory(
    directory: string,
    relativeDirectory: string,
    depth: number,
    dirents: Dirent[]
  ): void {
    dirents.sort((left, right) => compareProjectPaths(left.name, right.name));
    if (
      /^skills\/[^/]+$/u.test(relativeDirectory) &&
      dirents.some((entry) => entry.name === 'SKILL.md')
    ) {
      this.skillPackageDirectories.add(relativeDirectory);
    }

    for (const dirent of dirents) {
      if (this.stopped) return;
      this.entries += 1;
      if (this.entries > this.maxEntries) {
        this.stop(
          'too_many_entries',
          `The project has more than ${this.maxEntries} directory entries.`
        );
        return;
      }
      if (isIgnoredPathSegment(dirent.name)) continue;

      const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      const absolutePath = path.join(directory, dirent.name);
      const type = entryType(dirent, absolutePath);
      if (type === 'symlink') {
        // Root-level Markdown links are agent instruction aliases (CLAUDE.md,
        // GEMINI.md → AGENTS.md). They never hold project objects, so they are
        // skipped; every other link is reported rather than followed.
        if (depth === 0 && projectFileFormat(relativePath) === 'markdown') continue;
        this.issue(relativePath, 'symlink', SYMLINK_MESSAGE);
      } else if (type === 'directory') {
        if (depth + 1 > this.maxDepth) {
          this.issue(
            relativePath,
            'too_deep',
            `Directories may be nested at most ${this.maxDepth} levels deep.`
          );
        } else {
          this.walk(absolutePath, relativePath, depth + 1);
        }
      } else if (
        type === 'file' &&
        projectFileFormat(relativePath) !== 'other' &&
        !isSkillPackageResourcePath(relativePath, this.skillPackageDirectories)
      ) {
        this.visitCandidate(absolutePath, relativePath);
      }
    }
  }

  private visitCandidate(absolutePath: string, relativePath: string): void {
    this.candidates += 1;
    if (this.candidates > this.maxFiles) {
      this.stop(
        'too_many_files',
        `The project has more than ${this.maxFiles} YAML, JSON, and Markdown files.`
      );
      return;
    }
    const read = this.readCandidate(absolutePath, relativePath);
    if (read.status === 'issue') {
      this.issues.push(
        unclassifiedFileIssue(relativePath, read.code, read.message, read.leadingText ?? '')
      );
    } else if (read.status === 'unrecognized_markdown') {
      this.classifications.push({
        status: 'unrecognized',
        file: { path: relativePath, format: 'markdown' },
      });
    } else if (read.status === 'content') {
      this.classifications.push(classifyProjectFile({ path: relativePath, content: read.content }));
    }
  }

  private readCandidate(absolutePath: string, relativePath: string): CandidateRead {
    const markdown = projectFileFormat(relativePath) === 'markdown';
    let descriptor: number;
    try {
      descriptor = openSync(absolutePath, OPEN_FLAGS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        return { status: 'issue', code: 'symlink', message: SYMLINK_MESSAGE };
      }
      return {
        status: 'issue',
        code: 'unreadable',
        message: `Cannot read file: ${errorMessage(error)}`,
      };
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) return { status: 'ignored' };
      if (stat.size > this.maxFileBytes) {
        const leadingText = readBytes(descriptor, DECLARED_TYPE_PROBE_BYTES).toString('utf8');
        if (markdown && !markdownMayDeclareType(relativePath, leadingText)) {
          return { status: 'unrecognized_markdown' };
        }
        return {
          status: 'issue',
          code: 'file_too_large',
          message: `The file is ${stat.size} bytes; the limit is ${this.maxFileBytes}.`,
          leadingText,
        };
      }
      this.totalBytes += stat.size;
      if (this.totalBytes > this.maxTotalBytes) {
        this.stop(
          'total_size_exceeded',
          `The project's YAML, JSON, and Markdown files exceed ${this.maxTotalBytes} bytes.`
        );
        return { status: 'ignored' };
      }
      const bytes = readBytes(descriptor, stat.size);
      try {
        return { status: 'content', content: utf8Decoder.decode(bytes) };
      } catch {
        const leadingText = bytes.toString('utf8');
        if (markdown && !markdownMayDeclareType(relativePath, leadingText)) {
          return { status: 'unrecognized_markdown' };
        }
        return {
          status: 'issue',
          code: 'invalid_encoding',
          message: 'The file must contain valid UTF-8.',
          leadingText,
        };
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

/**
 * Scan a project directory once and index every YAML, JSON, and Markdown file by its
 * declared type. The walk is sorted, skips hidden entries and `node_modules`,
 * reports symbolic links instead of following them, and stops at the
 * configured depth, entry, file, and byte limits.
 *
 * A root that cannot be listed (missing, not a directory, unreadable) throws
 * the native filesystem error; problems below the root become index issues.
 */
export function scanProject(root: string, options: ScanProjectOptions = {}): ProjectIndex {
  const absoluteRoot = path.resolve(root);
  const scanner = new ProjectScanner(
    options.maxDepth ?? DEFAULT_MAX_PROJECT_DEPTH,
    options.maxEntries ?? DEFAULT_MAX_PROJECT_ENTRIES,
    options.maxFiles ?? DEFAULT_MAX_PROJECT_FILES,
    options.maxFileBytes ?? DEFAULT_MAX_PROJECT_FILE_BYTES,
    options.maxTotalBytes ?? DEFAULT_MAX_PROJECT_TOTAL_BYTES
  );
  scanner.walkRoot(absoluteRoot);
  return buildProjectIndex(absoluteRoot, scanner.classifications, scanner.issues);
}

/**
 * The index a loader should use for `root`: the caller's prebuilt index when
 * given (so one scan serves every loader), otherwise a fresh scan. Either way
 * the index must be free of blocking issues (see `isBlockingProjectIndexIssue`).
 */
export function resolveProjectIndex(root: string, index?: ProjectIndex): ProjectIndex {
  const resolved = index ?? scanProject(root);
  assertValidProjectIndex(resolved);
  return resolved;
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * The entry of a project-wide configuration kind, for readers that need only
 * that one file. Unlike `resolveProjectIndex`, problems in other files are
 * left to the project loaders, and a project root that does not exist has no
 * configuration. A scan that stopped at a limit, two files of `kind`, or a
 * problem with the configuration file itself (its conventional root file, or
 * a file that declares `kind`) still raise an error.
 */
export function findConfigurationEntry(
  root: string,
  kind: SingletonProjectFileKind,
  index?: ProjectIndex
): ProjectIndexEntry | undefined {
  if (index === undefined && !isDirectory(root)) return undefined;
  const resolved = index ?? scanProject(root);
  assertCompleteProjectIndex(resolved);
  const unreadable = resolved.issues.filter(
    (issue) =>
      issue.code !== 'duplicate_configuration' &&
      (conventionalProjectFileKind(issue.path) === kind || issue.declaredType === kind)
  );
  if (unreadable.length > 0) throw new ProjectIndexError(unreadable);
  const entries = entriesOfKind(resolved, kind);
  if (entries.length > 1) {
    const paths = new Set(entries.map((entry) => entry.path));
    throw new ProjectIndexError(
      resolved.issues.filter(
        (issue) => issue.code === 'duplicate_configuration' && paths.has(issue.path)
      )
    );
  }
  return entries[0];
}
