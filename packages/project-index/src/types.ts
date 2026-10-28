import type { LegacyBlueprintDeprecation } from '@bobsled-inc/protocol';

import type { ProjectFileKind } from './kinds.js';
import type { ProjectFileFormat } from './paths.js';

export type ProjectIndexDeprecation = LegacyBlueprintDeprecation;

/** A project file handed to the in-memory indexer. */
export interface ProjectFileInput {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** A file the index recognized as a project object or configuration. */
export interface ProjectIndexEntry {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly kind: ProjectFileKind;
  /** The literal `type` value, or `undefined` for an untyped file at a conventional path. */
  readonly declaredType: string | undefined;
  readonly format: Exclude<ProjectFileFormat, 'other'>;
  readonly content: string;
  /**
   * Parsed YAML document, or parsed Markdown front matter. An inferred `type`
   * is added here for the owning loader without changing `content` or
   * `declaredType`. `undefined` when a conventional file has no front matter or
   * does not parse; the kind's loader reports that from `content`.
   */
  readonly document: unknown;
}

/** A YAML, JSON, or Markdown file with no declared type outside every conventional path. */
export interface UnrecognizedProjectFile {
  readonly path: string;
  readonly format: ProjectFileFormat;
}

export const PROJECT_INDEX_ISSUE_CODES = [
  'LEGACY_KEY_CONFLICT',
  'invalid_path',
  'invalid_encoding',
  'invalid_yaml',
  'conflicting_format',
  'invalid_front_matter',
  'invalid_type',
  'unknown_type',
  'ambiguous_source',
  'duplicate_configuration',
  'duplicate_identity',
  'file_too_large',
  'symlink',
  'unreadable',
  'too_deep',
  'too_many_files',
  'too_many_entries',
  'total_size_exceeded',
] as const;

export type ProjectIndexIssueCode = (typeof PROJECT_INDEX_ISSUE_CODES)[number];

export interface ProjectIndexIssue {
  /** Project-relative POSIX path the issue belongs to (`.` for the project root). */
  readonly path: string;
  readonly code: ProjectIndexIssueCode;
  readonly message: string;
  /**
   * The `type` a file that could not be classified declares, when it can be
   * read: the unknown value, or the top-level `type:` line of malformed YAML.
   */
  readonly declaredType?: string;
  /** Content-based kind when there is no authored type marker. */
  readonly kind?: ProjectFileKind;
}

export interface ProjectIndex {
  readonly deprecations?: readonly ProjectIndexDeprecation[];
  /** Absolute project root when the index came from a filesystem scan. */
  readonly root: string | undefined;
  /** Recognized files, sorted by path. */
  readonly entries: readonly ProjectIndexEntry[];
  /** Untyped YAML, JSON, and Markdown files outside conventional paths, sorted by path. */
  readonly unrecognized: readonly UnrecognizedProjectFile[];
  /** Problems found while indexing, sorted by path. */
  readonly issues: readonly ProjectIndexIssue[];
}

export type ProjectFileClassification =
  | {
      readonly status: 'recognized';
      readonly entry: ProjectIndexEntry;
      readonly deprecations?: readonly ProjectIndexDeprecation[];
    }
  | { readonly status: 'unrecognized'; readonly file: UnrecognizedProjectFile }
  | { readonly status: 'ignored'; readonly path: string }
  | { readonly status: 'invalid'; readonly issue: ProjectIndexIssue };
