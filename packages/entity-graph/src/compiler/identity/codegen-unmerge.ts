import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlStatement } from './types.js';
import { generateAuditInsertSql } from '../audit/codegen.js';
import { outputTableName } from '../output-tables/index.js';
import { concatSql } from './sql.js';

export interface GenerateUnmergeSqlOptions {
  entityName: string;
  targetSchema: string;
  dialect: SupportedDialect;
  clusterId: string;
  keepRecordIds: string[];
  reason: string;
  decisionBatchId: string;
  contentHash: string;
}

function literalRowsCte(
  name: string,
  columnName: string,
  values: string[],
  dialect: SupportedDialect
): string {
  const column = quoteIdentifier(columnName, dialect);
  const rows = values.map((value) => `  SELECT ${quoteLiteral(value, dialect)} AS ${column}`);
  return [`${name} AS (`, rows.join('\nUNION ALL\n'), `)`].join('\n');
}

function splitBoundaryCtes(options: GenerateUnmergeSqlOptions): string {
  const dialect = options.dialect;
  const clustersTable = buildFqName(
    options.targetSchema,
    outputTableName(options.entityName, '__clusters'),
    dialect
  );
  const recordId = quoteIdentifier('record_id', dialect);
  const clusterId = quoteIdentifier('cluster_id', dialect);

  return [
    `WITH ${literalRowsCte('requested_keep_records', 'record_id', options.keepRecordIds, dialect)},`,
    `cluster_members AS (`,
    `  SELECT ${recordId}`,
    `  FROM ${clustersTable}`,
    `  WHERE ${clusterId} = ${quoteLiteral(options.clusterId, dialect)}`,
    `),`,
    `keep_records AS (`,
    `  SELECT cm.${recordId}`,
    `  FROM cluster_members cm`,
    `  JOIN requested_keep_records kr ON cm.${recordId} = kr.${recordId}`,
    `),`,
    `moved_records AS (`,
    `  SELECT cm.${recordId}`,
    `  FROM cluster_members cm`,
    `  LEFT JOIN keep_records kr ON cm.${recordId} = kr.${recordId}`,
    `  WHERE kr.${recordId} IS NULL`,
    `    AND EXISTS (SELECT 1 FROM keep_records)`,
    `)`,
  ].join('\n');
}

export function generateUnmergeSql(options: GenerateUnmergeSqlOptions): SqlStatement[] {
  const dialect = options.dialect;
  const splitEventsTable = buildFqName(
    options.targetSchema,
    outputTableName(options.entityName, '__split_events'),
    dialect
  );
  const decisionsTable = buildFqName(
    options.targetSchema,
    outputTableName(options.entityName, '__review_decisions'),
    dialect
  );
  const scoresTable = buildFqName(
    options.targetSchema,
    outputTableName(options.entityName, '__pair_scores'),
    dialect
  );
  const recordId = quoteIdentifier('record_id', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const decisionBatchId = quoteIdentifier('decision_batch_id', dialect);
  const contentHash = quoteIdentifier('content_hash', dialect);

  const newClusterIdExpr = concatSql(
    [
      quoteLiteral('split-', dialect),
      quoteLiteral(options.clusterId, dialect),
      quoteLiteral('-', dialect),
      `moved.${recordId}`,
    ],
    dialect
  );

  return [
    generateAuditInsertSql({
      name: 'audit_unmerge',
      dialect,
      category: 'mutation',
      subjectType: 'cluster',
      subjectId: options.clusterId,
      clusterId: options.clusterId,
      reason: options.reason,
      actor: 'system',
      actorType: 'system',
      eventIdDiscriminator: options.contentHash,
      payload: {
        kind: 'unmerge',
        cluster_id: options.clusterId,
        kept_record_ids: options.keepRecordIds,
      },
    }),
    {
      name: 'record_split_events',
      sql: [
        splitBoundaryCtes(options),
        `INSERT INTO ${splitEventsTable}`,
        `  (${quoteIdentifier('original_cluster_id', dialect)}, ${quoteIdentifier('new_cluster_id', dialect)}, ${recordId}, ${quoteIdentifier('reason', dialect)}, ${quoteIdentifier('split_at', dialect)})`,
        `SELECT`,
        `  ${quoteLiteral(options.clusterId, dialect)},`,
        `  ${newClusterIdExpr},`,
        `  moved.${recordId},`,
        `  ${quoteLiteral(options.reason, dialect)},`,
        `  CURRENT_TIMESTAMP`,
        `FROM moved_records moved`,
        `WHERE NOT EXISTS (`,
        `  SELECT 1`,
        `  FROM ${splitEventsTable} existing`,
        `  WHERE existing.${quoteIdentifier('original_cluster_id', dialect)} = ${quoteLiteral(options.clusterId, dialect)}`,
        `    AND existing.${quoteIdentifier('new_cluster_id', dialect)} = ${newClusterIdExpr}`,
        `    AND existing.${recordId} = moved.${recordId}`,
        `)`,
      ].join('\n'),
    },
    {
      name: 'insert_unmerge_not_match_decisions',
      sql: [
        splitBoundaryCtes(options),
        `, affected_pairs AS (`,
        `  SELECT ps.${pairId}`,
        `  FROM ${scoresTable} ps`,
        `  JOIN keep_records kr`,
        `    ON ps.${recordAId} = kr.${recordId} OR ps.${recordBId} = kr.${recordId}`,
        `  JOIN moved_records mr`,
        `    ON ps.${recordAId} = mr.${recordId} OR ps.${recordBId} = mr.${recordId}`,
        `)`,
        `INSERT INTO ${decisionsTable}`,
        `  (${pairId}, ${quoteIdentifier('decision', dialect)}, ${quoteIdentifier('reviewer', dialect)}, ${quoteIdentifier('reason', dialect)}, ${quoteIdentifier('confidence', dialect)}, ${quoteIdentifier('proposed_decision', dialect)}, ${quoteIdentifier('proposed_confidence', dialect)}, ${quoteIdentifier('status', dialect)}, ${decisionBatchId}, ${contentHash}, ${quoteIdentifier('decision_source', dialect)}, ${quoteIdentifier('decided_at', dialect)}, ${quoteIdentifier('applied_at', dialect)})`,
        `SELECT DISTINCT`,
        `  affected.${pairId},`,
        `  ${quoteLiteral('not_match', dialect)},`,
        `  ${quoteLiteral('system', dialect)},`,
        `  ${quoteLiteral(options.reason, dialect)},`,
        `  1.0,`,
        `  NULL,`,
        `  NULL,`,
        `  ${quoteLiteral('applied', dialect)},`,
        `  ${quoteLiteral(options.decisionBatchId, dialect)},`,
        `  ${quoteLiteral(options.contentHash, dialect)},`,
        `  ${quoteLiteral('unmerge', dialect)},`,
        `  CURRENT_TIMESTAMP,`,
        `  CURRENT_TIMESTAMP`,
        `FROM affected_pairs affected`,
        `WHERE NOT EXISTS (`,
        `  SELECT 1`,
        `  FROM ${decisionsTable} existing`,
        `  WHERE existing.${decisionBatchId} = ${quoteLiteral(options.decisionBatchId, dialect)}`,
        `    AND existing.${contentHash} = ${quoteLiteral(options.contentHash, dialect)}`,
        `)`,
      ].join('\n'),
    },
    generateAuditInsertSql({
      name: 'audit_split',
      dialect,
      category: 'mutation',
      subjectType: 'cluster',
      subjectId: options.clusterId,
      clusterId: options.clusterId,
      reason: options.reason,
      actor: 'system',
      actorType: 'system',
      eventIdDiscriminator: options.contentHash,
      payload: {
        kind: 'split',
        original_cluster_id: options.clusterId,
      },
    }),
  ];
}
