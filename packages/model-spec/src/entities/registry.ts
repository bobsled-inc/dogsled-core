import { expandOssieIndex } from '../ossie/index.js';
/**
 * Loaders for metadata entities (metrics / relationships / VQs).
 *
 * `loadIndexedMetadataRegistry` reads every metric, relationship, entity
 * relationship, and VQ from a project index, wherever the files live. The
 * directory loaders, and `loadMetadataRegistry` over them, walk one
 * `<projectDir>/<dir>/**\/*.yml` tree per kind. Each parses
 * files against the kind's Zod schema and returns a map keyed by entity name;
 * duplicate names are rejected with `CommandError(2)`. The loaders are
 * deliberately oblivious to cross-file references — `validateMetadataReferences`
 * in `./cross-references.ts` handles those after all specs are parsed.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  assertValidProjectIndex,
  duplicateIdentityIssues,
  entriesOfKind,
  entryFilePath,
  ProjectIndexError,
  type ProjectFileKind,
  type ProjectIndex,
} from '@bobsled-inc/project-index';
import YAML from 'yaml';

import type { ZodType } from 'zod';

import { CommandError } from '../errors.js';

import { MetricSpecSchema, type MetricSpec } from './metric.js';
import {
  EntityRelationshipSpecSchema,
  type EntityRelationshipSpec,
} from './entity-relationship.js';
import { RelationshipSpecSchema, type RelationshipSpec } from './relationship.js';
import { VqSpecSchema, type VqSpec } from './vq.js';

const YAML_EXTENSIONS = ['.yml', '.yaml'] as const;

async function listYamlFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listYamlFiles(full)));
    } else if (YAML_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

async function readYaml(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new CommandError(
      `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }
  try {
    return YAML.parse(raw);
  } catch (err) {
    throw new CommandError(
      `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }
}

function formatZodIssues(error: import('zod').ZodError, filePath: string, kind: string): never {
  const issues = error.issues
    .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('\n');
  throw new CommandError(`Invalid ${kind} file ${filePath}:\n${issues}`, 2);
}

function parseEntities<T extends { name: string }>(
  files: ReadonlyArray<{ filePath: string; doc: unknown }>,
  schema: ZodType<T>,
  kind: string
): Map<string, T> {
  const parsed = files.map(({ filePath, doc }) => {
    const result = schema.safeParse(doc);
    if (!result.success) formatZodIssues(result.error, filePath, kind);
    return { path: filePath, entity: result.data };
  });
  const duplicates = duplicateIdentityIssues(parsed, (item) => item.entity.name, `${kind} name`);
  if (duplicates.length > 0) throw new ProjectIndexError(duplicates);
  return new Map(parsed.map((item) => [item.entity.name, item.entity]));
}

function docType(doc: unknown): string | undefined {
  if (!doc || typeof doc !== 'object' || !('type' in doc)) return undefined;
  const value = doc.type;
  return typeof value === 'string' ? value : undefined;
}

async function readDirectoryFiles(
  projectDir: string,
  dirName: string
): Promise<Array<{ filePath: string; doc: unknown }>> {
  const files = await listYamlFiles(path.join(projectDir, dirName));
  const documents: Array<{ filePath: string; doc: unknown }> = [];
  for (const filePath of files) documents.push({ filePath, doc: await readYaml(filePath) });
  return documents;
}

async function loadRelationshipRegistries(
  projectDir: string,
  dirName: string
): Promise<{
  relationships: Map<string, RelationshipSpec>;
  entityRelationships: Map<string, EntityRelationshipSpec>;
}> {
  const files = await readDirectoryFiles(projectDir, dirName);
  const isEntityRelationship = (file: { doc: unknown }) =>
    docType(file.doc) === 'entity_relationship';
  return {
    relationships: parseEntities(
      files.filter((file) => !isEntityRelationship(file)),
      RelationshipSpecSchema,
      'relationship'
    ),
    entityRelationships: parseEntities(
      files.filter(isEntityRelationship),
      EntityRelationshipSpecSchema,
      'entity relationship'
    ),
  };
}

// ---------------------------------------------------------------------------
// Directory loaders
// ---------------------------------------------------------------------------

/** Load every metric under one directory. Project loaders use the project index instead. */
export async function loadMetricsDirectory(
  projectDir: string,
  dirName: string
): Promise<Map<string, MetricSpec>> {
  return parseEntities(await readDirectoryFiles(projectDir, dirName), MetricSpecSchema, 'metric');
}

export async function loadRelationshipsDirectory(
  projectDir: string,
  dirName: string
): Promise<Map<string, RelationshipSpec>> {
  return (await loadRelationshipRegistries(projectDir, dirName)).relationships;
}

export async function loadEntityRelationshipsDirectory(
  projectDir: string,
  dirName: string
): Promise<Map<string, EntityRelationshipSpec>> {
  return (await loadRelationshipRegistries(projectDir, dirName)).entityRelationships;
}

export async function loadVqsDirectory(
  projectDir: string,
  dirName: string
): Promise<Map<string, VqSpec>> {
  return parseEntities(await readDirectoryFiles(projectDir, dirName), VqSpecSchema, 'VQ');
}

// ---------------------------------------------------------------------------
// Combined metadata registry
// ---------------------------------------------------------------------------

export interface MetadataRegistry {
  metrics: Map<string, MetricSpec>;
  relationships: Map<string, RelationshipSpec>;
  entityRelationships: Map<string, EntityRelationshipSpec>;
  vqs: Map<string, VqSpec>;
}

export function createEmptyMetadataRegistry(): MetadataRegistry {
  return {
    metrics: new Map(),
    relationships: new Map(),
    entityRelationships: new Map(),
    vqs: new Map(),
  };
}

/**
 * Build the metadata registry from the metrics, relationships, entity
 * relationships, and VQs declared anywhere in a project index. Each file is
 * validated against its kind's schema; duplicate names report both paths. An
 * index with blocking issues is refused.
 */
export function loadIndexedMetadataRegistry(index: ProjectIndex): MetadataRegistry {
  index = expandOssieIndex(index);
  assertValidProjectIndex(index);
  const files = (kind: ProjectFileKind) =>
    entriesOfKind(index, kind).map((entry) => ({
      filePath: entryFilePath(index, entry),
      doc: entry.document,
    }));
  return {
    metrics: parseEntities(files('metric'), MetricSpecSchema, 'metric'),
    relationships: parseEntities(files('relationship'), RelationshipSpecSchema, 'relationship'),
    entityRelationships: parseEntities(
      files('entity_relationship'),
      EntityRelationshipSpecSchema,
      'entity relationship'
    ),
    vqs: parseEntities(files('vq'), VqSpecSchema, 'VQ'),
  };
}

/**
 * Load metrics + relationships + VQs from the given directories. Model Spec
 * projects are not required to declare metadata entities, so a missing
 * directory yields an empty map. Project loaders read the project index with
 * `loadIndexedMetadataRegistry` instead.
 */
export async function loadMetadataRegistry(
  projectDir: string,
  dirs: { metricsDir: string; relationshipsDir: string; vqsDir: string }
): Promise<MetadataRegistry> {
  const [metrics, relationshipRegistries, vqs] = await Promise.all([
    loadMetricsDirectory(projectDir, dirs.metricsDir),
    loadRelationshipRegistries(projectDir, dirs.relationshipsDir),
    loadVqsDirectory(projectDir, dirs.vqsDir),
  ]);
  const { relationships, entityRelationships } = relationshipRegistries;
  return { metrics, relationships, entityRelationships, vqs };
}
