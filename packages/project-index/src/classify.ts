import {
  LegacyBlueprintKeyConflictError,
  normalizeLegacyBlueprintKeys,
  type LegacyBlueprintDeprecation,
} from '@bobsled-inc/protocol';

import { LineCounter, parse as parseYaml, YAMLError } from 'yaml';

import { normalizeDocumentText, splitFrontMatter } from './front-matter.js';
import {
  MARKDOWN_PROJECT_FILE_TYPES,
  resolveMarkdownType,
  resolveYamlType,
  YAML_PROJECT_FILE_TYPES,
} from './kinds.js';
import {
  conventionalProjectFileKind,
  isIgnoredProjectPath,
  projectFileFormat,
  projectPathProblem,
} from './paths.js';

import type { ProjectFileKind } from './kinds.js';
import type {
  ProjectFileClassification,
  ProjectFileInput,
  ProjectIndexIssueCode,
} from './types.js';

type DeclaredType =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'present'; readonly value: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaredTypeOf(document: unknown): DeclaredType {
  if (!isRecord(document) || !Object.hasOwn(document, 'type')) return { status: 'absent' };
  const value = document['type'];
  return typeof value === 'string' && value.trim().length > 0
    ? { status: 'present', value }
    : { status: 'invalid' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse YAML without the library's code frame: a frame quotes the source line,
 * which can hold a secret. The message keeps the reason and its position.
 */
function parseYamlDocument(
  text: string
): { ok: true; value: unknown } | { ok: false; message: string } {
  const lineCounter = new LineCounter();
  try {
    return {
      ok: true,
      value: parseYaml(text, { uniqueKeys: true, prettyErrors: false, lineCounter }),
    };
  } catch (error) {
    const position = error instanceof YAMLError ? error.pos[0] : -1;
    if (position < 0) return { ok: false, message: errorMessage(error) };
    const { line, col } = lineCounter.linePos(position);
    return { ok: false, message: `${errorMessage(error)} at line ${line}, column ${col}` };
  }
}

/** The value of a top-level `type:` line, read from text that does not parse. */
function visibleDeclaredType(text: string): string | undefined {
  return /^(?:type|"type"|'type'):[ \t]*["']?([\w-]+)["']?[ \t]*(?:#.*)?$/mu.exec(text)?.[1];
}

/**
 * The type a file's leading text visibly declares, in YAML or in Markdown
 * front matter, for a file too large or malformed to classify. The text may
 * stop partway through the file.
 */
export function visibleDeclaredTypeOf(filePath: string, leadingText: string): string | undefined {
  const text = normalizeDocumentText(leadingText);
  if (projectFileFormat(filePath) !== 'markdown') return visibleDeclaredType(text);
  const split = splitFrontMatter(text);
  if (split) return visibleDeclaredType(split.frontMatter);
  return text.startsWith('---\n') ? visibleDeclaredType(text.slice(4)) : undefined;
}

function invalid(
  path: string,
  code: ProjectIndexIssueCode,
  message: string,
  declaredType?: string,
  kind?: ProjectFileKind
): ProjectFileClassification {
  return {
    status: 'invalid',
    issue: {
      path,
      code,
      message,
      ...(declaredType === undefined ? {} : { declaredType }),
      ...(kind === undefined ? {} : { kind }),
    },
  };
}

function recognized(
  file: ProjectFileInput,
  kind: ProjectFileKind,
  declaredType: string | undefined,
  format: 'yaml' | 'json' | 'markdown',
  document: unknown
): ProjectFileClassification {
  let deprecations: readonly LegacyBlueprintDeprecation[] = [];
  if (kind === 'integration' || kind === 'source' || kind === 'pipeline_config') {
    try {
      const normalized = normalizeLegacyBlueprintKeys(document, { path: file.path, kind });
      document = normalized.document;
      deprecations = normalized.deprecations;
    } catch (error) {
      if (!(error instanceof LegacyBlueprintKeyConflictError)) throw error;
      return invalid(file.path, error.code, error.message, declaredType, kind);
    }
  }
  return {
    status: 'recognized',
    entry: { path: file.path, kind, declaredType, format, content: file.content, document },
    ...(deprecations.length > 0 ? { deprecations } : {}),
  };
}

/** Add the inferred type only to the parsed document passed to the loader. */
function withEffectiveType(document: unknown, kind: ProjectFileKind): unknown {
  return isRecord(document) && !Object.hasOwn(document, 'type')
    ? { ...document, type: kind }
    : document;
}

function unrecognized(file: ProjectFileInput): ProjectFileClassification {
  return {
    status: 'unrecognized',
    file: { path: file.path, format: projectFileFormat(file.path) },
  };
}

/** Candidate detection only; the owning loader validates the Ossie schema. */
function isOssieCandidate(document: unknown): boolean {
  if (!isRecord(document)) return false;
  return (
    Object.hasOwn(document, 'datasets') ||
    Object.hasOwn(document, 'semantic_model') ||
    (typeof document['version'] === 'string' && /^0\.2\.0\.dev\d+$/u.test(document['version']))
  );
}

/** Conservative root-key cues for files that cannot be parsed or fully read. */
export function visiblyOssie(filePath: string, leadingText: string): boolean {
  const text = normalizeDocumentText(leadingText);
  if (projectFileFormat(filePath) === 'json' || text.trimStart().startsWith('{')) {
    let depth = 0;
    const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]]/gu;
    for (const match of text.matchAll(tokens)) {
      const token = match[0];
      if (token === '{' || token === '[') depth += 1;
      else if (token === '}' || token === ']') depth -= 1;
      else if (depth === 1 && /^\s*:/u.test(text.slice(match.index + token.length))) {
        if (token === '"datasets"' || token === '"semantic_model"') return true;
        if (
          token === '"version"' &&
          /^\s*:\s*"0\.2\.0\.dev\d+(?:"|$)/u.test(text.slice(match.index + token.length))
        ) {
          return true;
        }
      }
    }
    return false;
  }
  return (
    /^(?:datasets|semantic_model|"datasets"|"semantic_model"|'datasets'|'semantic_model'):[ \t]*/mu.test(
      text
    ) || /^version:[ \t]*["']?0\.2\.0\.dev\d+["']?[ \t]*(?:#.*)?$/mu.test(text)
  );
}

function classifyYaml(file: ProjectFileInput): ProjectFileClassification {
  const format = projectFileFormat(file.path) === 'json' ? 'json' : 'yaml';
  const conventional = conventionalProjectFileKind(file.path);
  const parsed = parseYamlDocument(file.content);
  if (!parsed.ok) {
    if (visiblyOssie(file.path, file.content)) {
      if (visibleDeclaredType(file.content) !== undefined) {
        return invalid(
          file.path,
          'conflicting_format',
          'The document contains both Ossie and Dogsled format markers.'
        );
      }
      return recognized(file, 'ossie', undefined, format, undefined);
    }
    if (format === 'json') return unrecognized(file);
    // Historical root configs keep their kind so their existing loader can
    // report its established YAML diagnostics. Inferred object files have no
    // separate path-based loader, so surface malformed YAML at the real path.
    if (conventional) return recognized(file, conventional, undefined, 'yaml', undefined);
    const inferred = inferredYamlKind(file.path);
    if (inferred) {
      return invalid(
        file.path,
        'invalid_yaml',
        `Invalid YAML: ${parsed.message}`,
        undefined,
        inferred
      );
    }
    return invalid(
      file.path,
      'invalid_yaml',
      `Invalid YAML: ${parsed.message}`,
      visibleDeclaredType(file.content)
    );
  }
  const document = parsed.value;

  if (isOssieCandidate(document)) {
    if (
      isRecord(document) &&
      (Object.hasOwn(document, 'type') || Object.hasOwn(document, 'spec_version'))
    ) {
      return invalid(
        file.path,
        'conflicting_format',
        'The document contains both Ossie and Dogsled format markers.'
      );
    }
    if (format === 'json') {
      try {
        JSON.parse(normalizeDocumentText(file.content));
      } catch {
        return recognized(file, 'ossie', undefined, format, undefined);
      }
    }
    return recognized(file, 'ossie', undefined, format, document);
  }
  if (format === 'json') return unrecognized(file);
  const declared = declaredTypeOf(document);
  if (declared.status === 'invalid') {
    return invalid(file.path, 'invalid_type', 'The top-level type must be a non-empty string.');
  }
  if (declared.status === 'absent') {
    const inferred = conventional ?? inferredYamlKind(file.path);
    if (inferred) {
      return recognized(file, inferred, undefined, 'yaml', withEffectiveType(document, inferred));
    }
    if (
      isRecord(document) &&
      [
        'pipelines',
        'destinations',
        'defaults',
        'state',
        'runner',
        'agent',
        'console',
        'models',
        'platform',
      ].some((key) => Object.hasOwn(document, key)) &&
      !conventional
    ) {
      return invalid(
        file.path,
        'invalid_type',
        'A nonroot pipeline config must declare type: pipeline_config.',
        undefined,
        'pipeline_config'
      );
    }
    return unrecognized(file);
  }

  const resolution = resolveYamlType(declared.value, document as Record<string, unknown>);
  if (resolution.status === 'ambiguous_source') {
    return invalid(
      file.path,
      'ambiguous_source',
      'type: source is ambiguous. Set spec_version to "0.2" for a model source or "2" for an integration, or use type: integration.'
    );
  }
  if (resolution.status === 'unknown') {
    return invalid(
      file.path,
      'unknown_type',
      `Unknown type "${declared.value}". Known YAML types: ${YAML_PROJECT_FILE_TYPES.join(', ')}.`,
      declared.value
    );
  }
  return recognized(file, resolution.kind, declared.value, 'yaml', document);
}

const CONVENTIONAL_YAML_FOLDERS: ReadonlyMap<string, ProjectFileKind> = new Map([
  ['sources', 'source'],
  ['models', 'model'],
  ['integrations', 'integration'],
  ['resources', 'resource'],
  ['actions', 'action'],
  ['targets', 'target'],
  ['syncs', 'sync'],
  ['metrics', 'metric'],
  ['relationships', 'relationship'],
  ['vqs', 'vq'],
  ['agents', 'agent'],
  ['seeds', 'seed'],
]);

/** Nearest exact conventional ancestor supplies only a file kind, never identity. */
function inferredYamlKind(filePath: string): ProjectFileKind | undefined {
  const folders = filePath.split('/').slice(0, -1);
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const kind = CONVENTIONAL_YAML_FOLDERS.get(folders[index] ?? '');
    if (kind) return kind;
  }
  return undefined;
}

function classifyMarkdown(file: ProjectFileInput): ProjectFileClassification {
  const conventional = conventionalProjectFileKind(file.path);
  const split = splitFrontMatter(normalizeDocumentText(file.content));
  if (!split) {
    return conventional
      ? recognized(file, conventional, undefined, 'markdown', undefined)
      : unrecognized(file);
  }

  const parsed = parseYamlDocument(split.frontMatter);
  if (!parsed.ok) {
    if (conventional) return recognized(file, conventional, undefined, 'markdown', undefined);
    return invalid(
      file.path,
      'invalid_front_matter',
      `Invalid YAML front matter: ${parsed.message}`,
      visibleDeclaredType(split.frontMatter)
    );
  }
  const frontMatter = parsed.value;

  const declared = declaredTypeOf(frontMatter);
  if (declared.status === 'invalid') {
    return invalid(file.path, 'invalid_type', 'The front matter type must be a non-empty string.');
  }
  if (declared.status === 'absent') {
    return conventional
      ? recognized(
          file,
          conventional,
          undefined,
          'markdown',
          withEffectiveType(frontMatter, conventional)
        )
      : unrecognized(file);
  }

  const kind = resolveMarkdownType(declared.value);
  if (!kind) {
    return invalid(
      file.path,
      'unknown_type',
      `Unknown front matter type "${declared.value}". Known Markdown types: ${MARKDOWN_PROJECT_FILE_TYPES.join(', ')}.`,
      declared.value
    );
  }
  return recognized(file, kind, declared.value, 'markdown', frontMatter);
}

/**
 * Classify one project file by its declared type, falling back to its
 * conventional location when it declares none. Pure: no filesystem access.
 */
export function classifyProjectFile(file: ProjectFileInput): ProjectFileClassification {
  const problem = projectPathProblem(file.path);
  if (problem) return invalid(file.path, 'invalid_path', `Invalid project path: ${problem}.`);
  if (isIgnoredProjectPath(file.path)) return { status: 'ignored', path: file.path };

  switch (projectFileFormat(file.path)) {
    case 'json':
    case 'yaml':
      return classifyYaml(file);
    case 'markdown':
      return classifyMarkdown(file);
    default:
      return unrecognized(file);
  }
}
