import type { PrimaryKeyCandidate, ProfileSampleRow } from '../types.js';

import { clampConfidence, normalizeName, roundRate, stringifyValue } from './utils.js';

export function inferPrimaryKeyCandidates(
  table: string,
  rows: ProfileSampleRow[],
  columnNames: string[]
): PrimaryKeyCandidate[] {
  if (rows.length === 0 || columnNames.length === 0) return [];

  const singleColumnCandidates = columnNames.map((column) =>
    scoreCandidate(table, rows, [column], columnNames)
  );
  const compositeCandidates = buildCompositeCandidates(table, rows, columnNames);

  return [...singleColumnCandidates, ...compositeCandidates]
    .filter((candidate) => candidate.confidence >= 0.45)
    .sort(
      (a, b) =>
        b.confidence - a.confidence || a.columns.join(',').localeCompare(b.columns.join(','))
    )
    .slice(0, 8);
}

function buildCompositeCandidates(
  table: string,
  rows: ProfileSampleRow[],
  columnNames: string[]
): PrimaryKeyCandidate[] {
  const idLike = columnNames.filter((column) => normalizeName(column).endsWith('_id'));
  const pool = idLike.length >= 2 ? idLike : columnNames.slice(0, 6);
  const candidates: PrimaryKeyCandidate[] = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const left = pool[i];
      const right = pool[j];
      if (!left || !right) continue;
      candidates.push(scoreCandidate(table, rows, [left, right], columnNames));
    }
  }
  return candidates;
}

function scoreCandidate(
  table: string,
  rows: ProfileSampleRow[],
  columns: string[],
  allColumns: string[]
): PrimaryKeyCandidate {
  const values = rows.map((row) => columns.map((column) => row[column]));
  const nonNullRows = values.filter((rowValues) =>
    rowValues.every((value) => value !== null && value !== undefined && value !== '')
  );
  const distinct = new Set(
    nonNullRows.map((rowValues) => rowValues.map(stringifyValue).join('\u001f'))
  );
  const nonNullRate = rows.length === 0 ? 0 : nonNullRows.length / rows.length;
  const uniqueness = nonNullRows.length === 0 ? 0 : distinct.size / nonNullRows.length;
  const firstColumn = columns[0];
  const nameBoost =
    columns.length === 1 && firstColumn
      ? primaryKeyNameBoost(table, firstColumn, allColumns)
      : 0.06;
  const confidence = clampConfidence(uniqueness * 0.58 + nonNullRate * 0.32 + nameBoost);

  return {
    columns,
    uniqueness: roundRate(uniqueness),
    confidence,
    recommendation:
      confidence >= 0.9 ? 'primary_key' : confidence >= 0.65 ? 'review' : 'not_recommended',
    evidence: {
      sampleSize: rows.length,
      nonNullRows: nonNullRows.length,
      nonNullRate: roundRate(nonNullRate),
      distinctRows: distinct.size,
      nameBoost: roundRate(nameBoost),
    },
  };
}

function primaryKeyNameBoost(table: string, column: string, allColumns: string[]): number {
  const normalizedColumn = normalizeName(column);
  const normalizedTable = normalizeName(table.split('.').at(-1) ?? table);
  const singularTable = normalizedTable.endsWith('s')
    ? normalizedTable.slice(0, -1)
    : normalizedTable;

  if (normalizedColumn === 'id') return 0.13;
  if (normalizedColumn === `${singularTable}_id` || normalizedColumn === `${normalizedTable}_id`) {
    return 0.12;
  }

  const otherStrongId = allColumns.some((candidate) => {
    const normalized = normalizeName(candidate);
    return (
      candidate !== column &&
      (normalized === 'id' ||
        normalized === `${singularTable}_id` ||
        normalized === `${normalizedTable}_id`)
    );
  });
  if (normalizedColumn.endsWith('_id') && !otherStrongId) return 0.07;
  if (normalizedColumn.endsWith('_id') && otherStrongId) return -0.08;
  return 0;
}
