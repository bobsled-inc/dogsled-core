import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { BUILT_IN_SOURCE_FILES } from './builtin-sources/generated-data.js';
import { materializeBuiltInSources } from './builtin-sources/materialize.js';

// Built-in sources are embedded in the code (see `scripts/generate-builtin-sources.ts`).
// Never locate them relative to this file: bundlers move it, and the old
// `<this file>/../sources` lookup then fails with `Source "<name>" not found`.
const NAME_CONTAINMENT_ROOT = resolve(sep, 'sources');
const MAX_YAML_BYTES = 256 * 1024;
const MAX_YAML_ALIASES = 50;
type SourceSpecSubdirectory = 'resources' | 'actions';

// Cache is process-scoped and unbounded — appropriate for short-lived CLI processes.
// WARNING: Do not import this module from long-running server processes (e.g. Next.js
// API routes) without calling clearCache() after each request, as parsed YAML will
// accumulate in memory for the process lifetime.
const yamlCache = new Map<string, unknown>();
const subdirSpecIndexCache = new Map<string, Map<string, string>>();
const entityIndexCache = new Map<string, Map<string, EntityVariantEntry[]>>();
let builtInSourceNames: Set<string> | undefined;

/**
 * One variant of a resource grouped by its canonical entity name. For
 * multi-transport sources (e.g. Linear's `issues/graphql.yml` +
 * `issues/mcp.yml`), an entity bucket holds one entry per variant. For
 * single-file resources without an explicit `entity:` field, the bucket
 * holds one entry whose `name` equals the entity (entity defaults to name).
 */
export interface EntityVariantEntry {
  /** Resource spec `name:` (e.g. `cycles_mcp`). */
  name: string;
  /** Transport id (`via:`) when declared; `undefined` for single-variant resources
   * that omit the field. Multi-variant resources always declare `via:`. */
  via: string | undefined;
}

function sourceNames(): Set<string> {
  if (!builtInSourceNames) {
    builtInSourceNames = new Set(
      Object.keys(BUILT_IN_SOURCE_FILES)
        .filter((key) => key.includes('/'))
        .map((key) => key.slice(0, key.indexOf('/')))
    );
  }
  return builtInSourceNames;
}

export function getIntegrationsDir(): string {
  return getSourcesDir();
}

/**
 * Folder with a real copy of the built-in sources, for callers that need files
 * on disk. Prefer the lookup functions, which read the embedded data directly.
 */
export function getSourcesDir(): string {
  return materializeBuiltInSources();
}

/** Validate that a name contains no path separators or traversal sequences. */
export function assertSafeName(name: string, label: string): void {
  if (/[/\\]/.test(name) || name === '..' || name === '.') {
    throw new Error(`Invalid ${label}: "${name}"`);
  }

  // Defense-in-depth: verify the resolved path stays within the sources directory.
  const resolved = resolve(NAME_CONTAINMENT_ROOT, name);
  if (!resolved.startsWith(NAME_CONTAINMENT_ROOT + sep)) {
    throw new Error(`Invalid ${label}: "${name}"`);
  }
}

function parseYamlContent(content: string, label: string): unknown {
  if (Buffer.byteLength(content, 'utf-8') > MAX_YAML_BYTES) {
    throw new Error(`YAML file exceeds ${MAX_YAML_BYTES} byte safety limit: ${label}`);
  }
  return parseYaml(content, {
    maxAliasCount: MAX_YAML_ALIASES,
    prettyErrors: false,
    uniqueKeys: true,
  });
}

/**
 * Read and parse a YAML file, caching the result for the process lifetime.
 * Results are never invalidated — call clearCache() in dev/watch scenarios
 * or between requests in a long-running server to avoid stale data.
 */
export function readYamlFile(filePath: string): unknown {
  if (yamlCache.has(filePath)) return yamlCache.get(filePath);

  const size = statSync(filePath).size;
  if (size > MAX_YAML_BYTES) {
    throw new Error(`YAML file exceeds ${MAX_YAML_BYTES} byte safety limit: ${filePath}`);
  }

  const parsed = parseYamlContent(readFileSync(filePath, 'utf-8'), filePath);
  yamlCache.set(filePath, parsed);
  return parsed;
}

function builtInLabel(key: string): string {
  return `sources/${key}`;
}

function readBuiltInYaml(key: string): unknown {
  const cacheKey = `builtin:${key}`;
  if (yamlCache.has(cacheKey)) return yamlCache.get(cacheKey);

  const content = Object.hasOwn(BUILT_IN_SOURCE_FILES, key)
    ? BUILT_IN_SOURCE_FILES[key]
    : undefined;
  if (content === undefined) {
    throw new Error(`Built-in source file not found: ${builtInLabel(key)}`);
  }
  const parsed = parseYamlContent(content, builtInLabel(key));
  yamlCache.set(cacheKey, parsed);
  return parsed;
}

/** Read `meta.yml` or `source.yml` of a built-in source without touching the filesystem. */
export function readSourceYaml(sourceName: string, fileName: 'meta.yml' | 'source.yml'): unknown {
  assertSafeName(sourceName, 'source name');
  if (!sourceNames().has(sourceName)) {
    throw new Error(`Source "${sourceName}" not found`);
  }
  return readBuiltInYaml(`${sourceName}/${fileName}`);
}

/** Read a built-in resource spec by its `name:` without touching the filesystem. */
export function readResourceYaml(sourceName: string, resourceName: string): unknown {
  return readBuiltInYaml(resourceKey(sourceName, resourceName));
}

/**
 * Raw text of a top-level file of a built-in source (for example `integration.yml`),
 * or `undefined` when the source or file does not exist.
 */
export function readBuiltInSourceFile(sourceName: string, fileName: string): string | undefined {
  if (/[/\\]/.test(sourceName) || /[/\\]/.test(fileName)) return undefined;
  const key = `${sourceName}/${fileName}`;
  return Object.hasOwn(BUILT_IN_SOURCE_FILES, key) ? BUILT_IN_SOURCE_FILES[key] : undefined;
}

/** Built-in action spec files (`<source>/actions/*.yml`, top level only), in load order. */
export function listBuiltInActionFiles(): Array<{
  integration: string;
  label: string;
  content: string;
}> {
  return [...sourceNames()]
    .filter((name) => !name.startsWith('_'))
    .sort()
    .flatMap((integration) =>
      Object.keys(BUILT_IN_SOURCE_FILES)
        .filter((key) => {
          const rest = key.slice(`${integration}/actions/`.length);
          return (
            key.startsWith(`${integration}/actions/`) &&
            !rest.includes('/') &&
            rest.endsWith('.yml')
          );
        })
        .sort()
        .map((key) => ({
          integration,
          label: builtInLabel(key),
          content: BUILT_IN_SOURCE_FILES[key] as string,
        }))
    );
}

export function listSourceDirs(): string[] {
  return [...sourceNames()].filter((name) => !name.startsWith('_')).sort();
}

export function listIntegrationDirs(): string[] {
  return listSourceDirs();
}

export function getSourceDir(name: string): string {
  assertSafeName(name, 'source name');
  if (!sourceNames().has(name)) {
    throw new Error(`Source "${name}" not found`);
  }
  return join(materializeBuiltInSources(), name);
}

export function getIntegrationDir(name: string): string {
  return getSourceDir(name);
}

function listBuiltInYamlKeys(prefix: string): string[] {
  return Object.keys(BUILT_IN_SOURCE_FILES)
    .filter((key) => key.startsWith(`${prefix}/`) && key.endsWith('.yml'))
    .sort();
}

function readSpecName(key: string, label: string): string {
  const data = readBuiltInYaml(key);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} spec must be a YAML object: ${builtInLabel(key)}`);
  }

  const name = (data as Record<string, unknown>)['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label} spec must define a non-empty name: ${builtInLabel(key)}`);
  }
  assertSafeName(name, `${label} name`);
  return name;
}

function buildSubdirSpecIndex(
  sourceName: string,
  subdirectory: SourceSpecSubdirectory
): Map<string, string> {
  assertSafeName(sourceName, 'source name');
  const cacheKey = `${sourceName}:${subdirectory}`;
  const cached = subdirSpecIndexCache.get(cacheKey);
  if (cached) return cached;

  const byName = new Map<string, string>();

  for (const key of listBuiltInYamlKeys(`${sourceName}/${subdirectory}`)) {
    const name = readSpecName(key, subdirectory.slice(0, -1));
    const existing = byName.get(name);
    if (existing) {
      throw new Error(
        `Duplicate ${subdirectory.slice(0, -1)} name "${name}" in source "${sourceName}": ${builtInLabel(existing)} and ${builtInLabel(key)}`
      );
    }
    byName.set(name, key);
  }

  subdirSpecIndexCache.set(cacheKey, byName);
  return byName;
}

function listSourceSubdirFiles(sourceName: string, subdirectory: SourceSpecSubdirectory): string[] {
  return [...buildSubdirSpecIndex(sourceName, subdirectory).keys()].sort();
}

export function listResourceFiles(sourceName: string): string[] {
  return listSourceSubdirFiles(sourceName, 'resources');
}

export function listActionFiles(sourceName: string): string[] {
  return listSourceSubdirFiles(sourceName, 'actions');
}

function resourceKey(sourceName: string, resourceName: string): string {
  assertSafeName(resourceName, 'resource name');
  const key = buildSubdirSpecIndex(sourceName, 'resources').get(resourceName);
  if (!key) {
    throw new Error(`Resource "${resourceName}" not found for source "${sourceName}"`);
  }
  return key;
}

export function getResourcePath(sourceName: string, resourceName: string): string {
  const key = resourceKey(sourceName, resourceName);
  return join(materializeBuiltInSources(), ...key.split('/'));
}

/**
 * Build (or fetch from cache) a Map of canonical `entity` names to the list of
 * variants that share that entity for a single source. Used by Dogsled to resolve
 * pipeline `resources: [<entity>]` references against the right transport
 * variant (e.g. `issues` + `via: mcp` → `issues_mcp`). Reads the embedded YAML directly
 * rather than the heavier Zod parsing path, so this stays cheap
 * to call once per validation pass.
 */
function buildEntityIndex(sourceName: string): Map<string, EntityVariantEntry[]> {
  assertSafeName(sourceName, 'source name');
  const cached = entityIndexCache.get(sourceName);
  if (cached) return cached;

  const byEntity = new Map<string, EntityVariantEntry[]>();

  for (const key of listBuiltInYamlKeys(`${sourceName}/resources`)) {
    const data = readBuiltInYaml(key);
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const obj = data as Record<string, unknown>;
    const name = obj['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const entity =
      typeof obj['entity'] === 'string' && obj['entity'].length > 0 ? obj['entity'] : name;
    const via = typeof obj['via'] === 'string' && obj['via'].length > 0 ? obj['via'] : undefined;
    const bucket = byEntity.get(entity) ?? [];
    bucket.push({ name, via });
    byEntity.set(entity, bucket);
  }

  // Sort each bucket by spec name for deterministic ordering.
  for (const bucket of byEntity.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  entityIndexCache.set(sourceName, byEntity);
  return byEntity;
}

/**
 * List canonical entity names for a source. Includes both multi-transport
 * entities (one entry per entity, regardless of how many variants exist) and
 * single-variant resources (where the entity defaults to the spec name).
 * Result is sorted lexicographically.
 */
export function listEntities(sourceName: string): string[] {
  return [...buildEntityIndex(sourceName).keys()].sort();
}

/**
 * List variants for a specific entity on a source. Returns an empty array when
 * the entity is unknown. Each entry has a `name` (the resource spec name to
 * pass to extractor) and a `via` (transport id, or `undefined` if the resource
 * didn't declare one — typical for single-transport sources).
 */
export function getEntityVariants(sourceName: string, entity: string): EntityVariantEntry[] {
  const bucket = buildEntityIndex(sourceName).get(entity);
  return bucket ? bucket.map((entry) => ({ ...entry })) : [];
}

export function clearCache(): void {
  yamlCache.clear();
  subdirSpecIndexCache.clear();
  entityIndexCache.clear();
}
