/**
 * Blocking codegen — candidate pair generation via blocking keys.
 *
 * Self-joins the standardized table per blocking rule, generating
 * candidate pairs. Excludes previously rejected pairs via LEFT ANTI
 * JOIN on __not_match_edges.
 */

import {
  quoteIdentifier,
  buildFqName,
  createOrReplaceTableAs,
  getCanonicalDialect,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { qualifyBlockingExpression } from './sql.js';
import type { ResolutionIncrementalOptions } from './codegen-resolve-state.js';

/**
 * Generate SQL for the __candidate_pairs table.
 *
 * For each blocking rule: self-join standardized table on blocking key.
 * UNION ALL across rules → DISTINCT on (record_a_id, record_b_id).
 * LEFT ANTI JOIN on __not_match_edges to exclude rejected pairs.
 * Enforce candidate_limit if configured.
 */
export function generateBlockingSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  options?: { incremental?: ResolutionIncrementalOptions }
): SqlStatement {
  const entity = spec.entity;
  const stdTable = buildFqName(targetSchema, outputTableName(entity, '__standardized'), dialect);
  const leftStdTable = options?.incremental
    ? buildFqName(targetSchema, outputTableName(entity, '__standardized_delta'), dialect)
    : stdTable;
  const pairsTable = buildFqName(
    targetSchema,
    outputTableName(entity, options?.incremental ? '__candidate_pairs_delta' : '__candidate_pairs'),
    dialect
  );
  const nmeTable = buildFqName(targetSchema, outputTableName(entity, '__not_match_edges'), dialect);

  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const sourceA = quoteIdentifier('source_a', dialect);
  const sourceB = quoteIdentifier('source_b', dialect);
  const blockingRules = quoteIdentifier('blocking_rules', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const hasBlockingRules = (spec.blocking?.rules.length ?? 0) > 0;
  const recordAExpr = options?.incremental
    ? `LEAST(a_std.${recordId}, b_std.${recordId})`
    : `a_std.${recordId}`;
  const recordBExpr = options?.incremental
    ? `GREATEST(a_std.${recordId}, b_std.${recordId})`
    : `b_std.${recordId}`;
  const sourceAExpr = options?.incremental
    ? `CASE WHEN a_std.${recordId} < b_std.${recordId} THEN a_std.${sourceRef} ELSE b_std.${sourceRef} END`
    : `a_std.${sourceRef}`;
  const sourceBExpr = options?.incremental
    ? `CASE WHEN a_std.${recordId} < b_std.${recordId} THEN b_std.${sourceRef} ELSE a_std.${sourceRef} END`
    : `b_std.${sourceRef}`;
  const pairPredicate = options?.incremental
    ? `a_std.${recordId} <> b_std.${recordId}`
    : `a_std.${recordId} < b_std.${recordId}`;

  if (!hasBlockingRules) {
    let innerQuery = [
      `SELECT DISTINCT`,
      `  ${recordAExpr} AS ${recordAId},`,
      `  ${recordBExpr} AS ${recordBId},`,
      `  ${sourceAExpr} AS ${sourceA},`,
      `  ${sourceBExpr} AS ${sourceB},`,
      `  ${emptyJsonArray(dialect)} AS ${blockingRules}`,
      `FROM ${leftStdTable} a_std`,
      `JOIN ${stdTable} b_std ON ${pairPredicate}`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${nmeTable} nme`,
      `  WHERE nme.${recordAId} = ${recordAExpr}`,
      `    AND nme.${recordBId} = ${recordBExpr}`,
      `)`,
    ].join('\n');

    if (spec.blocking?.candidateLimit) {
      innerQuery += `\nORDER BY a_std.${recordId}, b_std.${recordId}`;
      innerQuery += `\nLIMIT ${spec.blocking.candidateLimit}`;
    }

    return {
      name: options?.incremental ? 'blocking_delta' : 'blocking',
      sql: `${createOrReplaceTableAs(pairsTable, dialect)}\n${innerQuery}`,
      tableCreated: outputTableName(
        entity,
        options?.incremental ? '__candidate_pairs_delta' : '__candidate_pairs'
      ),
    };
  }

  // spec.blocking is guaranteed defined here by the hasBlockingRules early return above.
  const blocking = spec.blocking!;

  // Build a SELECT per blocking rule
  const ruleSelects: string[] = [];

  for (const rule of blocking.rules) {
    const keyA = qualifyBlockingExpression(rule.key, 'a_std', dialect);
    const keyB = qualifyBlockingExpression(rule.key, 'b_std', dialect);

    ruleSelects.push(
      [
        `SELECT`,
        `  ${recordAExpr} AS ${recordAId},`,
        `  ${recordBExpr} AS ${recordBId},`,
        `  ${sourceAExpr} AS ${sourceA},`,
        `  ${sourceBExpr} AS ${sourceB},`,
        `  ${quoteLiteral(rule.name, dialect)} AS rule_name`,
        `FROM ${leftStdTable} a_std`,
        `JOIN ${stdTable} b_std`,
        `  ON ${keyA} = ${keyB}`,
        `  AND ${pairPredicate}`,
        `WHERE ${keyA} IS NOT NULL`,
      ].join('\n')
    );
  }

  // UNION ALL across rules, then aggregate blocking_rules as JSON array
  const unionAll = ruleSelects.join('\nUNION ALL\n');

  // JSON array aggregation for blocking_rules column varies by dialect
  const jsonAgg = jsonArrayAgg('rule_name', dialect);

  // Build the final query with DISTINCT pairs and aggregated rule names
  let innerQuery = [
    `WITH all_candidates AS (`,
    unionAll,
    `),`,
    `distinct_pairs AS (`,
    `  SELECT`,
    `    ${recordAId},`,
    `    ${recordBId},`,
    `    MIN(${sourceA}) AS ${sourceA},`,
    `    MIN(${sourceB}) AS ${sourceB},`,
    `    ${jsonAgg} AS ${blockingRules}`,
    `  FROM all_candidates`,
    `  GROUP BY ${recordAId}, ${recordBId}`,
    `)`,
    `SELECT dp.*`,
    `FROM distinct_pairs dp`,
    // LEFT ANTI JOIN to exclude previously rejected pairs
    `WHERE NOT EXISTS (`,
    `  SELECT 1 FROM ${nmeTable} nme`,
    `  WHERE nme.${recordAId} = dp.${recordAId}`,
    `    AND nme.${recordBId} = dp.${recordBId}`,
    `)`,
  ].join('\n');

  // Enforce candidate_limit with deterministic ordering
  if (blocking.candidateLimit) {
    innerQuery += `\nORDER BY dp.${recordAId}, dp.${recordBId}`;
    innerQuery += `\nLIMIT ${blocking.candidateLimit}`;
  }

  const sql = `${createOrReplaceTableAs(pairsTable, dialect)}\n${innerQuery}`;

  return {
    name: options?.incremental ? 'blocking_delta' : 'blocking',
    sql,
    tableCreated: outputTableName(
      entity,
      options?.incremental ? '__candidate_pairs_delta' : '__candidate_pairs'
    ),
  };
}

export function generateInsertCandidatePairsDeltaSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const pairsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__candidate_pairs'),
    dialect
  );
  const deltaTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__candidate_pairs_delta'),
    dialect
  );
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  return {
    name: 'insert_candidate_pairs_delta',
    sql: [
      `INSERT INTO ${pairsTable}`,
      `SELECT delta.*`,
      `FROM ${deltaTable} delta`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${pairsTable} existing`,
      `  WHERE existing.${recordAId} = delta.${recordAId}`,
      `    AND existing.${recordBId} = delta.${recordBId}`,
      `)`,
    ].join('\n'),
    tableCreated: outputTableName(entity, '__candidate_pairs'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dialect-specific JSON array aggregation. */
function jsonArrayAgg(column: string, dialect: SupportedDialect): string {
  // Redshift lacks JSON_AGG — use LISTAGG with manual JSON string escaping.
  // CHR() avoids JS/SQL escape ambiguity: CHR(92)=\, CHR(34)=", CHR(10)=LF, CHR(13)=CR, CHR(9)=TAB
  if (dialect === 'redshift') {
    const esc =
      `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column}, ` +
      `CHR(92), CHR(92) || CHR(92)), ` + // \ → \\
      `CHR(10), CHR(92) || CHR(110)), ` + // LF → \n
      `CHR(13), CHR(92) || CHR(114)), ` + // CR → \r
      `CHR(9), CHR(92) || CHR(116)), ` + // TAB → \t
      `CHR(34), CHR(92) || CHR(34))`; // " → \"
    return `'[' || LISTAGG(DISTINCT CHR(34) || ${esc} || CHR(34), ',') WITHIN GROUP (ORDER BY ${column}) || ']'`;
  }

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `ARRAY_AGG(DISTINCT ${column})::VARCHAR`;
    case 'bigquery':
      return `TO_JSON_STRING(ARRAY_AGG(DISTINCT ${column}))`;
    case 'postgres':
      return `JSON_AGG(DISTINCT ${column})::TEXT`;
    case 'duckdb':
      return `LIST(DISTINCT ${column})::VARCHAR`;
    case 'databricks':
      return `TO_JSON(COLLECT_SET(${column}))`;
    case 'mysql':
      return `JSON_ARRAYAGG(${column})`;
    case 'clickhouse':
      return `toJSONString(groupUniqArray(${column}))`;
  }
}

function emptyJsonArray(dialect: SupportedDialect): string {
  return getCanonicalDialect(dialect) === 'mysql' ? 'JSON_ARRAY()' : quoteLiteral('[]', dialect);
}
