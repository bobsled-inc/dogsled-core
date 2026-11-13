import {
  declareHostConfigEnvironment,
  declareOwnModelApiKeys,
  parseHostDeclaredEnvNames,
  undeclaredCredentialWarnings,
} from './host-environment.js';
import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import {
  entriesOfKind,
  ProjectIndexError,
  type ProjectIndex,
  type ProjectIndexEntry,
} from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';
import { LineCounter, parse as parseYaml, YAMLError } from 'yaml';

import {
  validateDogsledConfig,
  type ResolvedEntityGraphPipeline,
  type ResolvedModelPipeline,
  type ResolvedPipeline,
  type SecretRequirement,
  type ValidationIssue,
} from './loader.js';
import { openDogsledProject } from './project-files.js';
import { normalizePipelineBlueprint } from './legacy-blueprint.js';
import { enrichForEachParents } from './resolve-for-each.js';
import {
  isExtractPipelineConfig,
  DogsledConfigFragmentSchema,
  DogsledConfigSchema,
} from './schema.js';
import type { DogsledConfig } from './schema.js';
import { BUILT_IN_VALIDATION_CATALOG, type ValidationCatalog } from '../../validation.js';
import { ROOT_CONFIG_FILE_SPELLINGS } from '../legacy-names.js';

export interface LoadProjectPipelineConfigOptions {
  projectRoot: string;
  /**
   * Environment variable names an embedding host declares it serves for this
   * Project, for example its own secret names. Validation treats them as
   * declared for pipeline embeddings and `platform.models` profiles in
   * addition to authored `auth_env_vars`. Declarations never read or grant
   * access to process environment values. Omit for default fail-closed
   * behavior; CLI commands never set it.
   */
  declaredEnvNames?: readonly string[];
  /**
   * Set to `true` only when this host runs every `platform.models` profile with
   * its own executor and signs in to the model provider itself, so a profile's
   * `api_key` is never read. Each profile's own `api_key` name then counts as
   * declared. Placeholders stay unchanged and no value is read. Pipeline
   * embeddings, integrations, actions, and destinations keep their declaration
   * rules. Defaults to `false`; CLI commands never set it.
   */
  hostManagedModelAuth?: boolean;
  /** Reuse the caller's complete ProjectIndex. */
  index?: ProjectIndex;
  /** Explicit single-file mode; relative to projectRoot. */
  configPath?: string;
  /** Reject historical aliases in every fragment when requested by a host. */
}

export interface LoadedProjectPipelineConfig {
  config: DogsledConfig;
  configPaths: readonly string[];
  pipelinePathByName: ReadonlyMap<string, string>;
  destinationPathByName: ReadonlyMap<string, string>;
  sectionPathByName: ReadonlyMap<string, string>;
}

export interface ResolveProjectPipelinesOptions extends LoadProjectPipelineConfigOptions {
  /** Override the built-in metadata-only integration validation catalog. */
  validationCatalog?: ValidationCatalog;
}

export interface ResolvedProjectPipelines extends LoadedProjectPipelineConfig {
  projectRoot: string;
  /** Type index the project was validated from. */
  index: ProjectIndex;
  extractPipelines: ResolvedPipeline[];
  modelPipelines: ResolvedModelPipeline[];
  entityGraphPipelines: ResolvedEntityGraphPipeline[];
  secrets: SecretRequirement[];
  warnings: string[];
}

export interface StructuredProjectPipelineIssue extends ValidationIssue {
  filePath: string;
  fieldPath?: string;
  relatedFilePaths?: string[];
}

export type ProjectPipelineValidationResult =
  | { status: 'valid'; project: ResolvedProjectPipelines; warnings: string[]; issues: [] }
  | { status: 'invalid'; warnings: string[]; issues: StructuredProjectPipelineIssue[] };

class ProjectPipelineIssuesError extends CommandError {
  constructor(readonly issues: StructuredProjectPipelineIssue[]) {
    super(issues.map(formatIssue).join('\n'), 2);
    this.name = 'ProjectPipelineIssuesError';
  }
}

class ExplicitConfigPathError extends CommandError {
  constructor(
    message: string,
    readonly filePath: string
  ) {
    super(message, 2);
    this.name = 'ExplicitConfigPathError';
  }
}

function makeIssue(
  filePath: string,
  fieldPath: string | undefined,
  message: string,
  relatedFilePaths?: string[]
): StructuredProjectPipelineIssue {
  return {
    path: `${filePath}${fieldPath ? `:${fieldPath}` : ''}`,
    message,
    filePath,
    ...(fieldPath ? { fieldPath } : {}),
    ...(relatedFilePaths ? { relatedFilePaths } : {}),
  };
}

function formatIssue(issue: ValidationIssue): string {
  return `${issue.path}: ${issue.message}`;
}

export class DogsledProjectValidationError extends CommandError {
  readonly issues: StructuredProjectPipelineIssue[];
  readonly warnings: string[];

  constructor(issues: StructuredProjectPipelineIssue[], warnings: string[] = []) {
    super(issues.map(formatIssue).join('\n'), 2);
    this.name = 'DogsledProjectValidationError';
    this.issues = issues;
    this.warnings = warnings;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds credential declarations to one parsed config fragment before schema parsing. */
type DeclareFragment = (fragment: Record<string, unknown>) => Record<string, unknown>;

function hostDeclarations(
  declaredEnvNames: readonly string[],
  hostManagedModelAuth: boolean
): DeclareFragment {
  return (fragment) =>
    declareHostConfigEnvironment(fragment, declaredEnvNames, hostManagedModelAuth);
}

function safeParseYaml(raw: string): unknown {
  const lineCounter = new LineCounter();
  try {
    return parseYaml(raw, { uniqueKeys: true, prettyErrors: false, lineCounter });
  } catch (error) {
    const position = error instanceof YAMLError ? error.pos[0] : -1;
    if (position < 0) throw error;
    const { line, col } = lineCounter.linePos(position);
    const reason =
      error instanceof Error
        ? error.message.replace(/ at line \d+, column \d+$/u, '')
        : String(error);
    throw new Error(`${reason} at line ${line}, column ${col}`);
  }
}

function rootConfigPath(pathname: string): boolean {
  return (
    pathname === 'dogsled.yml' ||
    pathname === 'dogsled.yaml' ||
    ROOT_CONFIG_FILE_SPELLINGS.includes(pathname)
  );
}

function relativeConfigPath(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === '..') {
    throw new ExplicitConfigPathError('configPath must live inside projectRoot.', '.');
  }
  return relative.split(path.sep).join('/');
}

function resolveExplicitPath(projectRoot: string, configPath: string): string {
  const absolutePath = path.resolve(projectRoot, configPath);
  const relativePath = relativeConfigPath(projectRoot, absolutePath);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(projectRoot);
    realFile = realpathSync(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    throw new ExplicitConfigPathError(
      `Could not resolve explicit pipeline config ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      relativePath
    );
  }
  const realRelative = path.relative(realRoot, realFile);
  if (
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative) ||
    realRelative === '..'
  ) {
    throw new ExplicitConfigPathError('configPath must live inside projectRoot.', relativePath);
  }
  return absolutePath;
}

function mapsForConfig(config: DogsledConfig, pathname: string): LoadedProjectPipelineConfig {
  const pipelinePathByName = new Map(Object.keys(config.pipelines).map((name) => [name, pathname]));
  const destinationPathByName = new Map(
    Object.keys(config.destinations).map((name) => [name, pathname])
  );
  const sectionPathByName = new Map<string, string>();
  for (const section of ['defaults', 'state', 'runner', 'agent', 'console', 'models', 'platform']) {
    if (Object.hasOwn(config, section)) sectionPathByName.set(section, pathname);
  }
  return {
    config,
    configPaths: [pathname],
    pipelinePathByName,
    destinationPathByName,
    sectionPathByName,
  };
}

function loadExplicitConfig(
  projectRoot: string,
  configPath: string,
  index: ProjectIndex,
  declare: DeclareFragment
): LoadedProjectPipelineConfig {
  const absolutePath = resolveExplicitPath(projectRoot, configPath);
  const pathname = relativeConfigPath(projectRoot, absolutePath);
  const indexed = index.entries.find(
    (entry) => entry.path === pathname && entry.kind === 'pipeline_config'
  );
  const raw = indexed?.content ?? readFileSync(absolutePath, 'utf8');
  let document: unknown;
  try {
    document = normalizePipelineBlueprint(safeParseYaml(raw), pathname);
  } catch (error) {
    throw new ProjectPipelineIssuesError([
      makeIssue(
        pathname,
        undefined,
        error instanceof CommandError
          ? error.message
          : `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`
      ),
    ]);
  }
  if (!isRecord(document)) {
    throw new ProjectPipelineIssuesError([
      makeIssue(pathname, undefined, 'pipeline config must be a YAML mapping.'),
    ]);
  }
  const type = document['type'];
  if (type !== undefined && type !== 'pipeline_config') {
    throw new ProjectPipelineIssuesError([
      makeIssue(pathname, 'type', `expected type: pipeline_config, found type: ${String(type)}.`),
    ]);
  }

  if (!rootConfigPath(pathname) && document['type'] !== 'pipeline_config') {
    throw new ProjectPipelineIssuesError([
      makeIssue(pathname, 'type', 'a nonroot pipeline config must declare type: pipeline_config.'),
    ]);
  }
  const fragment = { ...document };
  delete fragment['type'];
  const parsed = DogsledConfigSchema.safeParse(declare(fragment));
  if (!parsed.success) {
    throw new ProjectPipelineIssuesError(
      parsed.error.issues.map((issue) =>
        makeIssue(pathname, issue.path.join('.') || undefined, issue.message)
      )
    );
  }
  return mapsForConfig(parsed.data, pathname);
}

function ownsSection(document: Record<string, unknown>, section: string): boolean {
  return Object.hasOwn(document, section);
}

function mergeConfigFragments(
  entries: readonly ProjectIndexEntry[],
  declare: DeclareFragment
): LoadedProjectPipelineConfig {
  const pipelinePathByName = new Map<string, string>();
  const destinationPathByName = new Map<string, string>();
  const sectionPathByName = new Map<string, string>();
  const pipelines: Record<string, unknown> = {};
  const destinations: Record<string, unknown> = {};
  const sections: Record<string, unknown> = {};
  const configPaths = entries.map((entry) => entry.path);
  const sectionsWithSingleOwner = ['defaults', 'models', 'platform'];

  for (const entry of entries) {
    let document: unknown;
    try {
      document = normalizePipelineBlueprint(safeParseYaml(entry.content), entry.path);
    } catch (error) {
      throw new ProjectPipelineIssuesError([
        makeIssue(
          entry.path,
          undefined,
          error instanceof CommandError
            ? error.message
            : `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`
        ),
      ]);
    }
    if (!isRecord(document)) {
      throw new ProjectPipelineIssuesError([
        makeIssue(entry.path, undefined, 'pipeline config must be a YAML mapping.'),
      ]);
    }

    if (!rootConfigPath(entry.path) && document['type'] !== 'pipeline_config') {
      throw new ProjectPipelineIssuesError([
        makeIssue(
          entry.path,
          'type',
          'a nonroot pipeline config must declare type: pipeline_config.'
        ),
      ]);
    }

    const fragmentInput = { ...document };
    delete fragmentInput['type'];
    const parsed = DogsledConfigFragmentSchema.safeParse(declare(fragmentInput));
    if (!parsed.success) {
      throw new ProjectPipelineIssuesError(
        parsed.error.issues.map((issue) =>
          makeIssue(entry.path, issue.path.join('.') || undefined, issue.message)
        )
      );
    }

    for (const [name, value] of Object.entries(parsed.data.pipelines ?? {})) {
      const previousPath = pipelinePathByName.get(name);
      if (previousPath) {
        throw new ProjectPipelineIssuesError([
          makeIssue(
            previousPath,
            `pipelines.${name}`,
            `Duplicate pipeline "${name}" is declared in both ${previousPath} and ${entry.path}.`,
            [entry.path]
          ),
        ]);
      }
      pipelines[name] = value;
      pipelinePathByName.set(name, entry.path);
    }
    for (const [name, value] of Object.entries(parsed.data.destinations ?? {})) {
      const previousPath = destinationPathByName.get(name);
      if (previousPath) {
        throw new ProjectPipelineIssuesError([
          makeIssue(
            previousPath,
            `destinations.${name}`,
            `Duplicate destination "${name}" is declared in both ${previousPath} and ${entry.path}.`,
            [entry.path]
          ),
        ]);
      }
      destinations[name] = value;
      destinationPathByName.set(name, entry.path);
    }
    for (const section of sectionsWithSingleOwner) {
      if (!ownsSection(document, section)) continue;
      const previousPath = sectionPathByName.get(section);
      if (previousPath) {
        throw new ProjectPipelineIssuesError([
          makeIssue(
            previousPath,
            section,
            `Pipeline config section "${section}" is declared in both ${previousPath} and ${entry.path}.`,
            [entry.path]
          ),
        ]);
      }
      sections[section] = parsed.data[section as keyof typeof parsed.data];
      sectionPathByName.set(section, entry.path);
    }
  }

  const fullConfig = DogsledConfigSchema.safeParse({ ...sections, pipelines, destinations });
  if (!fullConfig.success) {
    throw new ProjectPipelineIssuesError(
      fullConfig.error.issues.map((issue) => {
        const [top, key] = issue.path;
        const firstExtractPipelineName = Object.entries(pipelines).find(
          ([, pipeline]) =>
            isRecord(pipeline) &&
            pipeline['type'] !== 'models' &&
            pipeline['type'] !== 'entity-graph'
        )?.[0];
        const owner =
          top === 'pipelines' && typeof key === 'string'
            ? pipelinePathByName.get(key)
            : top === 'destinations' && typeof key === 'string'
              ? destinationPathByName.get(key)
              : top === 'destinations' && firstExtractPipelineName
                ? pipelinePathByName.get(firstExtractPipelineName)
                : typeof top === 'string'
                  ? sectionPathByName.get(top)
                  : undefined;
        const fieldPath = issue.path.join('.');
        return makeIssue(owner ?? configPaths[0] ?? '.', fieldPath || undefined, issue.message);
      })
    );
  }
  return {
    config: fullConfig.data,
    configPaths,
    pipelinePathByName,
    destinationPathByName,
    sectionPathByName,
  };
}

/** Load all Project pipeline config fragments, or exactly one explicit config file. */
export function loadProjectPipelineConfig(
  options: LoadProjectPipelineConfigOptions
): LoadedProjectPipelineConfig {
  const projectRoot = path.resolve(options.projectRoot);
  // Preserve the explicit path boundary error even when scanning the Project
  // would itself fail (for example, when the selected file is a symlink out).
  if (options.configPath !== undefined) resolveExplicitPath(projectRoot, options.configPath);
  const declaredEnvNames = parseHostDeclaredEnvNames(options.declaredEnvNames);
  const project = openDogsledProject(projectRoot, options.index);
  return loadOrThrow(
    projectRoot,
    project.index,
    options.configPath,
    hostDeclarations(declaredEnvNames, options.hostManagedModelAuth === true)
  );
}

/**
 * Load every Project pipeline config fragment for name discovery only. Parsing
 * and structural validation match `loadProjectPipelineConfig`, but each model
 * profile and pipeline embedding counts its own `api_key` name as declared, so
 * credential declarations never decide whether the names load. The returned
 * config is for reading names; never resolve, compile, or run it. Internal to
 * the Project Skills reference catalog.
 */
export function loadProjectPipelineConfigNames(
  projectRoot: string,
  index: ProjectIndex
): LoadedProjectPipelineConfig {
  return loadOrThrow(path.resolve(projectRoot), index, undefined, declareOwnModelApiKeys);
}

function loadOrThrow(
  projectRoot: string,
  index: ProjectIndex,
  configPath: string | undefined,
  declare: DeclareFragment
): LoadedProjectPipelineConfig {
  try {
    return loadFromProject(projectRoot, index, configPath, declare);
  } catch (error) {
    if (error instanceof ProjectPipelineIssuesError) {
      throw new DogsledProjectValidationError(error.issues);
    }
    throw error;
  }
}

function loadFromProject(
  projectRoot: string,
  index: ProjectIndex,
  configPath: string | undefined,
  declare: DeclareFragment
): LoadedProjectPipelineConfig {
  if (configPath !== undefined) {
    return loadExplicitConfig(projectRoot, configPath, index, declare);
  }
  const entries = [...entriesOfKind(index, 'pipeline_config')].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return mergeConfigFragments(entries, declare);
}

function issueOwner(
  issuePath: string,
  project: LoadedProjectPipelineConfig
): { filePath: string; fieldPath: string } | undefined {
  const normalizedIssuePath =
    ROOT_CONFIG_FILE_SPELLINGS.some((name) => issuePath.startsWith(`${name}:`)) ||
    /^dogsled\.ya?ml:/u.test(issuePath)
      ? issuePath.slice(issuePath.indexOf(':') + 1)
      : issuePath;
  for (const [prefix, owners] of [
    ['pipelines.', project.pipelinePathByName],
    ['destinations.', project.destinationPathByName],
  ] as const) {
    if (!normalizedIssuePath.startsWith(prefix)) continue;
    const suffix = normalizedIssuePath.slice(prefix.length);
    const owner = [...owners.keys()]
      .sort((left, right) => right.length - left.length)
      .find((name) => suffix === name || suffix.startsWith(`${name}.`));
    if (owner) {
      const pathname = owners.get(owner);
      return pathname === undefined
        ? undefined
        : { filePath: pathname, fieldPath: normalizedIssuePath };
    }
  }
  const section = normalizedIssuePath.split('.')[0];
  if (!section) return undefined;
  if (section === 'destinations') {
    const ownerPipeline = Object.entries(project.config.pipelines).find(([, pipeline]) =>
      isExtractPipelineConfig(pipeline)
    )?.[0];
    if (ownerPipeline) {
      const filePath = project.pipelinePathByName.get(ownerPipeline);
      if (filePath) return { filePath, fieldPath: normalizedIssuePath };
    }
  }
  const pathname = project.sectionPathByName.get(section);
  return pathname === undefined
    ? undefined
    : { filePath: pathname, fieldPath: normalizedIssuePath };
}

/**
 * Load and fully cross-validate a Dogsled project through the same resolver used
 * by `dogsled runner validate`.
 */
export async function resolveProjectPipelines(
  options: ResolveProjectPipelinesOptions
): Promise<ResolvedProjectPipelines> {
  const result = await validateProjectPipelines(options);
  if (result.status === 'valid') return result.project;
  throw new DogsledProjectValidationError(result.issues, result.warnings);
}

/** Validate a complete Dogsled Project without throwing for configuration errors. */
export async function validateProjectPipelines(
  options: ResolveProjectPipelinesOptions
): Promise<ProjectPipelineValidationResult> {
  const declaredEnvNames = parseHostDeclaredEnvNames(options.declaredEnvNames);
  if (options.configPath !== undefined) {
    try {
      resolveExplicitPath(path.resolve(options.projectRoot), options.configPath);
    } catch (error) {
      if (!(error instanceof ExplicitConfigPathError)) throw error;
      return {
        status: 'invalid',
        warnings: [],
        issues: [makeIssue(error.filePath, undefined, error.message)],
      };
    }
  }
  let project: ReturnType<typeof openDogsledProject>;
  try {
    project = openDogsledProject(options.projectRoot, options.index);
  } catch (error) {
    if (!(error instanceof ProjectIndexError)) throw error;
    return {
      status: 'invalid',
      warnings: [],
      issues: error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        filePath: issue.path,
      })),
    };
  }
  let loaded: LoadedProjectPipelineConfig;
  try {
    loaded = loadFromProject(
      project.root,
      project.index,
      options.configPath,
      hostDeclarations(declaredEnvNames, options.hostManagedModelAuth === true)
    );
  } catch (error) {
    if (!(error instanceof ProjectPipelineIssuesError)) throw error;
    return {
      status: 'invalid',
      warnings: [],
      issues: error.issues,
    };
  }
  const validationCatalog = options.validationCatalog ?? BUILT_IN_VALIDATION_CATALOG;
  const validation = await validateDogsledConfig(
    loaded.config,
    project.root,
    validationCatalog,
    project.index
  );
  validation.warnings.push(...undeclaredCredentialWarnings(project.index, declaredEnvNames));
  if (!validation.valid) {
    const issues = validation.errors.map((issue) => {
      const owner = issueOwner(issue.path, loaded);
      const filePath = owner?.filePath ?? loaded.configPaths[0] ?? '.';
      const fieldPath = owner?.fieldPath ?? issue.path;
      return {
        ...issue,
        path: `${filePath}:${fieldPath}`,
        filePath,
        ...(fieldPath ? { fieldPath } : {}),
      };
    });
    return { status: 'invalid', warnings: validation.warnings, issues };
  }
  enrichForEachParents(validation.pipelines, validationCatalog, project);
  const resolved: ResolvedProjectPipelines = {
    ...loaded,
    projectRoot: project.root,
    index: project.index,
    extractPipelines: validation.pipelines,
    modelPipelines: validation.modelPipelines,
    entityGraphPipelines: validation.entityGraphPipelines,
    secrets: validation.secrets,
    warnings: validation.warnings,
  };
  return { status: 'valid', project: resolved, warnings: validation.warnings, issues: [] };
}
