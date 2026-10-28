import * as path from 'node:path';
import { existsSync } from 'node:fs';

import {
  assertCompleteProjectIndex,
  entriesOfKind,
  entryFilePath,
  scanProject,
  type ProjectIndex,
} from '@bobsled-inc/project-index';

import { ossieEditRecords } from './ossie.js';

import type { EditOptions, EditResult } from './types.js';

export type EditableSpecType = 'source' | 'model' | 'metric' | 'relationship' | 'vq';

type RecordFilter = (record: Record<string, unknown>) => boolean;

const FOLDER_OVERRIDES = {
  source: 'sourcesDir',
  model: 'modelsDir',
  metric: 'metricsDir',
  relationship: 'relationshipsDir',
  vq: 'vqsDir',
} as const satisfies Record<EditableSpecType, keyof EditOptions>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchesSpec(
  record: Record<string, unknown>,
  target: string,
  entityType: string,
  extra?: RecordFilter
): boolean {
  if (String(record.name ?? '').toLowerCase() !== target) return false;
  if (entityType && record.type !== entityType) return false;
  return extra ? extra(record) : true;
}

function singleMatch(
  matches: readonly string[],
  entityName: string,
  entityType: string,
  searched: string
): EditResult<string> {
  if (matches.length === 1) return { ok: true, data: matches[0]! };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Multiple ${entityType} specs named "${entityName}" found:\n${matches.map((m) => `  - ${m}`).join('\n')}`,
    };
  }
  return { ok: false, error: `No ${entityType} spec named "${entityName}" found ${searched}` };
}

function findByName(
  dir: string,
  entityName: string,
  entityType: EditableSpecType,
  extra?: RecordFilter
): EditResult<string> {
  if (!existsSync(dir)) return singleMatch([], entityName, entityType, `under ${dir}`);
  try {
    const index = scanProject(dir);
    assertCompleteProjectIndex(index);
    return findIndexedByName(index, entityName, entityType, extra, `under ${dir}`);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function findIndexedByName(
  index: ProjectIndex,
  entityName: string,
  entityType: EditableSpecType,
  extra?: RecordFilter,
  searched = 'in the project'
): EditResult<string> {
  const target = entityName.toLowerCase();
  const matches = [...entriesOfKind(index, entityType), ...entriesOfKind(index, 'ossie')]
    .filter((entry) => {
      const record = asRecord(entry.document);
      return (
        record !== undefined &&
        [record, ...ossieEditRecords(record)].some((candidate) =>
          matchesSpec(candidate, target, entityType, extra)
        )
      );
    })
    .map((entry) => entryFilePath(index, entry));
  return singleMatch(matches, entityName, entityType, searched);
}

/**
 * The file of the spec an edit targets. An explicit folder override
 * (`sourcesDir`, `modelsDir`, …) limits the search to that folder; otherwise
 * the spec is found by its declared type and name anywhere in the project.
 * Problems in other project files do not block the edit, but a scan that
 * stopped at a limit does, since the spec could lie past it.
 */
export function findEditTarget(
  opts: EditOptions,
  entityType: EditableSpecType,
  entityName: string,
  extra?: RecordFilter
): EditResult<string> {
  const folder = opts[FOLDER_OVERRIDES[entityType]];
  if (folder !== undefined) {
    return findByName(path.resolve(opts.projectDir, folder), entityName, entityType, extra);
  }
  let index: ProjectIndex;
  try {
    index = scanProject(opts.projectDir);
    assertCompleteProjectIndex(index);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return findIndexedByName(index, entityName, entityType, extra);
}

export function findSourceFile(
  sourcesDir: string,
  sourceName: string,
  connection?: string
): EditResult<string> {
  return findByName(sourcesDir, sourceName, 'source', (record) =>
    connection === undefined ? true : record.connection === connection
  );
}

export function findModelFile(modelsDir: string, modelName: string): EditResult<string> {
  return findByName(modelsDir, modelName, 'model');
}

export function findMetadataFile(
  entityDir: string,
  entityName: string,
  entityType: 'metric' | 'relationship' | 'vq'
): EditResult<string> {
  return findByName(path.resolve(entityDir), entityName, entityType);
}
