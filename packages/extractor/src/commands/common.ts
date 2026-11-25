/**
 * Shared command setup utilities.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  documentName,
  entriesOfKind,
  entryFilePath,
  findNamedEntry,
  resolveProjectIndex,
  resourceIntegration,
  singleEntryOfKind,
  type ProjectIndex,
} from '@bobsled-inc/project-index';
import YAML from 'yaml';
import type { z } from 'zod';

import { SAFE_NAME_RE, getErrorMessage } from '../framework/core/index.js';
import {
  CommandError,
  DOGSLED_LEGACY_BLUEPRINT_KEY,
  LegacyBlueprintKeyConflictError,
  formatSpecValidationMessage,
  type SpecValidationKind,
} from '@bobsled-inc/protocol';

import { loadExtractorConfig, resolveExtractorConfig } from '../config.js';
import { normalizeSpec } from '../schemas/normalize.js';
import { ExtractIntentsSchema } from '../schemas/extract-intents.js';
import { IntegrationSpecSchema } from '../schemas/integration.js';
import {
  FileCopyResourceSpecSchema,
  isCopyResourceDocument,
} from '../framework/extractor/file-copy-resource.js';
import {
  FileResourceSpecSchema,
  isDocumentResourceDocument,
} from '../framework/extractor/file-resource.js';
import { ResourceSpecSchema } from '../schemas/resource.js';

import type {
  ExtractIntentsManifest,
  ExtractorConfig,
  IntegrationSpec,
  ResourceSpec,
} from '../types/index.js';

export { CommandError };

/**
 * Turn a raw `yaml` parse error into an actionable diagnostic.
 *
 * The most common authoring footgun is a single- or double-quoted scalar that
 * spans multiple lines with continuation lines flush at column 0 (e.g. pasting
 * a code block into a quoted `description`). The `yaml` library reports this as
 * the opaque "Missing closing 'quote at line N" — which points at the wrong
 * line and gives no fix. Append guidance steering authors to a block scalar.
 */
export function describeYamlParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Invalid YAML';
  if (/Missing closing .?quote/i.test(message)) {
    return (
      `${message}\n` +
      '  Hint: a quoted scalar is broken by an un-indented continuation line at ' +
      'column 0. Quoted scalars cannot wrap to the left margin — use a block ' +
      'scalar (`|-` for literal, `>-` for folded) for embedded code blocks or ' +
      'multi-line text, or indent the continuation lines past the key.'
    );
  }
  return message;
}

export interface GlobalFlags {
  verbose: boolean;
  quiet: boolean;
  logFormat: 'json' | 'pretty';
}

export interface CommandContext {
  cwd: string;
  /** Type index of the project in `cwd`; integrations and resources are found here. */
  project: ProjectIndex;
  /** Default directory for newly generated resource files. */
  resourcesDir: string;
  /**
   * `resourcesDir` relative to the project, as a POSIX path: a resource under
   * `<resourcesFolder>/<integration>/` that declares no integration belongs
   * to that folder's integration.
   */
  resourcesFolder: string;
  bundledIntegrationsDir: string | null;
  config: ExtractorConfig;
  verbose: boolean;
  quiet: boolean;
  logFormat: 'json' | 'pretty';
}

export function parseLogFormat(value: string): 'json' | 'pretty' {
  if (value !== 'json' && value !== 'pretty') {
    throw new CommandError(`Invalid log format "${value}". Must be "json" or "pretty".`);
  }
  return value;
}

export function parseGlobalFlags(opts: {
  verbose?: boolean;
  quiet?: boolean;
  logFormat?: string;
}): GlobalFlags {
  return {
    verbose: opts.verbose ?? false,
    quiet: opts.quiet ?? false,
    logFormat: parseLogFormat(opts.logFormat ?? 'json'),
  };
}

export function parseProcessGlobalFlags(argv: string[]): GlobalFlags {
  let verbose = false;
  let quiet = false;
  let logFormat: 'json' | 'pretty' = 'json';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
      continue;
    }
    if (arg === '--quiet' || arg === '-q') {
      quiet = true;
      continue;
    }
    if (arg === '--log-format') {
      if (!argv[index + 1]) {
        throw new CommandError('Missing value for "--log-format". Expected "json" or "pretty".', 1);
      }
      logFormat = parseLogFormat(argv[index + 1]!);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--log-format=')) {
      logFormat = parseLogFormat(arg.slice('--log-format='.length));
    }
  }

  return { verbose, quiet, logFormat };
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code);
  }
  return undefined;
}

export function assertPathContained(cwd: string, dir: string, label: string): void {
  const resolved = path.resolve(cwd, dir);

  let realResolved = resolved;
  let realCwd = cwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    // noop
  }

  try {
    realResolved = fs.realpathSync(resolved);
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error;
    }

    const missingSegments: string[] = [];
    let probe = resolved;
    while (true) {
      const parent = path.dirname(probe);
      if (parent === probe) {
        break;
      }
      missingSegments.unshift(path.basename(probe));
      probe = parent;
      try {
        const realAncestor = fs.realpathSync(probe);
        realResolved = path.join(realAncestor, ...missingSegments);
        break;
      } catch (probeError) {
        if (getErrnoCode(probeError) !== 'ENOENT') {
          throw probeError;
        }
      }
    }
  }

  const prefix = realCwd.endsWith(path.sep) ? realCwd : `${realCwd}${path.sep}`;
  if (!realResolved.startsWith(prefix) && realResolved !== realCwd) {
    throw new CommandError(`${label} "${dir}" resolves outside project root.`);
  }
}

export function buildCommandContext(globalFlags: GlobalFlags): CommandContext {
  const cwd = process.cwd();
  const project = resolveProjectIndex(cwd);
  const fileConfig = loadExtractorConfig(cwd, { index: project });
  const config = resolveExtractorConfig(fileConfig);

  assertPathContained(cwd, config.integrations_dir, 'integrations_dir');
  assertPathContained(cwd, config.resources_dir, 'resources_dir');
  assertPathContained(cwd, config.state_dir, 'state_dir');
  assertPathContained(cwd, config.output_dir, 'output_dir');
  assertPathContained(cwd, config.batch_dir, 'batch_dir');

  const bundledDir = process.env['DOGSLED_BUNDLED_INTEGRATIONS_DIR'];

  return {
    cwd,
    project,
    resourcesDir: path.resolve(cwd, config.resources_dir),
    resourcesFolder: path
      .relative(cwd, path.resolve(cwd, config.resources_dir))
      .split(path.sep)
      .join('/'),
    bundledIntegrationsDir: bundledDir && fs.existsSync(bundledDir) ? bundledDir : null,
    config,
    ...globalFlags,
  };
}

export function resolveOpenApiSource(source: string, baseDir: string): string {
  if (source.startsWith('https://')) {
    return source;
  }

  assertPathContained(baseDir, source, 'OpenAPI path');
  return path.resolve(baseDir, source);
}

const MAX_SPEC_FILE_SIZE = 1_048_576;
const BUNDLED_SOURCE_FILENAMES = ['source.yml', 'source.yaml', 'integration.yml'] as const;
const RESOURCE_SPEC_EXTENSIONS = ['.yml', '.yaml'] as const;

export interface LoadSpecResult<T> {
  spec: T;
  warnings: string[];
}

function loadSpecCore<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string,
  kind: SpecValidationKind
): LoadSpecResult<T> {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    throw formatSpecFileError('inspect', label, filePath, error);
  }

  if (stats.size > MAX_SPEC_FILE_SIZE) {
    throw new CommandError(
      `${label} file too large: ${filePath} (${stats.size} bytes, max ${MAX_SPEC_FILE_SIZE})`
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw formatSpecFileError('read', label, filePath, error);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (error) {
    throw new CommandError(`Invalid ${label} ${filePath}: ${describeYamlParseError(error)}`);
  }

  let normalized: ReturnType<typeof normalizeSpec>;
  try {
    normalized = normalizeSpec(raw, {
      path: filePath,
      integration: kind === 'integration',
    });
  } catch (error) {
    if (!(error instanceof LegacyBlueprintKeyConflictError)) throw error;
    throw new CommandError(error.message, 2);
  }

  // A copy or document Resource is parsed on its own: the union of Resource kinds would show the
  // errors of another kind, not the plain message for the setting this one refuses.
  let parser: z.ZodType = schema;
  if (kind === 'resource' && isCopyResourceDocument(normalized.data)) {
    parser = FileCopyResourceSpecSchema;
  } else if (kind === 'resource' && isDocumentResourceDocument(normalized.data)) {
    parser = FileResourceSpecSchema;
  }
  const result = parser.safeParse(normalized.data) as ReturnType<typeof schema.safeParse>;
  if (!result.success) {
    throw new CommandError(formatSpecValidationMessage(kind, filePath, result.error, { schema }));
  }

  return { spec: result.data, warnings: normalized.warnings };
}

function loadSpec<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string,
  kind: SpecValidationKind
): T {
  return loadSpecCore(filePath, schema, label, kind).spec;
}

export function loadIntegrationSpec(filePath: string): IntegrationSpec {
  return loadIntegrationSpecWithWarnings(filePath).spec;
}

export function loadResourceSpec(filePath: string): ResourceSpec {
  return loadSpec(filePath, ResourceSpecSchema, 'resource spec', 'resource');
}

export function loadExtractIntentsManifest(filePath: string): ExtractIntentsManifest {
  return loadSpec(filePath, ExtractIntentsSchema, 'extract intents manifest', 'extract intents');
}

export function integrationSpecWarningMessages(
  name: string,
  warnings: readonly string[]
): string[] {
  const messages: string[] = [];
  const deprecations: string[] = [];
  for (const warning of warnings) {
    if (warning.startsWith(`${DOGSLED_LEGACY_BLUEPRINT_KEY}:`)) {
      deprecations.push(warning);
    } else {
      messages.push(`integration spec ${name}: normalized key: ${warning}`);
    }
  }
  if (deprecations.length > 0) messages.push(deprecations.join('; '));
  return messages;
}

/** The shipped `source.yml` that `filePath` really is, if it is one. */
function bundledSourcePath(filePath: string, name: string): string | undefined {
  const bundledDir = process.env['DOGSLED_BUNDLED_INTEGRATIONS_DIR'];
  if (!bundledDir || path.basename(filePath) !== 'source.yml') return undefined;
  const expected = path.join(bundledDir, name, 'source.yml');
  return fs.existsSync(expected) && fs.realpathSync(filePath) === fs.realpathSync(expected)
    ? expected
    : undefined;
}

/**
 * Reserved credential names a local run may read for a shipped source: its own
 * declarations, and only when the integration and every selected resource are
 * the shipped files. A Project copy or a Project resource gets nothing, because
 * Project files could otherwise point these credentials anywhere.
 */
export function shippedSourceCredentialNames(
  integrationFile: string,
  integration: IntegrationSpec,
  resourceFiles: readonly string[]
): string[] {
  const source = bundledSourcePath(integrationFile, integration.name);
  if (!source) return [];
  const resourcesDir = path.join(fs.realpathSync(path.dirname(source)), 'resources');
  const shipped = resourceFiles.every((filePath) =>
    fs.realpathSync(filePath).startsWith(resourcesDir + path.sep)
  );
  return shipped ? (integration.auth_env_vars ?? []) : [];
}

export function loadIntegrationSpecWithWarnings(filePath: string): LoadSpecResult<IntegrationSpec> {
  const result = loadSpecCore(filePath, IntegrationSpecSchema, 'integration spec', 'integration');
  if (!('transport' in result.spec) && !('transports' in result.spec)) return result;
  const expected = bundledSourcePath(filePath, result.spec.name);
  if (!expected) return result;
  const metaPath = ['meta.yml']
    .map((name) => path.join(path.dirname(expected), name))
    .find((candidate) => fs.existsSync(candidate));
  if (!metaPath) return result;
  if (fs.statSync(metaPath).size > MAX_SPEC_FILE_SIZE) {
    throw new CommandError('Integration metadata file too large');
  }
  const meta = YAML.parse(fs.readFileSync(metaPath, 'utf8')) as {
    auth_setup?: Array<{ env?: unknown }>;
  } | null;
  const declared = Array.isArray(meta?.auth_setup)
    ? meta.auth_setup.flatMap((entry) => (typeof entry?.env === 'string' ? [entry.env] : []))
    : [];
  return {
    ...result,
    spec: {
      ...result.spec,
      auth_env_vars: [
        ...new Set([
          ...('auth_env_vars' in result.spec ? (result.spec.auth_env_vars ?? []) : []),
          ...declared,
        ]),
      ],
    },
  };
}

export function loadResourceSpecWithWarnings(filePath: string): LoadSpecResult<ResourceSpec> {
  return loadSpecCore(filePath, ResourceSpecSchema, 'resource spec', 'resource');
}

export function loadExtractIntentsManifestWithWarnings(
  filePath: string
): LoadSpecResult<ExtractIntentsManifest> {
  return loadSpecCore(
    filePath,
    ExtractIntentsSchema,
    'extract intents manifest',
    'extract intents'
  );
}

export { SAFE_NAME_RE };

/**
 * Path of the integration named `name`: the project file declaring
 * `type: integration` (or a spec-version-2 `type: source`) with that `name`,
 * wherever it lives, else the bundled source.
 */
export function findIntegrationFile(
  project: ProjectIndex,
  name: string,
  bundledIntegrationsDir?: string | null
): string {
  if (!SAFE_NAME_RE.test(name)) {
    throw new CommandError(`Invalid integration name "${name}". Must be lowercase snake_case.`);
  }

  const local = findNamedEntry(project, 'integration', name);
  if (local) return entryFilePath(project, local);

  // Bundled source layout: <bundled_dir>/<name>/source.yml (legacy: integration.yml)
  if (bundledIntegrationsDir) {
    for (const filename of BUNDLED_SOURCE_FILENAMES) {
      const bundledFile = path.join(bundledIntegrationsDir, name, filename);
      try {
        const stats = fs.lstatSync(bundledFile);
        if (stats.isFile()) {
          fs.accessSync(bundledFile, fs.constants.R_OK);
          return bundledFile;
        }
      } catch (error) {
        if (getErrnoCode(error) !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  const bundledHint = bundledIntegrationsDir
    ? ` or bundled ${BUNDLED_SOURCE_FILENAMES.map((filename) => `${bundledIntegrationsDir}/${name}/${filename}`).join(', ')}`
    : '';
  throw new CommandError(
    `Integration "${name}" not found. Declare it in a project file with type: integration and name: ${name}${bundledHint}.`
  );
}

/**
 * Where the resource helpers look: the project index, the resources folder
 * whose `<integration>/` subfolders own resources that declare no
 * integration, and the bundled catalog (`null` for project resources only).
 */
export type ResourceLookup = Pick<
  CommandContext,
  'project' | 'resourcesFolder' | 'bundledIntegrationsDir'
>;

/**
 * Resource files for `integrationName`: every project resource that declares
 * that integration (or sits under `<resourcesFolder>/<integration>/`), plus
 * bundled resources no project resource overrides by name.
 */
export function findResourceFiles(lookup: ResourceLookup, integrationName: string): string[] {
  const { project, bundledIntegrationsDir } = lookup;
  if (!SAFE_NAME_RE.test(integrationName)) {
    throw new CommandError(
      `Invalid integration name "${integrationName}". Must be lowercase snake_case.`
    );
  }

  const localEntries = entriesOfKind(project, 'resource').filter(
    (entry) => resourceIntegration(entry, lookup.resourcesFolder) === integrationName
  );
  const localFiles = localEntries.map((entry) => entryFilePath(project, entry));

  // Project-local resources override bundled resources one logical resource at
  // a time. The filename is not the identity: nested transport variants and
  // custom filenames can declare a different `name`, so parse every local
  // resource before deciding which bundled files to hide.
  const localNames = new Set(localFiles.map((filePath) => loadResourceSpec(filePath).name));

  // Bundled source layout: <bundled_dir>/<integration_name>/resources/**/*.yml
  const bundledFiles = bundledIntegrationsDir
    ? findRecursiveResourceFiles(path.join(bundledIntegrationsDir, integrationName, 'resources'))
    : [];

  const visibleBundledFiles = bundledFiles.filter(
    (filePath) => !localNames.has(loadResourceSpec(filePath).name)
  );

  // Keep all local files, including duplicate logical names, so
  // loadNamedResource() can retain its actionable duplicate-name diagnostic.
  return [...localFiles, ...visibleBundledFiles].sort();
}

/**
 * Project resources that declare no integration and sit outside
 * `<resourcesFolder>/<integration>/`, so nothing can own them.
 */
export function unownedProjectResources(
  lookup: Pick<ResourceLookup, 'project' | 'resourcesFolder'>
): string[] {
  return entriesOfKind(lookup.project, 'resource')
    .filter((entry) => resourceIntegration(entry, lookup.resourcesFolder) === undefined)
    .map((entry) => entry.path);
}

function isResourceSpecFile(name: string): boolean {
  return RESOURCE_SPEC_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function findRecursiveResourceFiles(directory: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.isSymbolicLink()) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && isResourceSpecFile(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  walk(directory);
  return files.sort();
}

/** Path of the project's extract intents manifest, if it declares one. */
export function findExtractIntentsFile(project: ProjectIndex): string | undefined {
  const entry = singleEntryOfKind(project, 'extract-intents');
  return entry ? entryFilePath(project, entry) : undefined;
}

export function validateOutputMode(mode: string): 'stdout' | 'file' {
  if (mode !== 'stdout' && mode !== 'file') {
    throw new CommandError(`Invalid output mode "${mode}". Must be "stdout" or "file".`);
  }
  return mode;
}

export function loadNamedResource(
  lookup: ResourceLookup,
  integrationName: string,
  resourceName: string
): ResourceSpec {
  const { project } = lookup;
  if (!SAFE_NAME_RE.test(resourceName)) {
    throw new CommandError(
      `Invalid resource name "${resourceName}". Must be lowercase snake_case.`
    );
  }

  const matches = findResourceFiles(lookup, integrationName)
    .map((filePath) => ({ filePath, spec: loadResourceSpec(filePath) }))
    .filter(({ spec }) => spec.name === resourceName);

  for (const { filePath, spec } of matches) {
    if (spec.integration !== undefined && spec.integration !== integrationName) {
      throw new CommandError(
        `Resource "${resourceName}" in ${relativeToProject(project, filePath)} declares integration "${spec.integration}" but is located under integration "${integrationName}".`
      );
    }
  }

  if (matches.length === 0) {
    throw new CommandError(
      `Resource "${resourceName}" not found for integration "${integrationName}".`
    );
  }

  if (matches.length > 1) {
    throw new CommandError(
      `Resource "${resourceName}" is defined multiple times for integration "${integrationName}": ${matches
        .map(({ filePath }) => relativeToProject(project, filePath))
        .join(', ')}.`
    );
  }

  return matches[0]!.spec;
}

function relativeToProject(project: ProjectIndex, filePath: string): string {
  if (!project.root) return path.isAbsolute(filePath) ? path.basename(filePath) : filePath;
  return filePath.startsWith(`${project.root}${path.sep}`)
    ? path.relative(project.root, filePath).split(path.sep).join('/')
    : path.basename(filePath);
}

export function collectInput(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export { parsePositiveInt } from '@bobsled-inc/protocol';

export function isMcpIntegration(integration: IntegrationSpec): boolean {
  if ('transport' in integration && integration.transport) {
    return integration.transport.type === 'mcp_http' || integration.transport.type === 'mcp_stdio';
  }

  if ('transports' in integration && Array.isArray(integration.transports)) {
    return integration.transports.some(
      (transport) => transport.type === 'mcp_http' || transport.type === 'mcp_stdio'
    );
  }

  return false;
}

export function describeTransport(integration: IntegrationSpec): string {
  if ('transports' in integration && Array.isArray(integration.transports)) {
    return `transports: ${integration.transports
      .map((transport) => `${transport.id} (${transport.type})`)
      .join(', ')}`;
  }

  if (!('transport' in integration)) {
    return 'non-API source';
  }

  switch (integration.transport.type) {
    case 'http':
      return integration.transport.base_url;
    case 'mcp_http':
      return `MCP HTTP: ${integration.transport.url}`;
    case 'mcp_stdio':
      return `MCP stdio: ${integration.transport.command}`;
    default:
      return 'unknown transport';
  }
}

/** Names of every integration the project declares, wherever its file lives. */
export function findAllIntegrations(project: ProjectIndex): string[] {
  const names = entriesOfKind(project, 'integration')
    .map((entry) => documentName(entry))
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)].sort();
}

export function findAllAvailableIntegrations(
  project: ProjectIndex,
  bundledIntegrationsDir?: string | null
): string[] {
  const names = new Set(findAllIntegrations(project));

  if (bundledIntegrationsDir) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(bundledIntegrationsDir, { withFileTypes: true });
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return [...names].sort();
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SAFE_NAME_RE.test(entry.name)) continue;

      for (const filename of BUNDLED_SOURCE_FILENAMES) {
        const integrationFile = path.join(bundledIntegrationsDir, entry.name, filename);
        try {
          const stats = fs.lstatSync(integrationFile);
          if (stats.isFile()) {
            names.add(entry.name);
            break;
          }
        } catch (error) {
          if (getErrnoCode(error) !== 'ENOENT') {
            throw error;
          }
        }
      }
    }
  }

  return [...names].sort();
}

function formatSpecFileError(
  operation: 'inspect' | 'read',
  label: string,
  filePath: string,
  error: unknown
): CommandError {
  const message = getErrorMessage(error);
  const code = getErrnoCode(error);
  const detail = code ? `${message} (${code})` : message;
  return new CommandError(`Unable to ${operation} ${label} ${filePath}: ${detail}`);
}
