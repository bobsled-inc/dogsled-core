import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SqlQueryRow,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { outputTableName } from '../compiler/output-tables/index.js';

function buildKeepRecordsInClusterQuery(
  entityName: string,
  targetSchema: string,
  clusterIdValue: string,
  keepRecordIds: string[],
  dialect: SupportedDialect
): string {
  const clustersTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__clusters'),
    dialect
  );
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const keepValues = keepRecordIds.map((id) => quoteLiteral(id, dialect)).join(', ');

  return [
    `SELECT ${recordId}`,
    `FROM ${clustersTable}`,
    `WHERE ${clusterId} = ${quoteLiteral(clusterIdValue, dialect)}`,
    `  AND ${recordId} IN (${keepValues})`,
  ].join('\n');
}

function buildClusterRecordIdsQuery(
  entityName: string,
  targetSchema: string,
  clusterIdValue: string,
  dialect: SupportedDialect
): string {
  const clustersTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__clusters'),
    dialect
  );
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);

  return [
    `SELECT ${recordId}`,
    `FROM ${clustersTable}`,
    `WHERE ${clusterId} = ${quoteLiteral(clusterIdValue, dialect)}`,
  ].join('\n');
}

function readRecordId(row: SqlQueryRow): string | undefined {
  const entry = Object.entries(row).find(([key]) => key.toLowerCase() === 'record_id');
  const value = entry?.[1];
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}

export async function filterKeepRecordIdsForCluster(
  query: (sql: string) => Promise<SqlQueryRow[]>,
  entityName: string,
  targetSchema: string,
  clusterIdValue: string,
  keepRecordIds: string[],
  dialect: SupportedDialect
): Promise<string[]> {
  const rows = await query(
    buildKeepRecordsInClusterQuery(entityName, targetSchema, clusterIdValue, keepRecordIds, dialect)
  );
  const confirmedIds = new Set(
    rows.map((row) => readRecordId(row)).filter((id): id is string => id !== undefined)
  );
  return keepRecordIds.filter((id) => confirmedIds.has(id));
}

export interface KeepRecordValidation {
  clusterRecordIds: string[];
  keepRecordIds: string[];
  missingRecordIds: string[];
  keepsEntireCluster: boolean;
}

export async function validateKeepRecordIdsForCluster(
  query: (sql: string) => Promise<SqlQueryRow[]>,
  entityName: string,
  targetSchema: string,
  clusterIdValue: string,
  keepRecordIds: string[],
  dialect: SupportedDialect
): Promise<KeepRecordValidation> {
  const rows = await query(
    buildClusterRecordIdsQuery(entityName, targetSchema, clusterIdValue, dialect)
  );
  const clusterRecordIds = rows
    .map((row) => readRecordId(row))
    .filter((recordId): recordId is string => recordId !== undefined);
  const clusterRecordIdSet = new Set(clusterRecordIds);
  const filteredKeepRecordIds = keepRecordIds.filter((id) => clusterRecordIdSet.has(id));
  const filteredKeepRecordIdSet = new Set(filteredKeepRecordIds);
  const missingRecordIds = keepRecordIds.filter((id) => !clusterRecordIdSet.has(id));

  return {
    clusterRecordIds,
    keepRecordIds: filteredKeepRecordIds,
    missingRecordIds,
    keepsEntireCluster:
      clusterRecordIdSet.size > 0 && filteredKeepRecordIdSet.size === clusterRecordIdSet.size,
  };
}
