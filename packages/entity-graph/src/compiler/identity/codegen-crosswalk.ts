/**
 * Crosswalk codegen — source-to-cluster mapping.
 *
 * Generates the __crosswalks table that maps every source record
 * to its cluster. Used by downstream joins and UI lookups.
 */

import { quoteIdentifier, buildFqName, createOrReplaceTableAs } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';

/**
 * Generate SQL for the __crosswalks table.
 *
 * Reads from __clusters to produce the source-to-entity mapping:
 * source_system, source_entity_id, entity_id, cluster_id, component_id,
 * confidence_score, matched_at.
 */
export function generateCrosswalkSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const crosswalksTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__crosswalks'),
    dialect
  );

  const sourceSystem = quoteIdentifier('source_system', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const componentId = quoteIdentifier('component_id', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const matchedAt = quoteIdentifier('matched_at', dialect);
  const recordId = quoteIdentifier('record_id', dialect);

  const sql = [
    createOrReplaceTableAs(crosswalksTable, dialect),
    `SELECT`,
    `  c.${recordId},`,
    `  c.${sourceRef},`,
    `  c.${sourcePkJson},`,
    `  c.${sourceSystem},`,
    `  c.${sourceEntityId},`,
    `  c.${entityId},`,
    `  c.${clusterId},`,
    `  c.${componentId},`,
    `  c.${confidenceScore},`,
    `  c.${quoteIdentifier('clustered_at', dialect)} AS ${matchedAt}`,
    `FROM ${clustersTable} c`,
  ].join('\n');

  return {
    name: 'crosswalk',
    sql,
    tableCreated: outputTableName(entity, '__crosswalks'),
  };
}
