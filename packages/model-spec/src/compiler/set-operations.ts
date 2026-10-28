/**
 * SQL rendering for set operations: UNION / UNION ALL / INTERSECT / EXCEPT.
 *
 * Lives in a sibling module to keep `codegen.ts` under the source-file
 * budget. Per-branch `include_all_columns` / `exclude_columns` / `columns`
 * rendering mirrors the main SELECT semantics so UNION ALL arms stay
 * positionally aligned.
 */

import {
  caseName,
  formatTableRef,
  getCanonicalDialect,
  getSelectStarModifier,
  quoteColumnAlias,
  supportsDialectCapability,
  unsupportedDialectFeatureError,
} from './dialect.js';
import { getSourceEntry } from './parser.js';

import type { SupportedDialect } from './dialect.js';
import type {
  ResolvedColumn,
  ResolvedTransformSpec,
  ResolvedUnionBranch,
  SetOperation,
  SourceEntryColumn,
  SourceEntryRegistry,
} from './parser.js';

type TranspileFn = (expr: string) => string;
type FormatApiResourceRefFn = (
  fqRef: string,
  alias: string | undefined,
  dialect: SupportedDialect
) => string;

export interface CanonicalSetColumn {
  name: string;
  castType: string;
  sourceColumnName?: string;
  defaultExpr?: string;
}

// Match a single column reference, optionally qualified by a table alias.
// The alias and the column each accept three quoting forms (bare, double-quoted,
// backtick-quoted) so we can extract the underlying name regardless of how the
// dialect emitter rendered the expression.
const DIRECT_COLUMN_RE =
  /^(?:(?:"(?<tableDq>[^"]+)"|`(?<tableBt>[^`]+)`|(?<tableBare>[A-Za-z_]\w*))\.)?(?:"(?<dq>[^"]+)"|`(?<bt>[^`]+)`|(?<bare>[A-Za-z_]\w*))$/;

/**
 * Render the `*` portion of a SELECT clause: bare `*`, `* EXCEPT(...)` /
 * `* EXCLUDE(...)`, or `undefined` when `includeAll` is false. Throws on
 * dialects that don't support `SELECT *` exclusions when excludes are
 * present.
 *
 * Shared by the main SELECT and per-union-branch column lists so that
 * `include_all_columns` / `exclude_columns` behave identically in both
 * positions.
 */
export function buildSelectStarPart(
  includeAll: boolean | undefined,
  excludeColumns: string[] | undefined,
  dialect: SupportedDialect
): string | undefined {
  if (!includeAll) return undefined;
  if (excludeColumns && excludeColumns.length > 0) {
    const excludeCols = excludeColumns.map((c) => caseName(c, dialect)).join(', ');
    const modifier = getSelectStarModifier(dialect);
    if (!supportsDialectCapability(dialect, 'selectStarExcept') || !modifier) {
      throw unsupportedDialectFeatureError(
        dialect,
        'selectStarExcept',
        `SELECT * EXCEPT is not supported for compiler target "${dialect}" — enumerate columns explicitly`
      );
    }
    return `* ${modifier} (${excludeCols})`;
  }
  return '*';
}

export function buildCanonicalBigQuerySetColumns(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect,
  entryRegistry: SourceEntryRegistry | undefined
): CanonicalSetColumn[] | undefined {
  if (getCanonicalDialect(dialect) !== 'bigquery') return undefined;
  if (!spec.union || spec.union.length === 0) return undefined;

  const sourceEntry = getSourceEntry(entryRegistry, spec.source.refKey ?? spec.sourceRef);
  if (spec.includeAllColumns && !sourceEntry) {
    // Falling back to legacy SELECT * here would re-introduce the positional
    // UNION ALL drift bug the canonical projection exists to prevent. Surface
    // the missing registry entry as a compile error instead of silently
    // producing fragile SQL.
    throw new Error(
      `[bigquery_union_drift_guard] Source "${spec.source.refKey ?? spec.sourceRef}" referenced by model "${spec.name}" ` +
        'is not registered in the source registry. ' +
        'Declare the source as a YAML source spec (or, for in-memory hosts, pass it via the `entryRegistry` option to compileInMemory / dryRunInMemory — build one with buildInMemorySourceEntryRegistry), ' +
        'or enumerate output columns explicitly on the model instead of using include_all_columns.'
    );
  }

  const columns: CanonicalSetColumn[] = [];
  const excluded = new Set((spec.excludeColumns ?? []).map((column) => column.toLowerCase()));

  if (spec.includeAllColumns && sourceEntry) {
    for (const column of sourceEntry.columns) {
      if (excluded.has(column.name.toLowerCase())) continue;
      columns.push({
        name: column.name,
        sourceColumnName: column.name,
        castType: toBigQueryCastType(column.sqlType),
      });
    }
  }

  for (const column of spec.columns) {
    const sourceColumnName = directSourceColumnName(column.expr, spec.source.alias);
    const sourceColumn = sourceColumnName
      ? findSourceColumn(sourceEntry?.columns, sourceColumnName)
      : undefined;
    columns.push({
      name: column.name,
      defaultExpr: column.expr,
      sourceColumnName,
      castType: toBigQueryCastType(
        column.type ?? sourceColumn?.sqlType ?? inferBigQueryTypeFromExpression(column.expr)
      ),
    });
  }

  return columns;
}

/**
 * Render the canonical SELECT projection for one UNION ALL arm.
 *
 * Trade-offs deliberately baked into this rendering:
 *   - Columns declared by the canonical model but absent from this branch's
 *     source spec emit `CAST(NULL AS <type>)`. This is the drift-tolerance
 *     intent — heterogeneous source unions stay queryable instead of failing
 *     with "UNION ALL has mismatched column count". The omission is the
 *     user's choice when they declared the per-branch source schema.
 *   - All projected expressions are wrapped in `SAFE_CAST` so a type mismatch
 *     between the branch column and the canonical column type returns NULL
 *     for that row instead of aborting the entire query. Use a regular `CAST`
 *     in an explicit branch column expr if you want loud type errors.
 *   - `preflightBigQueryPlan` runs `runner.dryRun` against the rendered SQL
 *     before execution, so genuinely malformed projections still fail fast.
 */
export function renderCanonicalBigQuerySetProjection(
  columns: CanonicalSetColumn[],
  sourceRef: string,
  sourceAlias: string,
  branchColumns: ResolvedColumn[] | ResolvedUnionBranch['columns'] | undefined,
  dialect: SupportedDialect,
  entryRegistry: SourceEntryRegistry | undefined,
  transpile: TranspileFn
): string {
  const sourceEntry = getSourceEntry(entryRegistry, sourceRef);
  const sourceColumns = new Map(
    (sourceEntry?.columns ?? []).map((column) => [column.name.toLowerCase(), column])
  );
  const explicitColumns = new Map(
    (branchColumns ?? []).map((column) => [column.name.toLowerCase(), column.expr])
  );

  return columns
    .map((column) => {
      const explicitExpr = explicitColumns.get(column.name.toLowerCase());
      const sourceColumnName =
        column.sourceColumnName && sourceColumns.has(column.sourceColumnName.toLowerCase())
          ? column.sourceColumnName
          : sourceColumns.has(column.name.toLowerCase())
            ? column.name
            : undefined;
      const expression =
        explicitExpr ??
        (sourceColumnName
          ? `${caseName(sourceAlias, dialect)}.${caseName(sourceColumnName, dialect)}`
          : column.sourceColumnName
            ? undefined
            : column.defaultExpr);
      const projectedExpr = expression
        ? `SAFE_CAST(${transpile(expression)} AS ${column.castType})`
        : `CAST(NULL AS ${column.castType})`;
      return `${projectedExpr} AS ${quoteColumnAlias(column.name, dialect)}`;
    })
    .join(', ');
}

export function setOperationKeyword(operation: SetOperation, _dialect: SupportedDialect): string {
  switch (operation) {
    case 'union_all':
      return 'UNION ALL';
    case 'union':
      return 'UNION';
    case 'intersect':
      return 'INTERSECT';
    case 'except':
    case 'minus':
      return 'EXCEPT';
  }
}

/**
 * Append `<setOp> SELECT ... FROM <branchTable>` clauses to `rawSql` for
 * each union branch. Branches with `include_all_columns` get their own
 * `*` (or `* EXCEPT(...)`) plus any branch-level `columns:` appended after.
 * Branches with neither field fall back to `defaultBranchCols` (the main
 * SELECT's column list) — in that case the branch table is aliased with
 * the source's alias (`t0`) so any `t0.*` refs reused from the main
 * resolve against the branch's columns.
 */
export function appendSetOperations(
  rawSql: string,
  spec: ResolvedTransformSpec,
  defaultBranchCols: string,
  sourceAlias: string,
  dialect: SupportedDialect,
  entryRegistry: SourceEntryRegistry | undefined,
  transpile: TranspileFn,
  formatApiResourceRef: FormatApiResourceRefFn
): string {
  let result = rawSql;
  const canonicalBigQueryColumns = buildCanonicalBigQuerySetColumns(spec, dialect, entryRegistry);
  for (const branch of spec.union ?? []) {
    const branchEntry = getSourceEntry(entryRegistry, branch.ref);
    const reuseDefault = !branch.includeAllColumns && !branch.columns;
    const branchAlias = canonicalBigQueryColumns
      ? sourceAlias
      : reuseDefault
        ? sourceAlias
        : undefined;
    const branchTable =
      branchEntry?.kind === 'api_resource'
        ? formatApiResourceRef(branchEntry.fqRef, branchAlias, dialect)
        : formatTableRef(branch.fqTableName, branchAlias, dialect);

    let branchCols: string;
    if (canonicalBigQueryColumns) {
      branchCols = renderCanonicalBigQuerySetProjection(
        canonicalBigQueryColumns,
        branch.ref,
        sourceAlias,
        branch.columns,
        dialect,
        entryRegistry,
        transpile
      );
    } else if (reuseDefault) {
      branchCols = defaultBranchCols;
    } else {
      const parts: string[] = [];
      const starPart = buildSelectStarPart(
        branch.includeAllColumns,
        branch.excludeColumns,
        dialect
      );
      if (starPart) parts.push(starPart);
      if (branch.columns) {
        for (const c of branch.columns) {
          parts.push(`${transpile(c.expr)} AS ${quoteColumnAlias(c.name, dialect)}`);
        }
      }
      branchCols = parts.join(', ');
    }

    let branchSql = `SELECT ${branchCols} FROM ${branchTable}`;
    if (branch.filter) {
      branchSql += ` WHERE (${transpile(branch.filter)})`;
    }
    const setOp = setOperationKeyword(branch.operation ?? 'union_all', dialect);
    result += ` ${setOp} ${branchSql}`;
  }
  return result;
}

function directSourceColumnName(expr: string, sourceAlias: string): string | undefined {
  const trimmed = expr.trim();
  const match = DIRECT_COLUMN_RE.exec(trimmed);
  if (!match?.groups) return undefined;
  const table = match.groups['tableDq'] ?? match.groups['tableBt'] ?? match.groups['tableBare'];
  if (table && table.toLowerCase() !== sourceAlias.toLowerCase()) return undefined;
  return match.groups['dq'] ?? match.groups['bt'] ?? match.groups['bare'];
}

function findSourceColumn(
  columns: SourceEntryColumn[] | undefined,
  name: string
): SourceEntryColumn | undefined {
  return columns?.find((column) => column.name.toLowerCase() === name.toLowerCase());
}

function inferBigQueryTypeFromExpression(expr: string): string {
  const trimmed = expr.trim();
  if (/^'.*'$/.test(trimmed)) return 'STRING';
  if (/^(TRUE|FALSE)$/i.test(trimmed)) return 'BOOL';
  if (/^-?\d+$/.test(trimmed)) return 'INT64';
  if (/^-?\d+\.\d+$/.test(trimmed)) return 'NUMERIC';
  return 'STRING';
}

function toBigQueryCastType(type: string | undefined): string {
  const normalized = (type ?? 'STRING')
    .trim()
    .toUpperCase()
    .replace(/<.*>$/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ');

  if (
    ['STRING', 'VARCHAR', 'CHAR', 'CHARACTER', 'TEXT', 'NCHAR', 'NVARCHAR'].includes(normalized)
  ) {
    return 'STRING';
  }
  if (
    ['INT', 'INT8', 'INT16', 'INT32', 'INT64', 'INTEGER', 'BIGINT', 'SMALLINT'].includes(normalized)
  ) {
    return 'INT64';
  }
  if (['FLOAT', 'FLOAT32', 'FLOAT64', 'DOUBLE', 'DOUBLE PRECISION', 'REAL'].includes(normalized)) {
    return 'FLOAT64';
  }
  if (normalized === 'BIGNUMERIC') return 'BIGNUMERIC';
  if (['NUMERIC', 'DECIMAL', 'NUMBER', 'BIGDECIMAL', 'FIXED'].includes(normalized)) {
    return 'NUMERIC';
  }
  if (['BOOL', 'BOOLEAN'].includes(normalized)) return 'BOOL';
  if (normalized === 'DATE') return 'DATE';
  if (normalized === 'DATETIME') return 'DATETIME';
  if (normalized === 'TIME') return 'TIME';
  if (
    [
      'TIMESTAMP',
      'TIMESTAMPTZ',
      'TIMESTAMP_LTZ',
      'TIMESTAMP_NTZ',
      'TIMESTAMP_TZ',
      'TIMESTAMP WITH LOCAL TIME ZONE',
      'TIMESTAMP WITH TIME ZONE',
      'TIMESTAMP WITHOUT TIME ZONE',
    ].includes(normalized)
  ) {
    return 'TIMESTAMP';
  }
  if (
    ['JSON', 'JSONB', 'OBJECT', 'VARIANT', 'RECORD', 'STRUCT', 'MAP', 'ARRAY', 'LIST'].includes(
      normalized
    )
  ) {
    return 'JSON';
  }
  if (['BYTES', 'BINARY', 'VARBINARY', 'BYTEA', 'BLOB'].includes(normalized)) return 'BYTES';
  if (normalized === 'GEOGRAPHY') return 'GEOGRAPHY';
  if (normalized === 'INTERVAL') return 'INTERVAL';
  // GEOMETRY (Snowflake/Postgres) deliberately falls through to STRING: BigQuery
  // has no GEOMETRY type and rejects SAFE_CAST(<serialized> AS GEOGRAPHY) at
  // query analysis time — converting serialized geometry requires the
  // ST_GEOGFROM* family of constructor functions, which the canonical projection
  // can't dispatch without per-column encoding metadata. STRING keeps the value
  // queryable downstream; users who need real geography can declare an explicit
  // `type:` on the model column or pre-convert via raw_sql.
  // Unknown / future warehouse types fall back to STRING so SAFE_CAST keeps the
  // value queryable. Add explicit mappings above when a new type warrants
  // structural preservation (e.g. RANGE<T> would need parameterization).
  return 'STRING';
}
