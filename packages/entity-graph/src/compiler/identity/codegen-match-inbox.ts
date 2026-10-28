import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { outputTableName } from '../output-tables/index.js';
import { jsonExtractString } from './sql.js';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';

function inboxJsonValue(
  alias: string,
  jsonColumn: string,
  key: string,
  dialect: SupportedDialect
): string {
  return jsonExtractString(`${alias}.${quoteIdentifier(jsonColumn, dialect)}`, key, dialect);
}

export function generateInsertMatchInboxDeltaSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const deltaTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized_delta'),
    dialect
  );
  const inboxTable = buildFqName(targetSchema, outputTableName(entity, '__match_inbox'), dialect);
  const inboxAlias = quoteIdentifier('inbox', dialect);

  const columns = [
    'record_id',
    'source_ref',
    'source_pk_json',
    '_source_system',
    '_source_entity_id',
    '_standardized_at',
    ...spec.standardize.map((std) => `standardized_${std.field}`),
  ];
  const values = [
    `${inboxAlias}.${quoteIdentifier('record_id', dialect)}`,
    `${inboxAlias}.${quoteIdentifier('source_ref', dialect)}`,
    `${inboxAlias}.${quoteIdentifier('source_pk_json', dialect)}`,
    `${inboxAlias}.${quoteIdentifier('source_ref', dialect)}`,
    `${inboxAlias}.${quoteIdentifier('source_entity_id', dialect)}`,
    'CURRENT_TIMESTAMP',
    ...spec.standardize.map((std) =>
      inboxJsonValue(inboxAlias, 'standardized_json', `standardized_${std.field}`, dialect)
    ),
  ];

  const standardizedTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized'),
    dialect
  );
  const recordId = quoteIdentifier('record_id', dialect);
  return {
    name: 'insert_match_inbox_delta',
    sql: [
      `INSERT INTO ${deltaTable} (`,
      columns.map((column) => `  ${quoteIdentifier(column, dialect)}`).join(',\n'),
      `)`,
      `SELECT`,
      values.map((value) => `  ${value}`).join(',\n'),
      `FROM ${inboxTable} AS ${inboxAlias}`,
      // Pending rows are the normal drain path. Already-drained (or assigned)
      // rows re-qualify when their record no longer exists in __standardized —
      // a full rebuild recreates that table from warehouse sources only, so
      // API-ingested records would otherwise vanish permanently after the next
      // full run. This anti-join makes the inbox the durable ledger of record.
      `WHERE (`,
      `    (${inboxAlias}.${quoteIdentifier('status', dialect)} = ${quoteLiteral('pending', dialect)} AND ${inboxAlias}.${quoteIdentifier('drained_at', dialect)} IS NULL)`,
      `    OR NOT EXISTS (`,
      `      SELECT 1 FROM ${standardizedTable} existing_std`,
      `      WHERE existing_std.${recordId} = ${inboxAlias}.${recordId}`,
      `    )`,
      `  )`,
      // A staged record can also arrive through its warehouse source table in
      // the same run; without this anti-join the delta would carry the same
      // record_id twice and __standardized would end up with duplicate rows.
      `  AND NOT EXISTS (`,
      `    SELECT 1 FROM ${deltaTable} existing_delta`,
      `    WHERE existing_delta.${recordId} = ${inboxAlias}.${recordId}`,
      `  )`,
    ].join('\n'),
    tableCreated: outputTableName(entity, '__standardized_delta'),
  };
}

export function generateMarkMatchInboxDrainedSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  runId: string
): SqlStatement {
  const entity = spec.entity;
  const inboxTable = buildFqName(targetSchema, outputTableName(entity, '__match_inbox'), dialect);
  const deltaTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__standardized_delta'),
    dialect
  );
  const recordId = quoteIdentifier('record_id', dialect);
  return {
    name: 'mark_match_inbox_drained',
    sql: [
      `UPDATE ${inboxTable}`,
      `SET ${quoteIdentifier('status', dialect)} = ${quoteLiteral('drained', dialect)},`,
      `    ${quoteIdentifier('drained_run_id', dialect)} = ${quoteLiteral(runId, dialect)},`,
      `    ${quoteIdentifier('drained_at', dialect)} = CURRENT_TIMESTAMP`,
      // Scope the drain to rows this run actually ingested: a stage() call
      // landing between the delta insert and this UPDATE must stay pending —
      // the previous status-only predicate marked such rows drained without
      // ever processing them, silently losing the record.
      `WHERE ${quoteIdentifier('status', dialect)} = ${quoteLiteral('pending', dialect)}`,
      `  AND ${quoteIdentifier('drained_at', dialect)} IS NULL`,
      `  AND ${recordId} IN (SELECT ${recordId} FROM ${deltaTable})`,
    ].join('\n'),
    tableCreated: outputTableName(entity, '__match_inbox'),
  };
}
