import { CommandError } from '../errors.js';

import { detectAnomalies } from './inferences/anomaly.js';
import { inferForeignKeyCandidates } from './inferences/fk.js';
import { inferFormat } from './inferences/format.js';
import { inferPrimaryKeyCandidates } from './inferences/pk.js';
import { inferSemanticRole } from './inferences/semantic.js';
import { inferType } from './inferences/types.js';
import { roundRate, stringifyValue } from './inferences/utils.js';
import { suggestCleaning } from './proposals/cleaning.js';
import { buildRowCountSql, buildSampleSql } from './sql.js';

import type { SqlQueryRunner } from '../compiler/index.js';
import type { SupportedDialect } from '../compiler/dialect.js';
import type {
  ForeignKeyTarget,
  ProfileBuildInput,
  ProfileColumn,
  ProfileColumnInput,
  ProfileHistogramBucket,
  ProfileReport,
  ProfileSampleRow,
} from './types.js';

export interface ProfileTableOptions {
  table: string;
  dialect: SupportedDialect;
  sampleSize?: number;
  confidenceMin?: number;
  columns?: ProfileColumnInput[];
  foreignKeyTargets?: ForeignKeyTarget[];
}

export async function profileTable(
  query: SqlQueryRunner,
  options: ProfileTableOptions
): Promise<ProfileReport> {
  const sampleSize = options.sampleSize ?? 500;
  const countRows = await query(buildRowCountSql(options.table, options.dialect));
  const rowCount = extractRowCount(countRows);
  const rows = await query(buildSampleSql(options.table, options.dialect, sampleSize));
  const report = buildProfileReport({
    table: options.table,
    rowCount,
    rows,
    columns: options.columns,
    foreignKeyTargets: options.foreignKeyTargets,
  });
  return options.confidenceMin === undefined
    ? report
    : filterProfileReport(report, options.confidenceMin);
}

export function buildProfileReport(input: ProfileBuildInput): ProfileReport {
  const columns = resolveColumns(input.rows, input.columns);
  const profileColumns = columns.map((column) =>
    profileColumn(
      column,
      input.rows.map((row) => row[column.name])
    )
  );

  const report: ProfileReport = {
    table: input.table,
    rowCount: input.rowCount,
    sampleSize: input.rows.length,
    columns: profileColumns,
    pkCandidates: inferPrimaryKeyCandidates(
      input.table,
      input.rows,
      profileColumns.map((column) => column.name)
    ),
    fkCandidates: inferForeignKeyCandidates(
      input.rows,
      profileColumns.map((column) => column.name),
      input.foreignKeyTargets
    ),
    cleaningSuggestions: suggestCleaning({
      columns: profileColumns.map((column) => ({
        name: column.name,
        values: input.rows.map((row) => row[column.name]),
      })),
    }),
  };

  return report;
}

export function filterProfileReport(report: ProfileReport, confidenceMin: number): ProfileReport {
  if (!Number.isFinite(confidenceMin) || confidenceMin < 0 || confidenceMin > 1) {
    throw new CommandError('--confidence-min must be between 0 and 1.', 2);
  }
  return {
    ...report,
    columns: report.columns.map((column) => ({
      ...column,
      typeInference:
        column.typeInference && column.typeInference.confidence >= confidenceMin
          ? column.typeInference
          : null,
      formatInference:
        column.formatInference && column.formatInference.confidence >= confidenceMin
          ? column.formatInference
          : null,
      semanticRoleInference:
        column.semanticRoleInference && column.semanticRoleInference.confidence >= confidenceMin
          ? column.semanticRoleInference
          : null,
    })),
    pkCandidates: report.pkCandidates.filter((candidate) => candidate.confidence >= confidenceMin),
    fkCandidates: report.fkCandidates.filter((candidate) => candidate.confidence >= confidenceMin),
    cleaningSuggestions: report.cleaningSuggestions.filter(
      (suggestion) => suggestion.confidence >= confidenceMin
    ),
  };
}

function profileColumn(column: Required<ProfileColumnInput>, values: unknown[]): ProfileColumn {
  const nonNull = values.filter((value) => value !== null && value !== undefined);
  const distinctValues = new Set(nonNull.map(stringifyValue));
  const typeInference = inferType(values, column.dataType);
  const formatInference = inferFormat(values);
  const semanticRoleInference = inferSemanticRole({
    columnName: column.name,
    typeKind: typeInference.kind,
    formatKind: formatInference.kind,
    distinctRate: nonNull.length === 0 ? 0 : distinctValues.size / nonNull.length,
  });

  return {
    name: column.name,
    dataType: column.dataType,
    nullRate: roundRate(values.length === 0 ? 0 : (values.length - nonNull.length) / values.length),
    distinctCount: distinctValues.size,
    distinctRate: roundRate(nonNull.length === 0 ? 0 : distinctValues.size / nonNull.length),
    valueDistribution: buildHistogram(values),
    typeInference,
    formatInference,
    semanticRoleInference,
    anomalies: detectAnomalies({ values, typeInference }),
  };
}

function resolveColumns(
  rows: ProfileSampleRow[],
  providedColumns: ProfileColumnInput[] | undefined
): Array<Required<ProfileColumnInput>> {
  const byName = new Map<string, Required<ProfileColumnInput>>();
  for (const column of providedColumns ?? []) {
    byName.set(column.name, { name: column.name, dataType: column.dataType ?? 'UNKNOWN' });
  }
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!byName.has(name)) {
        byName.set(name, { name, dataType: inferDataTypeFromRows(rows, name) });
      }
    }
  }
  return [...byName.values()];
}

function inferDataTypeFromRows(rows: ProfileSampleRow[], column: string): string {
  const first = rows.find((row) => row[column] !== null && row[column] !== undefined)?.[column];
  if (first === undefined) return 'UNKNOWN';
  if (first instanceof Date) return 'TIMESTAMP';
  if (Array.isArray(first)) return 'ARRAY';
  switch (typeof first) {
    case 'bigint':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    case 'number':
      return Number.isInteger(first) ? 'INTEGER' : 'NUMBER';
    case 'object':
      return 'OBJECT';
    default:
      return 'VARCHAR';
  }
}

function buildHistogram(values: unknown[]): ProfileHistogramBucket[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = stringifyValue(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([value, count]) => ({
      value,
      count,
      rate: roundRate(values.length === 0 ? 0 : count / values.length),
    }));
}

function extractRowCount(rows: ProfileSampleRow[]): number {
  const first = rows[0];
  if (!first) return 0;
  const raw =
    first['row_count'] ??
    first['ROW_COUNT'] ??
    first['count'] ??
    first['COUNT'] ??
    Object.values(first)[0];
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CommandError('Row count out of safe range.', 1);
    }
    return Number(raw);
  }
  if (typeof raw === 'number') {
    if (raw < 0 || !Number.isSafeInteger(raw)) {
      throw new CommandError('Row count must be a safe non-negative integer.', 1);
    }
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new CommandError('Row count out of safe range.', 1);
    }
    return parsed;
  }
  throw new CommandError('Profiler runner returned an unreadable COUNT(*) result.', 1);
}
