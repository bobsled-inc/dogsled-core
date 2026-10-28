import type { ForeignKeyCandidate, ForeignKeyTarget, ProfileSampleRow } from '../types.js';

import { clampConfidence, normalizeName, roundRate, stringifyValue } from './utils.js';

export function inferForeignKeyCandidates(
  rows: ProfileSampleRow[],
  columnNames: string[],
  targets: ForeignKeyTarget[] = []
): ForeignKeyCandidate[] {
  const candidates: ForeignKeyCandidate[] = [];
  for (const column of columnNames) {
    const normalized = normalizeName(column);
    if (!normalized.endsWith('_id')) continue;

    const values = rows
      .map((row) => row[column])
      .filter((value) => value !== null && value !== undefined && value !== '');
    const nonNullRate = rows.length === 0 ? 0 : values.length / rows.length;

    if (targets.length === 0) {
      const guessedTable = normalized.slice(0, -3);
      candidates.push({
        from: column,
        toTable: guessedTable,
        toColumn: 'id',
        hitRate: 0,
        confidence: clampConfidence(0.32 + nonNullRate * 0.18),
        evidence: {
          signal: 'name_only',
          sampleSize: rows.length,
          nonNullRate: roundRate(nonNullRate),
        },
      });
      continue;
    }

    for (const target of targets) {
      const nameScore = fkNameScore(normalized, target);
      if (nameScore <= 0) continue;
      const targetValues = new Set(
        target.values
          .filter((value) => value !== null && value !== undefined && value !== '')
          .map(stringifyValue)
      );
      if (targetValues.size === 0) continue;
      const hits = values.filter((value) => targetValues.has(stringifyValue(value))).length;
      const hitRate = values.length === 0 ? 0 : hits / values.length;
      const uniqueness = target.uniqueness ?? 1;
      const confidence = clampConfidence(
        hitRate * 0.66 + nonNullRate * 0.16 + uniqueness * 0.12 + nameScore
      );
      if (confidence < 0.4) continue;
      candidates.push({
        from: column,
        toTable: target.table,
        toColumn: target.column,
        hitRate: roundRate(hitRate),
        confidence,
        evidence: {
          sampleSize: rows.length,
          nonNullValues: values.length,
          hits,
          nonNullRate: roundRate(nonNullRate),
          targetDistinctValues: targetValues.size,
          targetUniqueness: roundRate(uniqueness),
          nameScore: roundRate(nameScore),
        },
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from));
}

function fkNameScore(column: string, target: ForeignKeyTarget): number {
  const targetTable = normalizeName(target.table.split('.').at(-1) ?? target.table);
  const singularTable = singularizeTableName(targetTable);
  const targetColumn = normalizeName(target.column);
  if (
    column === `${singularTable}_${targetColumn}` ||
    column === `${targetTable}_${targetColumn}`
  ) {
    return 0.12;
  }
  if (column === `${singularTable}_id` || column === `${targetTable}_id`) return 0.1;
  if (column === targetColumn) return 0.06;
  if (column.endsWith(`_${targetColumn}`)) return 0.04;
  return 0;
}

function singularizeTableName(table: string): string {
  if (table.endsWith('ies') && table.length > 3) {
    return `${table.slice(0, -3)}y`;
  }
  if (
    table.endsWith('ses') ||
    table.endsWith('xes') ||
    table.endsWith('zes') ||
    table.endsWith('ches') ||
    table.endsWith('shes')
  ) {
    return table.slice(0, -2);
  }
  if (table.endsWith('s') && !table.endsWith('ss')) {
    return table.slice(0, -1);
  }
  return table;
}
