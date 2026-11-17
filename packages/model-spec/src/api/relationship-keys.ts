import {
  entriesOfKind,
  ProjectIndexError,
  type ProjectIndex,
  type ProjectIndexEntry,
} from '@bobsled-inc/project-index';

import { AgenticModelSpecSchema, getModelOutputColumns } from '../agentic/model.js';
import { SourceSpecSchema, TransformSpecSchema } from '../compiler/schemas.js';
import {
  datasetPrimaryKey,
  relationshipKeyWarnings,
  type RelationshipKeyWarning,
} from '../entities/relationship-keys.js';
import { RelationshipSpecSchema } from '../entities/relationship.js';
import { CommandError } from '../errors.js';
import { expandOssieIndex } from '../ossie/index.js';

export interface IndexedRelationshipKeyWarning extends RelationshipKeyWarning {
  /** Project-relative path of the file that declares the relationship. */
  path: string;
}

function withOssieDefinitions(index: ProjectIndex): ProjectIndex {
  if (!index.entries.some((entry) => entry.kind === 'ossie')) return index;
  try {
    return expandOssieIndex(index);
  } catch (error) {
    if (error instanceof CommandError || error instanceof ProjectIndexError) return index;
    throw error;
  }
}

function entryPrimaryKey(entry: ProjectIndexEntry): string[] | undefined {
  if (entry.kind === 'source') {
    const source = SourceSpecSchema.safeParse(entry.document);
    return source.success ? datasetPrimaryKey(source.data, source.data.schema.columns) : undefined;
  }
  const agentic =
    entry.document !== null &&
    typeof entry.document === 'object' &&
    (entry.document as Record<string, unknown>)['model_kind'] === 'agentic';
  const model = agentic
    ? AgenticModelSpecSchema.safeParse(entry.document)
    : TransformSpecSchema.safeParse(entry.document);
  return model.success
    ? datasetPrimaryKey(model.data, getModelOutputColumns(model.data))
    : undefined;
}

function datasetReference(entry: ProjectIndexEntry): string | undefined {
  const document = entry.document;
  if (document === null || typeof document !== 'object') return undefined;
  const { name, connection } = document as { name?: unknown; connection?: unknown };
  if (typeof name !== 'string') return undefined;
  if (entry.kind === 'model') return name.toLowerCase();
  return typeof connection === 'string' ? `${connection}.${name}`.toLowerCase() : undefined;
}

/**
 * Relationship key warnings for every relationship in a project index. Files
 * that do not parse, and datasets that do not resolve to exactly one source or
 * model, are skipped: the project loaders report those problems.
 */
export function indexedRelationshipKeyWarnings(
  projectIndex: ProjectIndex
): IndexedRelationshipKeyWarning[] {
  const index = withOssieDefinitions(projectIndex);
  const relationships = entriesOfKind(index, 'relationship');
  if (!relationships.length) return [];

  const datasets = new Map<string, ProjectIndexEntry[]>();
  for (const entry of [...entriesOfKind(index, 'source'), ...entriesOfKind(index, 'model')]) {
    const reference = datasetReference(entry);
    if (reference === undefined) continue;
    datasets.set(reference, [...(datasets.get(reference) ?? []), entry]);
  }
  const keys = new Map<string, string[] | undefined>();
  const primaryKeyOf = (dataset: string): string[] | undefined => {
    const reference = dataset.toLowerCase();
    if (!keys.has(reference)) {
      const matches = datasets.get(reference) ?? [];
      keys.set(reference, matches.length === 1 ? entryPrimaryKey(matches[0]!) : undefined);
    }
    return keys.get(reference);
  };

  return relationships.flatMap((entry) => {
    const relationship = RelationshipSpecSchema.safeParse(entry.document);
    if (!relationship.success) return [];
    return relationshipKeyWarnings(relationship.data, primaryKeyOf).map((warning) => ({
      ...warning,
      path: entry.path,
    }));
  });
}
