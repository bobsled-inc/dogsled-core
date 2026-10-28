import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { AUDIT_LOG_TABLE, ENTITY_GRAPH_SCHEMA } from '../audit/codegen.js';
import { LINEAGE_TABLE } from '../lineage/codegen.js';
import { castToString } from '../identity/sql.js';

export type ExplainSubject = 'pair' | 'cluster' | 'edge' | 'entity';

export interface ExplainQueryOptions {
  subject: ExplainSubject;
  id: string;
  dialect: SupportedDialect;
  contractSchema?: string;
}

function contractTable(table: string, dialect: SupportedDialect, contractSchema?: string): string {
  return buildFqName(contractSchema ?? ENTITY_GRAPH_SCHEMA, table, dialect);
}

function selectSection(section: string, body: string, dialect: SupportedDialect): string {
  return [
    `SELECT`,
    `  ${quoteLiteral(section, dialect)} AS ${quoteIdentifier('section', dialect)},`,
    body,
  ].join('\n');
}

export function buildExplainQuery(options: ExplainQueryOptions): string {
  const schema = options.contractSchema;
  const id = quoteLiteral(options.id, options.dialect);
  switch (options.subject) {
    case 'entity':
      return [
        selectSection(
          'profile',
          [
            `  p.${quoteIdentifier('entity_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  p.${quoteIdentifier('profile_attrs', options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('entity_profiles', options.dialect, schema)} p`,
            `WHERE p.${quoteIdentifier('entity_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'quality',
          [
            `  q.${quoteIdentifier('entity_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ${castToString(`q.${quoteIdentifier('entity_trust_score', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('entity_quality_current', options.dialect, schema)} q`,
            `WHERE q.${quoteIdentifier('entity_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'provenance',
          [
            `  c.${quoteIdentifier('entity_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  c.${quoteIdentifier('source_pk_json', options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('crosswalks', options.dialect, schema)} c`,
            `WHERE c.${quoteIdentifier('entity_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'linked_entities',
          [
            `  e.${quoteIdentifier('edge_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  CASE WHEN e.${quoteIdentifier('left_entity_id', options.dialect)} = ${id} THEN e.${quoteIdentifier('right_entity_id', options.dialect)} ELSE e.${quoteIdentifier('left_entity_id', options.dialect)} END AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('relationship_edges', options.dialect, schema)} e`,
            `WHERE e.${quoteIdentifier('left_entity_id', options.dialect)} = ${id}`,
            `   OR e.${quoteIdentifier('right_entity_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'object_metadata',
          [
            `  o.${quoteIdentifier('name', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  o.${quoteIdentifier('links_json', options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('object_types', options.dialect, schema)} o`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'lineage_provenance',
          [
            `  ${castToString(`l.${quoteIdentifier('attribute', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ${castToString(`l.${quoteIdentifier('source_table', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable(LINEAGE_TABLE, options.dialect, schema)} l`,
            `WHERE (l.${quoteIdentifier('entity_id', options.dialect)} = ${id}`,
            `   OR l.${quoteIdentifier('entity_id', options.dialect)} IS NULL)`,
            `  AND l.${quoteIdentifier('entity_type', options.dialect)} IN (`,
            `    SELECT DISTINCT ep.${quoteIdentifier('entity_type', options.dialect)}`,
            `    FROM ${contractTable('entity_profiles', options.dialect, schema)} ep`,
            `    WHERE ep.${quoteIdentifier('entity_id', options.dialect)} = ${id}`,
            `  )`,
          ].join('\n'),
          options.dialect
        ),
      ].join('\n');
    case 'edge':
      return [
        selectSection(
          'edge',
          [
            `  e.${quoteIdentifier('edge_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ${castToString(`e.${quoteIdentifier('confidence', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('relationship_edges', options.dialect, schema)} e`,
            `WHERE e.${quoteIdentifier('edge_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'evidence',
          [
            `  ev.${quoteIdentifier('edge_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ev.${quoteIdentifier('evidence_json', options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('relationship_evidence', options.dialect, schema)} ev`,
            `WHERE ev.${quoteIdentifier('edge_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'audit',
          [
            `  a.${quoteIdentifier('subject_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ${castToString(`a.${quoteIdentifier('payload', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable(AUDIT_LOG_TABLE, options.dialect, schema)} a`,
            `WHERE a.${quoteIdentifier('subject_type', options.dialect)} = ${quoteLiteral('edge', options.dialect)}`,
            `  AND a.${quoteIdentifier('subject_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
      ].join('\n');
    case 'cluster': {
      const clusterId = quoteIdentifier('cluster_id', options.dialect);
      const entityId = quoteIdentifier('entity_id', options.dialect);
      const clusterIds = [
        `SELECT DISTINCT c_ids.${clusterId}`,
        `FROM ${contractTable('clusters', options.dialect, schema)} c_ids`,
        `WHERE c_ids.${clusterId} = ${id}`,
        `   OR c_ids.${entityId} = ${id}`,
      ].join('\n');
      return [
        selectSection(
          'cluster',
          [
            `  c.${clusterId} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  c.${quoteIdentifier('record_id', options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable('clusters', options.dialect, schema)} c`,
            `WHERE c.${clusterId} IN (${clusterIds})`,
          ].join('\n'),
          options.dialect
        ),
        `UNION ALL`,
        selectSection(
          'audit',
          [
            `  a.${quoteIdentifier('subject_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ${castToString(`a.${quoteIdentifier('payload', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable(AUDIT_LOG_TABLE, options.dialect, schema)} a`,
            `WHERE a.${quoteIdentifier('subject_type', options.dialect)} = ${quoteLiteral('cluster', options.dialect)}`,
            `  AND a.${quoteIdentifier('subject_id', options.dialect)} IN (${clusterIds})`,
          ].join('\n'),
          options.dialect
        ),
      ].join('\n');
    }
    case 'pair':
      return [
        selectSection(
          'audit',
          [
            `  a.${quoteIdentifier('subject_id', options.dialect)} AS ${quoteIdentifier('subject_id', options.dialect)},`,
            `  ${castToString(`a.${quoteIdentifier('payload', options.dialect)}`, options.dialect)} AS ${quoteIdentifier('payload_json', options.dialect)}`,
            `FROM ${contractTable(AUDIT_LOG_TABLE, options.dialect, schema)} a`,
            `WHERE a.${quoteIdentifier('subject_type', options.dialect)} = ${quoteLiteral('pair', options.dialect)}`,
            `  AND a.${quoteIdentifier('subject_id', options.dialect)} = ${id}`,
          ].join('\n'),
          options.dialect
        ),
      ].join('\n');
  }
}
