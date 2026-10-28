import {
  buildFqName,
  createOrReplaceTableAs,
  getCanonicalDialect,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlStatement } from '../identity/types.js';
import {
  buildJsonObjectExpr,
  concatSql,
  jsonExtractString,
  md5Expr,
  stringType,
} from '../identity/sql.js';
import { outputTableName, OUTPUT_TABLES } from '../output-tables/index.js';
import { fuzzyScoreExpr, inlineFuzzyUdf } from '../core/dialect-similarity.js';
import type {
  RelationshipCompileOptions,
  RelationshipCompileResult,
  ResolvedEntityRelationshipSpec,
} from './types.js';

function tableName(spec: ResolvedEntityRelationshipSpec, suffix: string): string {
  return outputTableName(spec.name, suffix);
}

function fqRelationTable(
  spec: ResolvedEntityRelationshipSpec,
  suffix: string,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  return buildFqName(targetSchema, tableName(spec, suffix), dialect);
}

function fqEntityProfileTable(
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  return buildFqName(targetSchema, outputTableName(entity, '__entity_profile'), dialect);
}

function entityType(entity: string, namespace: string): string {
  return `${namespace}.${entity}`;
}

function profileAttr(alias: 'l' | 'r', path: string, dialect: SupportedDialect): string {
  return jsonExtractString(`${alias}.${quoteIdentifier('profile_attrs', dialect)}`, path, dialect);
}

function currentTimestamp(dialect: SupportedDialect): string {
  return dialect === 'mysql' ? 'CURRENT_TIMESTAMP()' : 'CURRENT_TIMESTAMP';
}

function columnType(type: string, dialect: SupportedDialect): string {
  switch (type) {
    case 'STRING':
      return stringType(dialect);
    case 'FLOAT':
      if (dialect === 'bigquery') return 'FLOAT64';
      if (dialect === 'postgres' || dialect === 'pgvector') return 'DOUBLE PRECISION';
      return 'FLOAT';
    case 'TIMESTAMP':
      return dialect === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
    default:
      return type;
  }
}

function createIfNotExistsDdl(
  spec: ResolvedEntityRelationshipSpec,
  suffix: string,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const def = OUTPUT_TABLES.get(suffix);
  const fullName = fqRelationTable(spec, suffix, dialect, targetSchema);
  const columns = def.columns
    .map(
      (column) => `  ${quoteIdentifier(column.name, dialect)} ${columnType(column.type, dialect)}`
    )
    .join(',\n');

  return {
    name: `ddl_${suffix.replace(/^__/, '')}`,
    sql: `CREATE TABLE IF NOT EXISTS ${fullName} (\n${columns}\n)`,
    tableCreated: tableName(spec, suffix),
  };
}

function candidateJoinCondition(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect
): string {
  return spec.joinColumns
    .map((pair) => {
      const left = profileAttr('l', pair.left, dialect);
      const right = profileAttr('r', pair.right, dialect);
      return `${left} IS NOT NULL AND ${right} IS NOT NULL AND ${left} = ${right}`;
    })
    .join('\n   AND ');
}

function joinValuesExpr(spec: ResolvedEntityRelationshipSpec, dialect: SupportedDialect): string {
  const entries = spec.joinColumns.flatMap((pair) => [
    [`left.${pair.left}`, profileAttr('l', pair.left, dialect)] as const,
    [`right.${pair.right}`, profileAttr('r', pair.right, dialect)] as const,
  ]);
  return buildJsonObjectExpr(entries, dialect);
}

export function generateRelationshipCandidatesSql(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  options: RelationshipCompileOptions
): SqlStatement {
  const targetSchema = spec.targetSchema ?? options.targetSchema;
  const table = fqRelationTable(spec, '__relationship_candidates', dialect, targetSchema);
  const leftProfiles = fqEntityProfileTable(spec.leftEntity, dialect, targetSchema);
  const rightProfiles = fqEntityProfileTable(spec.rightEntity, dialect, targetSchema);
  const leftEntityType = entityType(spec.leftEntity, options.namespace);
  const rightEntityType = entityType(spec.rightEntity, options.namespace);
  const edgeIdExpr = md5Expr(
    concatSql(
      [
        quoteLiteral(spec.name, dialect),
        quoteLiteral('|', dialect),
        `l.${quoteIdentifier('entity_id', dialect)}`,
        quoteLiteral('|', dialect),
        `COALESCE(r.${quoteIdentifier('entity_id', dialect)}, ${quoteLiteral('', dialect)})`,
      ],
      dialect
    ),
    dialect
  );
  const joinKind = spec.joinType === 'left' ? 'LEFT JOIN' : 'JOIN';
  const joinClauses = [
    candidateJoinCondition(spec, dialect),
    ...(spec.leftEntity === spec.rightEntity
      ? [`l.${quoteIdentifier('entity_id', dialect)} <> r.${quoteIdentifier('entity_id', dialect)}`]
      : []),
  ];
  const whereClauses = [
    ...(spec.joinType === 'left' ? [] : [`r.${quoteIdentifier('entity_id', dialect)} IS NOT NULL`]),
  ];

  const sql = [
    createOrReplaceTableAs(table, dialect),
    `SELECT`,
    `  ${edgeIdExpr} AS ${quoteIdentifier('edge_id', dialect)},`,
    `  ${quoteLiteral(spec.name, dialect)} AS ${quoteIdentifier('relation_name', dialect)},`,
    `  ${quoteLiteral(leftEntityType, dialect)} AS ${quoteIdentifier('left_entity_type', dialect)},`,
    `  l.${quoteIdentifier('entity_id', dialect)} AS ${quoteIdentifier('left_entity_id', dialect)},`,
    `  ${quoteLiteral(rightEntityType, dialect)} AS ${quoteIdentifier('right_entity_type', dialect)},`,
    `  r.${quoteIdentifier('entity_id', dialect)} AS ${quoteIdentifier('right_entity_id', dialect)},`,
    `  ${joinValuesExpr(spec, dialect)} AS ${quoteIdentifier('join_values_json', dialect)},`,
    `  CASE WHEN r.${quoteIdentifier('entity_id', dialect)} IS NULL THEN ${quoteLiteral('unmatched', dialect)} ELSE ${quoteLiteral('candidate', dialect)} END AS ${quoteIdentifier('candidate_status', dialect)},`,
    `  ${currentTimestamp(dialect)} AS ${quoteIdentifier('candidate_at', dialect)}`,
    `FROM ${leftProfiles} l`,
    `${joinKind} ${rightProfiles} r`,
    `  ON ${joinClauses.join('\n   AND ')}`,
    ...(whereClauses.length > 0 ? [`WHERE ${whereClauses.join('\n  AND ')}`] : []),
  ].join('\n');

  return {
    name: 'relationship_candidates',
    sql,
    tableCreated: tableName(spec, '__relationship_candidates'),
  };
}

function scoringExpression(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect
): string {
  const features = spec.confidenceScoring?.features;
  if (!features || features.length === 0) {
    return '1.0';
  }

  const totalWeight = features.reduce((sum, feature) => sum + feature.weight, 0);
  const weighted = features.map((feature) => {
    const match = spec.joinColumns.find(
      (pair) => pair.left === feature.field || pair.right === feature.field
    );
    const left = profileAttr('l', match?.left ?? feature.field, dialect);
    const right = profileAttr('r', match?.right ?? feature.field, dialect);
    const score = fuzzyScoreExpr(feature.algorithm, left, right, dialect);
    return `(${score}) * ${feature.weight}`;
  });

  return `(${weighted.join(' + ')}) / ${totalWeight}`;
}

export function generateRelationshipEvidenceSql(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  options: RelationshipCompileOptions
): SqlStatement {
  const targetSchema = spec.targetSchema ?? options.targetSchema;
  const table = fqRelationTable(spec, '__relationship_evidence', dialect, targetSchema);
  const candidates = fqRelationTable(spec, '__relationship_candidates', dialect, targetSchema);
  const evidenceJson = buildJsonObjectExpr(
    [
      ['left_entity_id', `c.${quoteIdentifier('left_entity_id', dialect)}`],
      ['right_entity_id', `c.${quoteIdentifier('right_entity_id', dialect)}`],
      ['join_values', `c.${quoteIdentifier('join_values_json', dialect)}`],
    ],
    dialect
  );
  const score = scoringExpression(spec, dialect);
  const leftProfiles = fqEntityProfileTable(spec.leftEntity, dialect, targetSchema);
  const rightProfiles = fqEntityProfileTable(spec.rightEntity, dialect, targetSchema);

  const sql = [
    createOrReplaceTableAs(table, dialect),
    `SELECT`,
    `  c.${quoteIdentifier('edge_id', dialect)},`,
    `  c.${quoteIdentifier('relation_name', dialect)},`,
    `  ${quoteLiteral('profile_join', dialect)} AS ${quoteIdentifier('evidence_type', dialect)},`,
    `  ${evidenceJson} AS ${quoteIdentifier('evidence_json', dialect)},`,
    `  ${score} AS ${quoteIdentifier('score', dialect)},`,
    `  ${currentTimestamp(dialect)} AS ${quoteIdentifier('evaluated_at', dialect)}`,
    `FROM ${candidates} c`,
    `JOIN ${leftProfiles} l ON c.${quoteIdentifier('left_entity_id', dialect)} = l.${quoteIdentifier('entity_id', dialect)}`,
    `JOIN ${rightProfiles} r ON c.${quoteIdentifier('right_entity_id', dialect)} = r.${quoteIdentifier('entity_id', dialect)}`,
  ].join('\n');

  return {
    name: 'relationship_evidence',
    sql,
    tableCreated: tableName(spec, '__relationship_evidence'),
  };
}

function latestDecisionCte(decisions: string, dialect: SupportedDialect): string {
  return [
    `latest_decisions AS (`,
    `  SELECT *`,
    `  FROM (`,
    `    SELECT`,
    `      d.*,`,
    `      ROW_NUMBER() OVER (PARTITION BY d.${quoteIdentifier('edge_id', dialect)} ORDER BY d.${quoteIdentifier('applied_at', dialect)} DESC, d.${quoteIdentifier('decided_at', dialect)} DESC) AS ${quoteIdentifier('rn', dialect)}`,
    `    FROM ${decisions} d`,
    `  ) ranked`,
    `  WHERE ${quoteIdentifier('rn', dialect)} = 1`,
    `)`,
  ].join('\n');
}

export function generateRelationshipEdgesSql(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  options: RelationshipCompileOptions
): SqlStatement {
  const targetSchema = spec.targetSchema ?? options.targetSchema;
  const table = fqRelationTable(spec, '__relationship_edges', dialect, targetSchema);
  const candidates = fqRelationTable(spec, '__relationship_candidates', dialect, targetSchema);
  const evidence = fqRelationTable(spec, '__relationship_evidence', dialect, targetSchema);
  const decisions = fqRelationTable(spec, '__relationship_decisions', dialect, targetSchema);
  const autoConfirm = spec.review.thresholds.auto_confirm;

  const sql = [
    createOrReplaceTableAs(table, dialect),
    `WITH ${latestDecisionCte(decisions, dialect)},`,
    `scored AS (`,
    `  SELECT`,
    `    c.*,`,
    `    MAX(e.${quoteIdentifier('score', dialect)}) AS ${quoteIdentifier('confidence', dialect)}`,
    `  FROM ${candidates} c`,
    `  JOIN ${evidence} e ON c.${quoteIdentifier('edge_id', dialect)} = e.${quoteIdentifier('edge_id', dialect)}`,
    `  WHERE c.${quoteIdentifier('right_entity_id', dialect)} IS NOT NULL`,
    `  GROUP BY`,
    `    c.${quoteIdentifier('edge_id', dialect)},`,
    `    c.${quoteIdentifier('relation_name', dialect)},`,
    `    c.${quoteIdentifier('left_entity_type', dialect)},`,
    `    c.${quoteIdentifier('left_entity_id', dialect)},`,
    `    c.${quoteIdentifier('right_entity_type', dialect)},`,
    `    c.${quoteIdentifier('right_entity_id', dialect)},`,
    `    c.${quoteIdentifier('join_values_json', dialect)},`,
    `    c.${quoteIdentifier('candidate_status', dialect)},`,
    `    c.${quoteIdentifier('candidate_at', dialect)}`,
    `)`,
    `SELECT`,
    `  s.${quoteIdentifier('edge_id', dialect)},`,
    `  s.${quoteIdentifier('relation_name', dialect)},`,
    `  s.${quoteIdentifier('left_entity_type', dialect)},`,
    `  s.${quoteIdentifier('left_entity_id', dialect)},`,
    `  s.${quoteIdentifier('right_entity_type', dialect)},`,
    `  s.${quoteIdentifier('right_entity_id', dialect)},`,
    `  s.${quoteIdentifier('confidence', dialect)},`,
    `  CASE WHEN d.${quoteIdentifier('decision', dialect)} = ${quoteLiteral('confirm', dialect)} THEN ${quoteLiteral('confirmed', dialect)} ELSE ${quoteLiteral('auto_confirmed', dialect)} END AS ${quoteIdentifier('status', dialect)},`,
    `  NULL AS ${quoteIdentifier('valid_from', dialect)},`,
    `  NULL AS ${quoteIdentifier('valid_to', dialect)},`,
    `  d.${quoteIdentifier('decided_at', dialect)}`,
    `FROM scored s`,
    `LEFT JOIN latest_decisions d ON s.${quoteIdentifier('edge_id', dialect)} = d.${quoteIdentifier('edge_id', dialect)}`,
    `WHERE d.${quoteIdentifier('decision', dialect)} = ${quoteLiteral('confirm', dialect)}`,
    `   OR (d.${quoteIdentifier('decision', dialect)} IS NULL AND s.${quoteIdentifier('confidence', dialect)} >= ${quoteLiteral(autoConfirm, dialect)})`,
  ].join('\n');

  return {
    name: 'relationship_edges',
    sql,
    tableCreated: tableName(spec, '__relationship_edges'),
  };
}

export function generateRelationshipReviewQueueSql(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  options: RelationshipCompileOptions
): SqlStatement {
  const targetSchema = spec.targetSchema ?? options.targetSchema;
  const table = fqRelationTable(spec, '__relationship_review_queue', dialect, targetSchema);
  const candidates = fqRelationTable(spec, '__relationship_candidates', dialect, targetSchema);
  const evidence = fqRelationTable(spec, '__relationship_evidence', dialect, targetSchema);
  const decisions = fqRelationTable(spec, '__relationship_decisions', dialect, targetSchema);
  const review = spec.review.thresholds.review;
  const autoConfirm = spec.review.thresholds.auto_confirm;

  const sql = [
    createOrReplaceTableAs(table, dialect),
    `WITH ${latestDecisionCte(decisions, dialect)}`,
    `SELECT`,
    `  c.${quoteIdentifier('edge_id', dialect)},`,
    `  c.${quoteIdentifier('relation_name', dialect)},`,
    `  c.${quoteIdentifier('left_entity_id', dialect)},`,
    `  c.${quoteIdentifier('right_entity_id', dialect)},`,
    `  e.${quoteIdentifier('score', dialect)} AS ${quoteIdentifier('confidence', dialect)},`,
    `  ${quoteLiteral('review', dialect)} AS ${quoteIdentifier('threshold_band', dialect)},`,
    `  e.${quoteIdentifier('evidence_json', dialect)},`,
    `  ${quoteLiteral('confirm', dialect)} AS ${quoteIdentifier('recommended_action', dialect)},`,
    `  ${currentTimestamp(dialect)} AS ${quoteIdentifier('queued_at', dialect)}`,
    `FROM ${candidates} c`,
    `JOIN ${evidence} e ON c.${quoteIdentifier('edge_id', dialect)} = e.${quoteIdentifier('edge_id', dialect)}`,
    `LEFT JOIN latest_decisions d ON c.${quoteIdentifier('edge_id', dialect)} = d.${quoteIdentifier('edge_id', dialect)}`,
    `WHERE c.${quoteIdentifier('right_entity_id', dialect)} IS NOT NULL`,
    `  AND d.${quoteIdentifier('edge_id', dialect)} IS NULL`,
    `  AND e.${quoteIdentifier('score', dialect)} >= ${quoteLiteral(review, dialect)}`,
    `  AND e.${quoteIdentifier('score', dialect)} < ${quoteLiteral(autoConfirm, dialect)}`,
  ].join('\n');

  return {
    name: 'relationship_review_queue',
    sql,
    tableCreated: tableName(spec, '__relationship_review_queue'),
  };
}

export function compileEntityRelationship(
  spec: ResolvedEntityRelationshipSpec,
  dialect: SupportedDialect,
  options: RelationshipCompileOptions
): RelationshipCompileResult {
  const targetSchema = spec.targetSchema ?? options.targetSchema;
  const statements = [
    createIfNotExistsDdl(spec, '__relationship_decisions', dialect, targetSchema),
    generateRelationshipCandidatesSql(spec, dialect, options),
    generateRelationshipEvidenceSql(spec, dialect, options),
    generateRelationshipEdgesSql(spec, dialect, options),
    generateRelationshipReviewQueueSql(spec, dialect, options),
  ];

  // On BigQuery, inline the Jaro-Winkler UDF into each statement that calls it
  // (e.g. the confidence-scoring evidence statement). No-op for other dialects.
  return {
    statements: inlineFuzzyUdf(statements, getCanonicalDialect(dialect)),
    warnings: [],
  };
}
