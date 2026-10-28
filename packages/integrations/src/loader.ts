import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(__dirname, '..', 'sources');
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

export function getIntegrationsDir(): string {
  return getSourcesDir();
}

export function getSourcesDir(): string {
  return SOURCES_DIR;
}

/** Validate that a name contains no path separators or traversal sequences. */
export function assertSafeName(name: string, label: string): void {
  if (/[/\\]/.test(name) || name === '..' || name === '.') {
    throw new Error(`Invalid ${label}: "${name}"`);
  }

  // Defense-in-depth: verify the resolved path stays within the sources directory.
  const root = resolve(SOURCES_DIR);
  const resolved = resolve(SOURCES_DIR, name);
  if (!resolved.startsWith(root + sep)) {
    throw new Error(`Invalid ${label}: "${name}"`);
  }
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

  const content = readFileSync(filePath, 'utf-8');
  const parsed: unknown = parseYaml(content, {
    maxAliasCount: MAX_YAML_ALIASES,
    prettyErrors: false,
    uniqueKeys: true,
  });
  yamlCache.set(filePath, parsed);
  return parsed;
}

export function listSourceDirs(): string[] {
  if (!existsSync(SOURCES_DIR)) return [];

  return readdirSync(SOURCES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
}

export function listIntegrationDirs(): string[] {
  return listSourceDirs();
}

export function getSourceDir(name: string): string {
  assertSafeName(name, 'source name');
  const resolved = join(SOURCES_DIR, name);
  if (!existsSync(resolved)) {
    throw new Error(`Source "${name}" not found`);
  }
  return resolved;
}

export function getIntegrationDir(name: string): string {
  return getSourceDir(name);
}

function listYamlFilesRecursive(directory: string): string[] {
  if (!existsSync(directory)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listYamlFilesRecursive(path));
    } else if (entry.isFile() && entry.name.endsWith('.yml')) {
      files.push(path);
    }
  }

  return files.sort();
}

function readSpecName(filePath: string, label: string): string {
  const data = readYamlFile(filePath);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} spec must be a YAML object: ${filePath}`);
  }

  const name = (data as Record<string, unknown>)['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label} spec must define a non-empty name: ${filePath}`);
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

  const directory = join(SOURCES_DIR, sourceName, subdirectory);
  const byName = new Map<string, string>();

  for (const filePath of listYamlFilesRecursive(directory)) {
    const name = readSpecName(filePath, subdirectory.slice(0, -1));
    const existing = byName.get(name);
    if (existing) {
      throw new Error(
        `Duplicate ${subdirectory.slice(0, -1)} name "${name}" in source "${sourceName}": ${existing} and ${filePath}`
      );
    }
    byName.set(name, filePath);
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

export function getResourcePath(sourceName: string, resourceName: string): string {
  assertSafeName(resourceName, 'resource name');
  const resourcePath = buildSubdirSpecIndex(sourceName, 'resources').get(resourceName);
  if (!resourcePath) {
    throw new Error(`Resource "${resourceName}" not found for source "${sourceName}"`);
  }
  return resourcePath;
}

/**
 * Build (or fetch from cache) a Map of canonical `entity` names to the list of
 * variants that share that entity for a single source. Used by Dogsled to resolve
 * pipeline `resources: [<entity>]` references against the right transport
 * variant (e.g. `issues` + `via: mcp` → `issues_mcp`). Reads YAML directly via
 * `readYamlFile` rather than the heavier Zod parsing path, so this stays cheap
 * to call once per validation pass.
 */
function buildEntityIndex(sourceName: string): Map<string, EntityVariantEntry[]> {
  assertSafeName(sourceName, 'source name');
  const cached = entityIndexCache.get(sourceName);
  if (cached) return cached;

  const directory = join(SOURCES_DIR, sourceName, 'resources');
  const byEntity = new Map<string, EntityVariantEntry[]>();

  for (const filePath of listYamlFilesRecursive(directory)) {
    const data = readYamlFile(filePath);
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
