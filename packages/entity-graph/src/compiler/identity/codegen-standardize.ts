/**
 * Standardization codegen — transform pipeline to SQL.
 *
 * UNION ALL across all inputs with standardize transforms applied.
 * Adds metadata columns for source tracking.
 */

import {
  quoteIdentifier,
  buildFqName,
  createOrReplaceTableAs,
  FUNCTION_CATALOG,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import type { StandardizeFunction } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import {
  buildRecordIdExpr,
  buildSourceEntityIdExpr,
  buildSourcePkJsonExpr,
  nullOfType,
  stringType,
} from './sql.js';
import {
  incrementalSourcePredicate,
  type ResolutionIncrementalOptions,
} from './codegen-resolve-state.js';

// ---------------------------------------------------------------------------
// NULL-padding helpers
// ---------------------------------------------------------------------------

/** Build a case-insensitive lookup set from a column list. */
function lowerSet(cols: string[]): Set<string> {
  return new Set(cols.map((c) => c.toLowerCase()));
}

/**
 * The column names `<entity>__standardized` exposes — the fixed bookkeeping
 * columns, one `standardized_<field>` per standardize entry, and every declared
 * source column (passed through) — all lowercased for case-insensitive lookups.
 *
 * Returns `undefined` when any input omits its source columns: under a wildcard
 * passthrough the produced universe is unknown, so callers must skip
 * field-existence checks rather than risk a false positive. Mirrors the
 * `allHaveColumns` gate `generateStandardizeSql` uses for its own field guard.
 */
export function producedStandardizedColumns(spec: ResolvedResolutionSpec): Set<string> | undefined {
  if (!spec.inputs.every((input) => input.sourceColumns !== undefined)) return undefined;
  const produced = new Set<string>([
    'record_id',
    'source_ref',
    'source_pk_json',
    '_source_system',
    '_source_entity_id',
    '_standardized_at',
    ...spec.standardize.map((s) => `standardized_${s.field}`.toLowerCase()),
  ]);
  for (const input of spec.inputs) {
    for (const col of input.sourceColumns ?? []) {
      produced.add(col.toLowerCase());
    }
  }
  return produced;
}

/**
 * Determine the SQL type for a standardized column when NULL-padding an input
 * that lacks the underlying source field. The type is derived from the final
 * transform in the chain so the padded NULL matches the column type emitted by
 * inputs that DO have the field.
 */
function standardizedNullType(
  transforms: StandardizeFunction[],
  dialect: SupportedDialect
): string {
  const last = transforms[transforms.length - 1];
  if (last === 'parse_number') {
    // BigQuery: FLOAT64; Snowflake: FLOAT; others: DOUBLE PRECISION / REAL
    switch (dialect) {
      case 'bigquery':
        return 'FLOAT64';
      case 'snowflake':
        return 'FLOAT';
      default:
        return 'DOUBLE PRECISION';
    }
  }
  return stringType(dialect);
}

/**
 * Determine the SQL type for a passthrough column when NULL-padding an input
 * that lacks it. Uses inherited source field metadata when available, falling
 * back to the dialect string type.
 */
function passthroughNullType(
  col: string,
  inputs: ResolvedResolutionSpec['inputs'],
  dialect: SupportedDialect
): string {
  for (const input of inputs) {
    const meta = input.sourceFieldMetadata?.[col] ?? input.sourceFieldMetadata?.[col.toLowerCase()];
    if (meta) {
      switch (meta.type) {
        case 'integer':
          return dialect === 'bigquery' ? 'INT64' : 'BIGINT';
        case 'number':
          return dialect === 'bigquery'
            ? 'FLOAT64'
            : dialect === 'snowflake'
              ? 'FLOAT'
              : 'DOUBLE PRECISION';
        case 'boolean':
          return dialect === 'bigquery' ? 'BOOL' : 'BOOLEAN';
        case 'timestamp':
          return 'TIMESTAMP';
        case 'date':
          return 'DATE';
        default:
          return stringType(dialect);
      }
    }
  }
  return stringType(dialect);
}

// ---------------------------------------------------------------------------
// Transform SQL generation
// ---------------------------------------------------------------------------

/**
 * Generate the SQL expression for a single standardize transform.
 * Transforms chain: inner expression wraps outer.
 */
function transformExpr(
  field: string,
  transform: StandardizeFunction,
  dialect: SupportedDialect
): string {
  switch (transform) {
    case 'lowercase':
      return `LOWER(${field})`;
    case 'uppercase':
      return `UPPER(${field})`;
    case 'trim':
      return `TRIM(${field})`;
    case 'strip_protocol':
      return emitCatalogFunction('strip_www', field, dialect);
    default:
      return emitCatalogFunction(transform, field, dialect);
  }
}

function emitCatalogFunction(name: string, field: string, dialect: SupportedDialect): string {
  const fn = FUNCTION_CATALOG.get(name);
  const emitter = fn?.emit[dialect] ?? fn?.emit[getCanonicalEmitKey(dialect)];
  if (typeof emitter === 'function') {
    return emitter([field], dialect);
  }
  if (typeof emitter === 'string') {
    return `${emitter}(${field})`;
  }
  throw new Error(
    `Cleaning function "${name}" is not registered in the FUNCTION_CATALOG. Add it to CLEANING_FUNCTIONS in functions-cleaning.ts.`
  );
}

function getCanonicalEmitKey(dialect: SupportedDialect): SupportedDialect {
  return dialect === 'redshift' || dialect === 'pgvector' ? 'postgres' : dialect;
}

/**
 * Build the full chained expression for a field's transforms.
 * Example: collapse_whitespace(strip_legal_suffixes(lowercase(field)))
 */
function buildTransformChain(
  baseField: string,
  transforms: StandardizeFunction[],
  dialect: SupportedDialect
): string {
  let expr = baseField;
  for (const t of transforms) {
    expr = transformExpr(expr, t, dialect);
  }
  return expr;
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

/**
 * Generate SQL for the __standardized table.
 *
 * UNION ALL across all inputs with standardize transforms applied.
 * Adds: _source_system, _source_entity_id, _standardized_at
 */
export function generateStandardizeSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  options?: { incremental?: ResolutionIncrementalOptions }
): SqlStatement {
  const entity = spec.entity;
  const tableSuffix = options?.incremental ? '__standardized_delta' : '__standardized';
  const stdTable = buildFqName(targetSchema, outputTableName(entity, tableSuffix), dialect);
  const existingStandardizedTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized'),
    dialect
  );
  const forgottenTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__forgotten_records'),
    dialect
  );

  const selectParts: string[] = [];

  // Metadata column names are identical for every input, so build the set once.
  // Stored in lowercase so comparisons against col.toLowerCase() are consistent.
  const metadataColumns = new Set([
    'record_id',
    'source_ref',
    'source_pk_json',
    '_source_system',
    '_source_entity_id',
    '_standardized_at',
    ...spec.standardize.map((s) => `standardized_${s.field}`.toLowerCase()),
  ]);

  // When EVERY input declares its source columns, a standardize field that is
  // present in no input is an authoring error — it would emit CAST(NULL) for
  // every branch and silently drop the field. Fail fast with a clear message.
  const allHaveColumns = spec.inputs.every((i) => i.sourceColumns !== undefined);
  if (allHaveColumns) {
    for (const std of spec.standardize) {
      const fieldLower = std.field.toLowerCase();
      const present = spec.inputs.some((i) => lowerSet(i.sourceColumns ?? []).has(fieldLower));
      if (!present) {
        const inputRefs = spec.inputs.map((i) => i.ref);
        throw new Error(
          `Resolution standardize field "${std.field}" is not present in any input's source columns (checked: ${inputRefs.join(', ')}).`
        );
      }
    }
  }

  // When every input declares its source columns, precompute the unified
  // passthrough column list — the case-insensitively-deduped union of
  // non-metadata columns across all inputs, in first-seen order/casing. Each
  // UNION ALL branch then projects this exact list (NULL-padding absent
  // columns) so all branches have matching column counts and aliases.
  let unifiedPassthrough: string[] | undefined;
  if (allHaveColumns) {
    const seen = new Set<string>();
    unifiedPassthrough = [];
    for (const inp of spec.inputs) {
      for (const col of inp.sourceColumns ?? []) {
        const lower = col.toLowerCase();
        if (!metadataColumns.has(lower) && !seen.has(lower)) {
          seen.add(lower);
          unifiedPassthrough.push(col);
        }
      }
    }
  }

  for (const input of spec.inputs) {
    const sourceAlias = quoteIdentifier('src', dialect);
    const incrementalSource = options?.incremental?.sources.find(
      (source) => source.sourceRef === input.ref
    );
    const columns: string[] = [];
    const idFields = input.idFields ?? [];
    if (idFields.length === 0) {
      throw new Error(`Resolution input ${input.ref} must define at least one id_field.`);
    }

    // Source system and entity ID metadata
    const sourceSystem = quoteLiteral(input.ref, dialect);
    const sourcePkJsonExpr = buildSourcePkJsonExpr(idFields, dialect, sourceAlias);
    const sourceEntityIdExpr = buildSourceEntityIdExpr(idFields, dialect, sourceAlias);
    const recordIdExpr = buildRecordIdExpr(input.ref, sourcePkJsonExpr, dialect);

    columns.push(`${recordIdExpr} AS ${quoteIdentifier('record_id', dialect)}`);
    columns.push(`${sourceSystem} AS ${quoteIdentifier('source_ref', dialect)}`);
    columns.push(`${sourcePkJsonExpr} AS ${quoteIdentifier('source_pk_json', dialect)}`);
    columns.push(`${sourceSystem} AS ${quoteIdentifier('_source_system', dialect)}`);
    columns.push(`${sourceEntityIdExpr} AS ${quoteIdentifier('_source_entity_id', dialect)}`);
    columns.push(`CURRENT_TIMESTAMP AS ${quoteIdentifier('_standardized_at', dialect)}`);

    // Add all standardized fields. When this input's source columns are known
    // and the field is absent, emit a typed NULL placeholder instead of a
    // transform chain referencing a column that does not exist.
    const inputColSetLower =
      input.sourceColumns !== undefined ? lowerSet(input.sourceColumns) : undefined;
    for (const stdTransform of spec.standardize) {
      const alias = quoteIdentifier(`standardized_${stdTransform.field}`, dialect);
      if (
        inputColSetLower !== undefined &&
        !inputColSetLower.has(stdTransform.field.toLowerCase())
      ) {
        const nullType = standardizedNullType(stdTransform.transforms, dialect);
        columns.push(`${nullOfType(nullType, dialect)} AS ${alias}`);
      } else {
        const baseField = `${sourceAlias}.${quoteIdentifier(stdTransform.field, dialect)}`;
        const chain = stdTransform.preHashed
          ? baseField
          : buildTransformChain(baseField, stdTransform.transforms, dialect);
        columns.push(`${chain} AS ${alias}`);
      }
    }

    // Include original source fields, excluding any that collide with metadata columns.
    // When all inputs declare their source columns, project the unified passthrough
    // list so every UNION ALL branch shares the same column shape, NULL-padding any
    // column this input lacks. When only this input's columns are known, emit explicit
    // references. Otherwise fall back to wildcard.
    if (unifiedPassthrough !== undefined) {
      const inputColSet = lowerSet(input.sourceColumns ?? []);
      for (const col of unifiedPassthrough) {
        const quoted = quoteIdentifier(col, dialect);
        if (inputColSet.has(col.toLowerCase())) {
          columns.push(`${sourceAlias}.${quoted} AS ${quoted}`);
        } else {
          const nullType = passthroughNullType(col, spec.inputs, dialect);
          columns.push(`${nullOfType(nullType, dialect)} AS ${quoted}`);
        }
      }
    }
    // When not all inputs declare sourceColumns, skip raw passthrough entirely.
    // Each branch projects only bookkeeping + standardized fields (always the
    // same count), so the UNION ALL is valid even when inputs have different
    // raw column counts. Add schema.columns to all source specs to re-enable
    // passthrough projection with proper NULL-padding.

    const forgottenAlias = quoteIdentifier('forgotten', dialect);
    const predicates = [`${forgottenAlias}.${quoteIdentifier('tombstone_id', dialect)} IS NULL`];
    if (incrementalSource) {
      predicates.push(
        incrementalSourcePredicate(incrementalSource, sourceAlias, dialect, {
          existingStandardizedTable,
          recordIdExpr,
        })
      );
    }

    const select = [
      `SELECT`,
      `  ${columns.join(',\n  ')}`,
      `FROM ${input.fqTableName} AS ${sourceAlias}`,
      `LEFT JOIN ${forgottenTable} AS ${forgottenAlias}`,
      `  ON ${forgottenAlias}.${quoteIdentifier('source_ref', dialect)} = ${sourceSystem}`,
      ` AND ${forgottenAlias}.${quoteIdentifier('source_pk_json', dialect)} = ${sourcePkJsonExpr}`,
      `WHERE ${predicates.join('\n  AND ')}`,
    ].join('\n');

    selectParts.push(select);
  }

  const unionAll = selectParts.join('\nUNION ALL\n');
  const sql = `${createOrReplaceTableAs(stdTable, dialect)}\n${unionAll}`;

  return {
    name: options?.incremental ? 'standardize_delta' : 'standardize',
    sql,
    tableCreated: outputTableName(entity, tableSuffix),
  };
}

export function generateDeleteUpdatedStandardizedSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const stdTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized'),
    dialect
  );
  const deltaTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized_delta'),
    dialect
  );
  const recordId = quoteIdentifier('record_id', dialect);
  return {
    name: 'delete_updated_standardized',
    sql: [
      `DELETE FROM ${stdTable}`,
      `WHERE ${recordId} IN (`,
      `  SELECT ${recordId} FROM ${deltaTable}`,
      `)`,
    ].join('\n'),
    tableCreated: outputTableName(spec.entity, '__standardized'),
  };
}

export function generateInsertStandardizedDeltaSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const stdTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized'),
    dialect
  );
  const deltaTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized_delta'),
    dialect
  );
  return {
    name: 'insert_standardized_delta',
    sql: [`INSERT INTO ${stdTable}`, `SELECT * FROM ${deltaTable}`].join('\n'),
    tableCreated: outputTableName(spec.entity, '__standardized'),
  };
}
