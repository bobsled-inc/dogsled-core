import {
  buildFqName,
  getCanonicalDialect,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SqlQueryRow, SupportedDialect } from '@bobsled-inc/model-spec';
import { generateAuditInsertSql } from '../audit/codegen.js';
import { outputTableName } from '../output-tables/index.js';
import { castToString, concatSql } from './sql.js';
import type { ResolvedInput, ResolvedResolutionSpec, SqlStatement } from './types.js';

export type ResolveWatermarkKind = 'loaded_at' | 'content_fingerprint' | 'full_refresh_only';
export type ResolveRunMode = 'full' | 'incremental';

export interface ResolveStateSourceDefinition {
  sourceRef: string;
  fqTableName: string;
  watermarkKind: ResolveWatermarkKind;
  watermarkColumn?: string;
  sourceColumns?: string[];
}

export interface ResolveStateRow {
  source_ref: string;
  watermark_kind: ResolveWatermarkKind;
  watermark_value: string | null;
  spec_fingerprint: string;
  run_id: string;
  updated_at?: string | null;
}

export interface ResolutionIncrementalSourcePlan extends ResolveStateSourceDefinition {
  previousWatermarkValue?: string | null;
}

export interface ResolutionIncrementalOptions {
  runId: string;
  specFingerprint: string;
  modeReason: string;
  sources: ResolutionIncrementalSourcePlan[];
}

export interface IncrementalPredicateDedupOptions {
  existingStandardizedTable: string;
  recordIdExpr: string;
}

const LOADED_AT_NAMES = ['loaded_at', '_loaded_at', '_sh_loaded_at', 'updated_at'];

function metadataLookup(input: ResolvedInput, column: string) {
  return input.sourceFieldMetadata?.[column] ?? input.sourceFieldMetadata?.[column.toLowerCase()];
}

function findColumnCaseInsensitive(
  input: ResolvedInput,
  candidates: readonly string[]
): string | undefined {
  const sourceColumns = input.sourceColumns ?? [];
  const lookup = new Map(sourceColumns.map((column) => [column.toLowerCase(), column]));
  for (const candidate of candidates) {
    const found = lookup.get(candidate.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

function inferLoadedAtColumn(input: ResolvedInput): string | undefined {
  const sourceColumns = input.sourceColumns ?? Object.keys(input.sourceFieldMetadata ?? {});
  for (const column of sourceColumns) {
    const metadata = metadataLookup(input, column);
    if (
      metadata?.semantic_role === 'extraction_timestamp' &&
      (metadata.type === 'timestamp' || metadata.type === 'date')
    ) {
      return column;
    }
  }
  return findColumnCaseInsensitive(input, LOADED_AT_NAMES);
}

export function resolveStateSourceDefinitions(
  spec: ResolvedResolutionSpec
): ResolveStateSourceDefinition[] {
  return spec.inputs.map((input) => {
    const watermarkColumn = inferLoadedAtColumn(input);
    if (watermarkColumn) {
      return {
        sourceRef: input.ref,
        fqTableName: input.fqTableName,
        watermarkKind: 'loaded_at',
        watermarkColumn,
        sourceColumns: input.sourceColumns,
      };
    }
    if (input.sourceColumns && input.sourceColumns.length > 0) {
      return {
        sourceRef: input.ref,
        fqTableName: input.fqTableName,
        watermarkKind: 'content_fingerprint',
        sourceColumns: input.sourceColumns,
      };
    }
    return {
      sourceRef: input.ref,
      fqTableName: input.fqTableName,
      watermarkKind: 'full_refresh_only',
      sourceColumns: input.sourceColumns,
    };
  });
}

function rowContentExpr(
  sourceColumns: readonly string[],
  alias: string,
  dialect: SupportedDialect
): string {
  const pieces = sourceColumns.flatMap((column) => [
    quoteLiteral(`${column}=`, dialect),
    `COALESCE(${castToString(`${alias}.${quoteIdentifier(column, dialect)}`, dialect)}, ${quoteLiteral('<null>', dialect)})`,
    quoteLiteral('\u001f', dialect),
  ]);
  return concatSql(pieces, dialect);
}

function rowHash64Expr(
  source: Pick<ResolveStateSourceDefinition, 'sourceColumns'>,
  alias: string,
  dialect: SupportedDialect
): string {
  const sourceColumns = source.sourceColumns ?? [];
  if (sourceColumns.length === 0) return '0';

  switch (dialect) {
    case 'snowflake':
      return `HASH(${sourceColumns.map((column) => `${alias}.${quoteIdentifier(column, dialect)}`).join(', ')})`;
    case 'bigquery': {
      const structFields = sourceColumns
        .map(
          (column) =>
            `${alias}.${quoteIdentifier(column, dialect)} AS ${quoteIdentifier(column, dialect)}`
        )
        .join(', ');
      return `CAST(FARM_FINGERPRINT(TO_JSON_STRING(STRUCT(${structFields}))) AS BIGNUMERIC)`;
    }
    case 'postgres':
    case 'pgvector':
      return `(('x' || SUBSTR(MD5(${rowContentExpr(sourceColumns, alias, dialect)}), 1, 16))::bit(64)::bigint)::DECIMAL(38,0)`;
    case 'duckdb':
      return `CAST(hash(${sourceColumns.map((column) => `${alias}.${quoteIdentifier(column, dialect)}`).join(', ')}) AS DECIMAL(38,0))`;
    case 'databricks':
      return `CAST(xxhash64(${sourceColumns.map((column) => `${alias}.${quoteIdentifier(column, dialect)}`).join(', ')}) AS DECIMAL(38,0))`;
    case 'redshift':
      return `CAST(FNV_HASH(${rowContentExpr(sourceColumns, alias, dialect)}) AS DECIMAL(38,0))`;
    case 'mysql':
      return `CAST(CONV(LEFT(SHA2(${rowContentExpr(sourceColumns, alias, dialect)}, 256), 16), 16, 10) AS DECIMAL(38,0))`;
    case 'clickhouse':
      return `CAST(xxHash64(${sourceColumns.map((column) => `${alias}.${quoteIdentifier(column, dialect)}`).join(', ')}) AS DECIMAL(38,0))`;
  }
}

function decimalType(dialect: SupportedDialect): string {
  return dialect === 'bigquery' ? 'BIGNUMERIC' : 'DECIMAL(38,0)';
}

export function sourceWatermarkValueExpr(
  source: ResolveStateSourceDefinition,
  dialect: SupportedDialect
): string {
  const alias = quoteIdentifier('src', dialect);
  if (source.watermarkKind === 'loaded_at') {
    const column = source.watermarkColumn ?? 'loaded_at';
    return [
      `(SELECT`,
      `  ${castToString(`MAX(${alias}.${quoteIdentifier(column, dialect)})`, dialect)}`,
      `FROM ${source.fqTableName} AS ${alias})`,
    ].join('\n');
  }
  if (source.watermarkKind === 'content_fingerprint') {
    const rowHash = rowHash64Expr(source, alias, dialect);
    const aggregate = `COALESCE(SUM(CAST(${rowHash} AS ${decimalType(dialect)})), CAST(0 AS ${decimalType(dialect)}))`;
    return [
      `(SELECT`,
      `  ${castToString(aggregate, dialect)}`,
      `FROM ${source.fqTableName} AS ${alias})`,
    ].join('\n');
  }
  return quoteLiteral('full_refresh_only', dialect);
}

export function buildSourceWatermarkQuery(
  source: ResolveStateSourceDefinition,
  dialect: SupportedDialect
): string {
  return [
    `SELECT`,
    `  ${quoteLiteral(source.sourceRef, dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
    `  ${quoteLiteral(source.watermarkKind, dialect)} AS ${quoteIdentifier('watermark_kind', dialect)},`,
    `  ${sourceWatermarkValueExpr(source, dialect)} AS ${quoteIdentifier('watermark_value', dialect)}`,
  ].join('\n');
}

export function buildResolveStateSelectQuery(
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect
): string {
  const stateTable = buildFqName(targetSchema, outputTableName(entity, '__resolve_state'), dialect);
  return [
    `SELECT`,
    `  ${quoteIdentifier('source_ref', dialect)},`,
    `  ${quoteIdentifier('watermark_kind', dialect)},`,
    `  ${quoteIdentifier('watermark_value', dialect)},`,
    `  ${quoteIdentifier('spec_fingerprint', dialect)},`,
    `  ${quoteIdentifier('run_id', dialect)},`,
    `  ${quoteIdentifier('updated_at', dialect)}`,
    `FROM ${stateTable}`,
  ].join('\n');
}

function normalizeKind(value: unknown): ResolveWatermarkKind | null {
  return value === 'loaded_at' || value === 'content_fingerprint' || value === 'full_refresh_only'
    ? value
    : null;
}

export function normalizeResolveStateRows(rows: readonly SqlQueryRow[]): ResolveStateRow[] {
  return rows.flatMap((row) => {
    const normalized = new Map(
      Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
    );
    const sourceRef = normalized.get('source_ref');
    const kind = normalizeKind(normalized.get('watermark_kind'));
    const specFingerprint = normalized.get('spec_fingerprint');
    const runId = normalized.get('run_id');
    if (
      typeof sourceRef !== 'string' ||
      kind == null ||
      typeof specFingerprint !== 'string' ||
      typeof runId !== 'string'
    ) {
      return [];
    }
    const watermarkValue = normalized.get('watermark_value');
    const updatedAt = normalized.get('updated_at');
    return [
      {
        source_ref: sourceRef,
        watermark_kind: kind,
        watermark_value: watermarkValue == null ? null : String(watermarkValue),
        spec_fingerprint: specFingerprint,
        run_id: runId,
        updated_at: updatedAt == null ? null : String(updatedAt),
      },
    ];
  });
}

function stateTableName(entity: string, targetSchema: string, dialect: SupportedDialect): string {
  return buildFqName(targetSchema, outputTableName(entity, '__resolve_state'), dialect);
}

export function generateResolveStateDeleteSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const stateTable = stateTableName(spec.entity, targetSchema, dialect);
  const sourceRefs = spec.inputs.map((input) => quoteLiteral(input.ref, dialect)).join(', ');
  return {
    name: 'delete_resolve_state',
    sql: `DELETE FROM ${stateTable}\nWHERE ${quoteIdentifier('source_ref', dialect)} IN (${sourceRefs})`,
    tableCreated: outputTableName(spec.entity, '__resolve_state'),
  };
}

export function generateResolveStateInsertSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  options: {
    runId: string;
    specFingerprint: string;
    sources?: ResolveStateSourceDefinition[];
    /**
     * Watermark values captured at plan time (before the delta scan), keyed by
     * source_ref. When present the recorded watermark is this literal instead of
     * a live subquery re-evaluated after the pipeline. Recomputing at the end is
     * a TOCTOU race: a row committed to the source between the delta scan and the
     * state write would raise the end-of-run MAX/fingerprint above rows that were
     * never processed, so the next --incremental run skips them forever.
     * Recording the pre-scan value instead yields at-least-once semantics (any
     * rows in the race window are re-scanned next run and deduped idempotently).
     */
    capturedWatermarkValues?: ReadonlyMap<string, string | null>;
  }
): SqlStatement {
  const stateTable = stateTableName(spec.entity, targetSchema, dialect);
  const sources = options.sources ?? resolveStateSourceDefinitions(spec);
  const captured = options.capturedWatermarkValues;
  const rows = sources.map((source) => {
    const hasCaptured = captured?.has(source.sourceRef) ?? false;
    const capturedValue = captured?.get(source.sourceRef) ?? null;
    const watermarkValueSql = hasCaptured
      ? capturedValue === null
        ? 'NULL'
        : quoteLiteral(capturedValue, dialect)
      : sourceWatermarkValueExpr(source, dialect);
    return [
      `SELECT`,
      `  ${quoteLiteral(source.sourceRef, dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
      `  ${quoteLiteral(source.watermarkKind, dialect)} AS ${quoteIdentifier('watermark_kind', dialect)},`,
      `  ${watermarkValueSql} AS ${quoteIdentifier('watermark_value', dialect)},`,
      `  ${quoteLiteral(options.specFingerprint, dialect)} AS ${quoteIdentifier('spec_fingerprint', dialect)},`,
      `  ${quoteLiteral(options.runId, dialect)} AS ${quoteIdentifier('run_id', dialect)},`,
      `  CURRENT_TIMESTAMP AS ${quoteIdentifier('updated_at', dialect)}`,
    ].join('\n');
  });
  return {
    name: 'insert_resolve_state',
    sql: [
      `INSERT INTO ${stateTable} (`,
      `  ${quoteIdentifier('source_ref', dialect)},`,
      `  ${quoteIdentifier('watermark_kind', dialect)},`,
      `  ${quoteIdentifier('watermark_value', dialect)},`,
      `  ${quoteIdentifier('spec_fingerprint', dialect)},`,
      `  ${quoteIdentifier('run_id', dialect)},`,
      `  ${quoteIdentifier('updated_at', dialect)}`,
      `)`,
      rows.join('\nUNION ALL\n'),
    ].join('\n'),
    tableCreated: outputTableName(spec.entity, '__resolve_state'),
  };
}

export function generateResolveRunAuditSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  options: {
    runId: string;
    specFingerprint: string;
    mode: ResolveRunMode;
    modeReason: string;
    sourceCount: number;
  }
): SqlStatement {
  return generateAuditInsertSql({
    name: 'audit_incremental_run',
    dialect,
    category: 'mutation',
    subjectType: 'resolution',
    subjectId: spec.entity,
    payload: {
      kind: 'incremental_run',
      entity: spec.entity,
      mode: options.mode,
      mode_reason: options.modeReason,
      source_count: options.sourceCount,
      spec_fingerprint: options.specFingerprint,
    },
    reason: options.modeReason,
    actor: 'system',
    actorType: 'system',
    eventIdDiscriminator: options.runId,
  });
}

export function incrementalSourcePredicate(
  source: ResolutionIncrementalSourcePlan,
  sourceAlias: string,
  dialect: SupportedDialect,
  dedup?: IncrementalPredicateDedupOptions
): string {
  if (source.watermarkKind !== 'loaded_at') return '1 = 0';
  if (!source.watermarkColumn || !source.previousWatermarkValue) return '1 = 1';
  const value = quoteLiteral(source.previousWatermarkValue, dialect);
  const column = `${sourceAlias}.${quoteIdentifier(source.watermarkColumn, dialect)}`;
  const canonical = getCanonicalDialect(dialect);
  const casted =
    canonical === 'mysql'
      ? `CAST(${value} AS DATETIME)`
      : canonical === 'bigquery'
        ? `TIMESTAMP(${value})`
        : `CAST(${value} AS TIMESTAMP)`;
  if (!dedup) return `${column} >= ${casted}`;

  const existingAlias = quoteIdentifier('existing_standardized', dialect);
  return [
    `(`,
    `  ${column} > ${casted}`,
    `  OR (`,
    `    ${column} = ${casted}`,
    `    AND NOT EXISTS (`,
    `      SELECT 1`,
    `      FROM ${dedup.existingStandardizedTable} AS ${existingAlias}`,
    `      WHERE ${existingAlias}.${quoteIdentifier('record_id', dialect)} = ${dedup.recordIdExpr}`,
    `    )`,
    `  )`,
    `)`,
  ].join('\n');
}
