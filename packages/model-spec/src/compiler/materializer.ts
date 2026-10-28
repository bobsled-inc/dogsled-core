/**
 * Materializer -- wraps SELECT SQL in DDL based on materialization type and dialect.
 */

import {
  buildFqName,
  buildFqNameWithDatabase,
  caseName,
  getCanonicalDialect,
  quoteIdentifier,
  supportsDialectCapability,
} from './dialect.js';
import { CommandError } from '../errors.js';

export {
  generateUnprocessedRowsSql,
  generateProcessedKeyReplacementSql,
  generateStageReplacementDml,
} from './materializer-processed-keys.js';
export type { ProcessedKeySqlOptions } from './materializer-processed-keys.js';

import type { SupportedDialect } from './dialect.js';
import type { ResolvedTransformSpec } from './parser.js';
import type { SelectStateColumn } from './state.js';

export type Decision =
  | { kind: 'proceed' }
  | {
      kind: 'recreate';
      preDdl: string[];
      /**
       * Structured list of changes that triggered the recreate. Populated by
       * `planConfigDrift` so the caller can surface the field-level diff on
       * `RunProjectResult.warnings` (and via `opts.onWarn`) without having to
       * scrape it back out of the leading SQL comment. Omitted by other
       * `recreate` producers (`planTransition`) whose trigger is already
       * obvious from the materialization-type change itself.
       */
      changes?: string[];
    }
  | { kind: 'full_refresh' }
  | { kind: 'fail'; message: string; exitCode: 3 };

type PhysicalMaterialization =
  | 'view'
  | 'table'
  | 'dynamic_table'
  | 'materialized_view'
  | 'snapshot';

export interface MaterializeSqlOptions {
  isFirstRun?: boolean;
  defaultDynamicTableWarehouse?: string;
}

export function materializeSql(
  selectSql: string,
  spec: ResolvedTransformSpec,
  targetSchema: string,
  dialect: SupportedDialect,
  options?: MaterializeSqlOptions,
  targetDatabase?: string
): string[] {
  const fqName = targetDatabase
    ? buildFqNameWithDatabase(targetSchema, spec.name, dialect, targetDatabase)
    : buildFqName(targetSchema, spec.name, dialect);
  const isFirstRun = options?.isFirstRun ?? false;

  validateMaterializationSupport(spec, dialect);

  // Expand hooks
  const hookContext = { schema: targetSchema, name: spec.name };
  const preHooks = (spec.preHook ?? []).map((h) => expandHookTemplate(h, hookContext));
  const postHooks = (spec.postHook ?? []).map((h) => expandHookTemplate(h, hookContext));

  let ddl: string[];

  switch (spec.materialization) {
    case 'view':
      ddl = [`CREATE OR REPLACE VIEW ${fqName}${copyGrantsClause(dialect)} AS (\n${selectSql}\n);`];
      break;

    case 'table':
      ddl = generateTableDdl(fqName, spec.name, selectSql, dialect);
      break;

    case 'incremental':
      ddl = isFirstRun
        ? generateTableDdl(fqName, spec.name, selectSql, dialect)
        : generateIncrementalDdl(fqName, selectSql, spec, dialect);
      break;

    case 'ephemeral':
      return []; // No DDL for ephemeral models

    case 'dynamic_table':
      ddl = generateDynamicTableDdl(
        fqName,
        selectSql,
        spec,
        dialect,
        options?.defaultDynamicTableWarehouse
      );
      break;

    case 'materialized_view':
      ddl = generateMaterializedViewDdl(fqName, selectSql, spec, dialect);
      break;

    case 'snapshot':
      ddl = isFirstRun
        ? generateSnapshotFirstRunDdl(fqName, selectSql, spec, dialect)
        : generateSnapshotMergeDdl(fqName, selectSql, spec, dialect);
      break;
  }

  return [...preHooks, ...ddl, ...postHooks];
}

export function planTransition(
  previousMaterialization: string | undefined,
  nextMaterialization: string,
  dialect: SupportedDialect,
  fqName: string,
  modelName = fqName
): Decision {
  if (!previousMaterialization || previousMaterialization === nextMaterialization) {
    return { kind: 'proceed' };
  }

  if (isViewTableTransition(previousMaterialization, nextMaterialization)) {
    const priorType = previousMaterialization === 'view' ? 'VIEW' : 'TABLE';
    return { kind: 'recreate', preDdl: [`DROP ${priorType} IF EXISTS ${fqName};`] };
  }

  return {
    kind: 'fail',
    exitCode: 3,
    message: [
      `Materialization type for model \`${modelName}\` changed from \`${previousMaterialization}\` to \`${nextMaterialization}\`.`,
      'This transition could lose data or history and must be performed explicitly.',
      '',
      'To migrate:',
      `  ${dropStatementForMaterialization(previousMaterialization, fqName)}`,
      `  -- then re-run: dogsled model run ${modelName}`,
      '',
      `Dialect: ${getCanonicalDialect(dialect)}`,
    ].join('\n'),
  };
}

export function dropStatementForMaterialization(materialization: string, fqName: string): string {
  switch (materialization) {
    case 'view':
      return `DROP VIEW IF EXISTS ${fqName};`;
    case 'materialized_view':
      return `DROP MATERIALIZED VIEW IF EXISTS ${fqName};`;
    case 'dynamic_table':
      return `DROP DYNAMIC TABLE IF EXISTS ${fqName};`;
    case 'table':
    case 'incremental':
    case 'snapshot':
    default:
      return `DROP TABLE IF EXISTS ${fqName};`;
  }
}

export function planSchemaChange(
  modelName: string,
  previousSignature: string | undefined,
  nextSignature: string,
  previousColumns: SelectStateColumn[] | undefined,
  nextColumns: SelectStateColumn[],
  mode: 'fail' | 'full_refresh',
  allowFullRefreshHint = true
): Decision {
  if (!previousSignature || previousSignature === nextSignature) {
    return { kind: 'proceed' };
  }
  if (mode === 'full_refresh') {
    return { kind: 'full_refresh' };
  }
  const remediations = [
    `  - rebuild the table:  dogsled model run ${modelName} --full-refresh`,
    ...(allowFullRefreshHint
      ? [`  - opt into auto-rebuild:  set \`on_schema_change: full_refresh\` in ${modelName}.yml`]
      : []),
  ];
  return {
    kind: 'fail',
    exitCode: 3,
    message: [
      `Schema drift detected for model \`${modelName}\`.`,
      '',
      'Changes:',
      ...formatColumnDiff(previousColumns ?? [], nextColumns),
      '',
      'To proceed, either:',
      ...remediations,
    ].join('\n'),
  };
}

function isViewTableTransition(
  previousMaterialization: string,
  nextMaterialization: string
): boolean {
  return (
    (previousMaterialization === 'view' && nextMaterialization === 'table') ||
    (previousMaterialization === 'table' && nextMaterialization === 'view')
  );
}

function generateTableDdl(
  fqName: string,
  modelName: string,
  selectSql: string,
  dialect: SupportedDialect
): string[] {
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
    case 'bigquery':
    case 'databricks':
    case 'duckdb':
      return [
        `CREATE OR REPLACE TABLE ${fqName}${copyGrantsClause(dialect)} AS (\n${selectSql}\n);`,
      ];
    case 'postgres':
      return generatePostgresTableSwapDdl(fqName, modelName, selectSql, dialect);
    case 'mysql':
      return [`DROP TABLE IF EXISTS ${fqName};`, `CREATE TABLE ${fqName} AS (\n${selectSql}\n);`];
    case 'clickhouse':
      // ClickHouse has no default table engine, and MergeTree requires a
      // sorting key, so both are stated explicitly. `tuple()` is the
      // documented "no sorting key" form — models declare no physical
      // ordering, so inventing one here would silently change read
      // performance and merge behaviour. The SELECT is not parenthesised
      // because ClickHouse expects `AS SELECT ...` directly.
      return [
        `CREATE OR REPLACE TABLE ${fqName} ENGINE = MergeTree() ORDER BY tuple() AS\n${selectSql};`,
      ];
  }
}

/**
 * Postgres `table` materialization uses a swap-rename pattern instead of
 * `DROP TABLE; CREATE TABLE AS` so that downstream `materialized_view` models
 * referencing this table do not block the refresh.
 *
 * A naive `DROP TABLE` fails on the second run with
 *   `cannot drop table ... because other objects depend on it`
 * once a MV exists, because Postgres tracks MV dependencies in pg_depend by
 * relation OID. The swap below builds a fresh `__dogsled_new` table, renames
 * it into place, then drops the renamed-aside `__dogsled_old` with CASCADE.
 *
 * CASCADE is safe in the Model Spec DAG context: dependent MVs are themselves
 * Dogsled-managed models that run *after* this table in topological order
 * within the same `dogsled model run` invocation, so the dropped MV is
 * re-created downstream against the new table with fresh data.
 */
function generatePostgresTableSwapDdl(
  fqName: string,
  modelName: string,
  selectSql: string,
  dialect: SupportedDialect
): string[] {
  const baseName = caseName(modelName, dialect);
  const newName = `${baseName}__dogsled_new`;
  const oldName = `${baseName}__dogsled_old`;
  const newFqName = withSwappedTableName(fqName, newName, dialect);
  const oldFqName = withSwappedTableName(fqName, oldName, dialect);
  const quotedOriginal = quoteIdentifier(baseName, dialect);
  const quotedOld = quoteIdentifier(oldName, dialect);

  return [
    `DROP TABLE IF EXISTS ${newFqName};`,
    `DROP TABLE IF EXISTS ${oldFqName} CASCADE;`,
    `CREATE TABLE ${newFqName} AS (\n${selectSql}\n);`,
    `ALTER TABLE IF EXISTS ${fqName} RENAME TO ${quotedOld};`,
    `ALTER TABLE ${newFqName} RENAME TO ${quotedOriginal};`,
    `DROP TABLE IF EXISTS ${oldFqName} CASCADE;`,
  ];
}

/**
 * Replace the trailing identifier in a fully-qualified `"schema"."name"`
 * (or `"schema"."name"` style) with a different unqualified name, preserving
 * the schema prefix and dialect-correct quoting.
 */
function withSwappedTableName(
  fqName: string,
  newUnqualifiedName: string,
  dialect: SupportedDialect
): string {
  const lastDot = fqName.lastIndexOf('.');
  const prefix = lastDot === -1 ? '' : `${fqName.slice(0, lastDot)}.`;
  return `${prefix}${quoteIdentifier(newUnqualifiedName, dialect)}`;
}

function generateDynamicTableDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect,
  defaultWarehouse: string | undefined
): string[] {
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake': {
      const targetLagSql = renderSnowflakeTargetLag(spec.materializationConfig?.target_lag);
      const warehouseName = spec.materializationConfig?.warehouse ?? defaultWarehouse;
      if (!warehouseName) {
        throw new CommandError(
          [
            'Snowflake dynamic tables require a warehouse name.',
            'Set `materialization.warehouse` on the model or `connection.warehouse` on the Snowflake integration.',
          ].join('\n'),
          2
        );
      }
      const warehouse = caseName(warehouseName, dialect);
      return [
        `CREATE OR REPLACE DYNAMIC TABLE ${fqName}\n  TARGET_LAG = ${targetLagSql}\n  WAREHOUSE = ${warehouse}${copyGrantsClause(dialect)}\nAS (\n${selectSql}\n);`,
      ];
    }
    case 'bigquery':
    case 'databricks':
    case 'postgres':
    case 'mysql':
    case 'duckdb':
    case 'clickhouse':
      throw unsupportedMaterializationError(
        'dynamic_table',
        dialect,
        bestMaterializationAlternative(dialect)
      );
  }
}

/**
 * Snowflake `TARGET_LAG` accepts either the bare keyword `DOWNSTREAM` or a
 * single-quoted duration literal (e.g. `'1 hour'`). Quoting `DOWNSTREAM` as a
 * string literal is invalid SQL and fails at execute time. The duration
 * literal is double-escaped defensively even though the schema regex blocks
 * single quotes today.
 */
function renderSnowflakeTargetLag(value: string | undefined): string {
  const raw = (value ?? 'DOWNSTREAM').trim();
  if (raw.toUpperCase() === 'DOWNSTREAM') return 'DOWNSTREAM';
  return `'${raw.replaceAll("'", "''")}'`;
}

function generateMaterializedViewDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): string[] {
  switch (getCanonicalDialect(dialect)) {
    case 'postgres':
      return [
        `DROP MATERIALIZED VIEW IF EXISTS ${fqName};`,
        `CREATE MATERIALIZED VIEW ${fqName} AS (\n${selectSql}\n);`,
      ];
    case 'mysql':
    case 'duckdb':
    case 'clickhouse':
      throw unsupportedMaterializationError('materialized_view', dialect, 'table');
    case 'snowflake':
    case 'databricks':
      return [
        `CREATE OR REPLACE MATERIALIZED VIEW ${fqName}${copyGrantsClause(dialect)} AS (\n${selectSql}\n);`,
      ];
    case 'bigquery':
      return [
        `CREATE OR REPLACE MATERIALIZED VIEW ${fqName}${bigQueryMvOptions(spec)} AS (\n${selectSql}\n);`,
      ];
  }
}

function generateIncrementalDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): string[] {
  const strategy = spec.materializationConfig?.strategy ?? 'merge';

  switch (strategy) {
    case 'append':
      return [`INSERT INTO ${fqName}\n${selectSql};`];

    case 'delete_insert':
      return generateDeleteInsertDdl(fqName, selectSql, spec, dialect);

    case 'merge':
      return generateMergeDdl(fqName, selectSql, spec, dialect);
  }
}

function validateMaterializationSupport(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): void {
  if (
    spec.materialization === 'dynamic_table' &&
    !supportsDialectCapability(dialect, 'dynamicTable')
  ) {
    throw unsupportedMaterializationError(
      'dynamic_table',
      dialect,
      bestMaterializationAlternative(dialect)
    );
  }

  if (
    spec.materialization === 'materialized_view' &&
    !supportsDialectCapability(dialect, 'materializedView')
  ) {
    throw unsupportedMaterializationError('materialized_view', dialect, 'table');
  }

  if (
    spec.materializationConfig?.target_lag !== undefined &&
    getCanonicalDialect(dialect) !== 'snowflake'
  ) {
    throw new CommandError(
      [
        `Materialization option \`target_lag\` is only supported for Snowflake dynamic tables.`,
        `Dialect \`${dialect}\` does not support this option.`,
        'Use `materialized_view` on BigQuery or remove the Snowflake-only option.',
      ].join('\n'),
      2
    );
  }

  if (
    spec.materializationConfig?.warehouse !== undefined &&
    getCanonicalDialect(dialect) !== 'snowflake'
  ) {
    throw new CommandError(
      [
        `Materialization option \`warehouse\` is only supported for Snowflake dynamic tables.`,
        `Dialect \`${dialect}\` does not support this option.`,
        'Remove the Snowflake-only option for this integration.',
      ].join('\n'),
      2
    );
  }

  if (
    spec.materializationConfig?.max_staleness !== undefined &&
    getCanonicalDialect(dialect) !== 'bigquery'
  ) {
    throw new CommandError(
      [
        `Materialization option \`max_staleness\` is only supported for BigQuery materialized views.`,
        `Dialect \`${dialect}\` does not support this option.`,
        'Remove the BigQuery-only option for this integration.',
      ].join('\n'),
      2
    );
  }
}

function unsupportedMaterializationError(
  materialization: PhysicalMaterialization,
  dialect: SupportedDialect,
  alternative: string | undefined
): CommandError {
  const suggestion = alternative
    ? [`Use \`${alternative}\` instead for this integration.`]
    : ['Use a supported materialization for this integration.'];
  return new CommandError(
    [
      `Dialect \`${dialect}\` does not support materialization \`${materialization}\`.`,
      ...suggestion,
      'Change the model materialization and re-run `dogsled model compile`.',
    ].join('\n'),
    2
  );
}

function bestMaterializationAlternative(dialect: SupportedDialect): string | undefined {
  if (supportsDialectCapability(dialect, 'materializedView')) return 'materialized_view';
  return 'table';
}

function copyGrantsClause(dialect: SupportedDialect): string {
  return getCanonicalDialect(dialect) === 'snowflake' ? ' COPY GRANTS' : '';
}

function bigQueryMvOptions(spec: ResolvedTransformSpec): string {
  const maxStaleness = spec.materializationConfig?.max_staleness;
  if (!maxStaleness) return '';
  return `\nOPTIONS (max_staleness = ${toBigQueryInterval(maxStaleness)})`;
}

function toBigQueryInterval(value: string): string {
  const typed = value.trim().match(/^INTERVAL\s+"(\d+)"\s+(MINUTE|HOUR|DAY)$/i);
  if (typed) {
    const [, amount, unit] = typed;
    if (amount && unit) return `INTERVAL "${amount}" ${unit.toUpperCase()}`;
  }
  const friendly = value.trim().match(/^(\d+)\s+(minute|hour|day)s?$/i);
  if (friendly) {
    const [, amount, unit] = friendly;
    if (amount && unit) return `INTERVAL "${amount}" ${unit.toUpperCase()}`;
  }
  throw new CommandError(
    `Invalid max_staleness format: "${value}". Use "N HOUR", "N MINUTE", or "N DAY" (e.g. "1 hour", "30 minute").`,
    2
  );
}

function formatColumnDiff(
  previousColumns: SelectStateColumn[],
  nextColumns: SelectStateColumn[]
): string[] {
  const previousByName = new Map(
    previousColumns.map((column) => [column.name.toLowerCase(), column])
  );
  const nextByName = new Map(nextColumns.map((column) => [column.name.toLowerCase(), column]));
  const lines: string[] = [];

  for (const column of nextColumns) {
    const previous = previousByName.get(column.name.toLowerCase());
    if (!previous) {
      lines.push(`  + column \`${column.name}\` (${formatColumnShape(column)})`);
    } else if (
      previous.name !== column.name ||
      previous.type !== column.type ||
      previous.primary_key !== column.primary_key ||
      previous.not_null !== column.not_null
    ) {
      lines.push(
        `  ~ column \`${previous.name}\` (${formatColumnShape(previous)} -> ${formatColumnShape(column)})`
      );
    }
  }

  for (const column of previousColumns) {
    if (!nextByName.has(column.name.toLowerCase())) {
      lines.push(`  - column \`${column.name}\` (${formatColumnShape(column)})`);
    }
  }

  return lines.length > 0 ? lines : ['  ~ structural signature changed'];
}

function formatColumnShape(column: SelectStateColumn): string {
  const constraints = [
    column.type,
    column.primary_key ? 'primary_key' : undefined,
    column.not_null ? 'not_null' : undefined,
  ].filter(Boolean);
  return constraints.join(', ');
}

function generateDeleteInsertDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): string[] {
  const keys = normalizeUniqueKey(spec.materializationConfig?.unique_key);
  if (keys.length === 0) {
    throw new Error(`unique_key is required for delete_insert strategy on model "${spec.name}"`);
  }

  const casedKeys = keys.map((k) => caseName(k, dialect));
  const beginTxn = getCanonicalDialect(dialect) === 'mysql' ? 'START TRANSACTION;' : 'BEGIN;';

  return [
    beginTxn,
    `DELETE FROM ${fqName} WHERE (${casedKeys.join(', ')}) IN (SELECT ${casedKeys.join(', ')} FROM (${selectSql}) AS __source);`,
    `INSERT INTO ${fqName}\n${selectSql};`,
    'COMMIT;',
  ];
}

function generateMergeDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): string[] {
  const keys = normalizeUniqueKey(spec.materializationConfig?.unique_key);
  if (keys.length === 0) {
    throw new Error(`unique_key is required for merge strategy on model "${spec.name}"`);
  }

  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  const casedKeys = keys.map((k) => caseName(k, dialect));
  const casedColumns = spec.columns.map((c) => caseName(c.name, dialect));
  const nonKeyColumns = spec.columns
    .filter((c) => !keySet.has(c.name.toLowerCase()))
    .map((c) => caseName(c.name, dialect));

  if (getCanonicalDialect(dialect) === 'mysql') {
    // MySQL doesn't have MERGE -- use INSERT ON DUPLICATE KEY UPDATE
    const updateCols = nonKeyColumns.map((c) => `${c} = VALUES(${c})`).join(', ');

    return [`INSERT INTO ${fqName}\n${selectSql}\nON DUPLICATE KEY UPDATE ${updateCols};`];
  }

  // Standard MERGE for all other dialects.
  //
  // The target table is explicitly aliased (`AS target`) and its key columns
  // are referenced through that alias rather than the fully-qualified table
  // name. When `incremental_filter` uses `self`, the compiled SELECT in the
  // USING clause references the target table by its fully-qualified name, so
  // the MERGE reads the target table twice — a self-join. BigQuery rejects an
  // unaliased self-join: with no alias, the qualified `<project>.<dataset>.<table>.<col>`
  // reference in the ON clause is parsed as a name expression, and the
  // hyphenated project id surfaces as `Unrecognized name: <project>`. Aliasing
  // the target disambiguates the self-join and keeps the ON clause valid across
  // every MERGE dialect (matching the snapshot MERGE, which already aliases).
  const onClause = casedKeys.map((k) => `target.${k} = __source.${k}`).join(' AND ');

  const updateCols = nonKeyColumns.map((c) => `${c} = __source.${c}`).join(', ');

  const insertCols = casedColumns.join(', ');
  const insertVals = casedColumns.map((c) => `__source.${c}`).join(', ');

  return [
    [
      `MERGE INTO ${fqName} AS target`,
      `USING (\n${selectSql}\n) AS __source`,
      `  ON ${onClause}`,
      `WHEN MATCHED THEN`,
      `  UPDATE SET ${updateCols}`,
      `WHEN NOT MATCHED THEN`,
      `  INSERT (${insertCols})`,
      `  VALUES (${insertVals});`,
    ].join('\n'),
  ];
}

function normalizeUniqueKey(key: string | string[] | undefined): string[] {
  if (!key) return [];
  return Array.isArray(key) ? key : [key];
}

function expandHookTemplate(hook: string, context: { schema: string; name: string }): string {
  return hook.replace(/\{schema\}/g, context.schema).replace(/\{name\}/g, context.name);
}

// ---------------------------------------------------------------------------
// Snapshot (SCD Type 2)
// ---------------------------------------------------------------------------

function getSnapshotColumnNames(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): { validFrom: string; validTo: string } {
  const validFromRaw = spec.materializationConfig?.valid_from_column ?? 'valid_from';
  const validToRaw = spec.materializationConfig?.valid_to_column ?? 'valid_to';
  return {
    validFrom: caseName(validFromRaw, dialect),
    validTo: caseName(validToRaw, dialect),
  };
}

function nullTimestampCast(dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return 'NULL::TIMESTAMP';
    case 'bigquery':
      return 'CAST(NULL AS TIMESTAMP)';
    case 'postgres':
    case 'duckdb':
      return 'NULL::TIMESTAMP';
    case 'databricks':
      return 'CAST(NULL AS TIMESTAMP)';
    case 'mysql':
      return 'CAST(NULL AS DATETIME)';
    case 'clickhouse':
      // A bare NULL is not nullable in ClickHouse; the column type has to say so.
      return 'CAST(NULL AS Nullable(DateTime64(3)))';
  }
}

function generateSnapshotFirstRunDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): string[] {
  const { validFrom, validTo } = getSnapshotColumnNames(spec, dialect);
  const isCurrent = caseName('is_current', dialect);
  const nullTs = nullTimestampCast(dialect);

  const wrappedSql = [
    `SELECT`,
    `  __snapshot_src.*,`,
    `  CURRENT_TIMESTAMP AS ${validFrom},`,
    `  ${nullTs} AS ${validTo},`,
    `  TRUE AS ${isCurrent}`,
    `FROM (`,
    selectSql,
    `) AS __snapshot_src`,
  ].join('\n');

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
    case 'bigquery':
    case 'databricks':
    case 'duckdb':
      return [
        `CREATE OR REPLACE TABLE ${fqName}${copyGrantsClause(dialect)} AS (\n${wrappedSql}\n);`,
      ];
    case 'postgres':
    case 'mysql':
      return [`DROP TABLE IF EXISTS ${fqName};`, `CREATE TABLE ${fqName} AS (\n${wrappedSql}\n);`];
    case 'clickhouse':
      // The first run is expressible, but every later run has to close out the
      // superseded row, which needs the MERGE that ClickHouse does not have.
      // Failing here keeps the first run from succeeding into a snapshot that
      // can never be updated.
      throw unsupportedMaterializationError('snapshot', dialect, 'table');
  }
}

function getTrackedColumns(spec: ResolvedTransformSpec, dialect: SupportedDialect): string[] {
  const keys = normalizeUniqueKey(spec.materializationConfig?.unique_key);
  const keySet = new Set(keys.map((k) => k.toLowerCase()));

  if (
    spec.materializationConfig?.tracked_columns &&
    spec.materializationConfig.tracked_columns.length > 0
  ) {
    return spec.materializationConfig.tracked_columns.map((c) => caseName(c, dialect));
  }

  // Default: all non-key columns from the spec
  return spec.columns
    .filter((c) => !keySet.has(c.name.toLowerCase()))
    .map((c) => caseName(c.name, dialect));
}

function buildChangeDetectionClause(trackedCols: string[], dialect: SupportedDialect): string {
  return trackedCols
    .map((col) => {
      if (getCanonicalDialect(dialect) === 'mysql') {
        return `NOT (${fqNamePrefix('target', col)} <=> __source.${col})`;
      }
      return `${fqNamePrefix('target', col)} IS DISTINCT FROM __source.${col}`;
    })
    .join('\n  OR ');
}

/** Prefix a column with a table alias. */
function fqNamePrefix(alias: string, col: string): string {
  return `${alias}.${col}`;
}

function generateSnapshotMergeDdl(
  fqName: string,
  selectSql: string,
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect
): string[] {
  const keys = normalizeUniqueKey(spec.materializationConfig?.unique_key);
  if (keys.length === 0) {
    throw new Error(`unique_key is required for snapshot materialization on model "${spec.name}"`);
  }

  const casedKeys = keys.map((k) => caseName(k, dialect));
  const trackedCols = getTrackedColumns(spec, dialect);
  const { validFrom, validTo } = getSnapshotColumnNames(spec, dialect);
  const isCurrent = caseName('is_current', dialect);
  const nullTs = nullTimestampCast(dialect);

  if (getCanonicalDialect(dialect) === 'mysql') {
    return generateSnapshotMysqlDdl(
      fqName,
      selectSql,
      casedKeys,
      trackedCols,
      validFrom,
      validTo,
      isCurrent,
      nullTs
    );
  }

  // Standard MERGE for Snowflake, BigQuery, Postgres, Databricks
  const onClause = casedKeys.map((k) => `target.${k} = __source.${k}`).join(' AND ');

  const changeDetection = buildChangeDetectionClause(trackedCols, dialect);

  const allSourceCols = [...casedKeys, ...trackedCols];
  const insertCols = [...allSourceCols, validFrom, validTo, isCurrent].join(', ');

  // Step 1: MERGE closes any current row whose tracked columns changed.
  // We deliberately do not include WHEN NOT MATCHED here — the follow-up
  // INSERT below handles BOTH new keys AND changed-key new versions in a
  // single statement via NOT EXISTS, so the MERGE only needs to close
  // outdated current rows.
  const mergeSql = [
    `MERGE INTO ${fqName} AS target`,
    `USING (\n${selectSql}\n) AS __source`,
    `  ON ${onClause} AND target.${isCurrent} = TRUE`,
    `WHEN MATCHED AND (`,
    `  ${changeDetection}`,
    `) THEN`,
    `  UPDATE SET ${validTo} = CURRENT_TIMESTAMP, ${isCurrent} = FALSE;`,
  ].join('\n');

  // Step 2: Insert a new current row for every source key that lacks an
  // is_current = TRUE row in target. After step 1 closes changed rows, both
  // (a) brand-new keys and (b) changed keys whose row was just closed have no
  // current row, so NOT EXISTS captures both. Unchanged keys still have their
  // current row and correctly skip.
  //
  // Using NOT EXISTS instead of joining on `target.valid_to = CURRENT_TIMESTAMP`
  // avoids a per-statement timestamp drift bug — CURRENT_TIMESTAMP evaluates
  // independently in each statement on DuckDB/Postgres/MySQL, so the close
  // statement's timestamp would not match the insert statement's join probe.
  const notExistsCondition = casedKeys.map((k) => `target.${k} = __source.${k}`).join(' AND ');

  const insertSql = [
    `INSERT INTO ${fqName} (${insertCols})`,
    `SELECT`,
    `  ${allSourceCols.map((c) => `__source.${c}`).join(', ')},`,
    `  CURRENT_TIMESTAMP,`,
    `  ${nullTs},`,
    `  TRUE`,
    `FROM (\n${selectSql}\n) AS __source`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1 FROM ${fqName} AS target`,
    `  WHERE ${notExistsCondition} AND target.${isCurrent} = TRUE`,
    `);`,
  ].join('\n');

  return [mergeSql, insertSql];
}

function generateSnapshotMysqlDdl(
  fqName: string,
  selectSql: string,
  casedKeys: string[],
  trackedCols: string[],
  validFrom: string,
  validTo: string,
  isCurrent: string,
  nullTs: string
): string[] {
  const joinCondition = casedKeys.map((k) => `t.${k} = __source.${k}`).join(' AND ');

  const changeDetection = trackedCols
    .map((col) => `NOT (t.${col} <=> __source.${col})`)
    .join(' OR ');

  const allSourceCols = [...casedKeys, ...trackedCols];
  const insertCols = [...allSourceCols, validFrom, validTo, isCurrent].join(', ');

  // Step 1: Close changed rows
  const updateSql = [
    `UPDATE ${fqName} t`,
    `INNER JOIN (${selectSql}) AS __source`,
    `  ON ${joinCondition} AND t.${isCurrent} = TRUE`,
    `SET t.${validTo} = CURRENT_TIMESTAMP, t.${isCurrent} = FALSE`,
    `WHERE ${changeDetection};`,
  ].join('\n');

  // Step 2: Insert a new current row for every source key that lacks an
  // is_current = TRUE row in target. After step 1, both new keys and changed
  // keys (whose current row was just closed) qualify; unchanged keys still
  // have their current row and correctly skip. NOT EXISTS replaces both the
  // earlier "INSERT changed via INNER JOIN on valid_to = CURRENT_TIMESTAMP"
  // path (which races on per-statement timestamp evaluation) and the
  // "INSERT new via LEFT JOIN ... IS NULL" path.
  const notExistsCondition = casedKeys.map((k) => `t.${k} = __source.${k}`).join(' AND ');

  const insertSql = [
    `INSERT INTO ${fqName} (${insertCols})`,
    `SELECT`,
    `  ${allSourceCols.map((c) => `__source.${c}`).join(', ')},`,
    `  CURRENT_TIMESTAMP,`,
    `  ${nullTs},`,
    `  TRUE`,
    `FROM (${selectSql}) AS __source`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1 FROM ${fqName} t`,
    `  WHERE ${notExistsCondition} AND t.${isCurrent} = TRUE`,
    `);`,
  ].join('\n');

  return [updateSql, insertSql];
}
