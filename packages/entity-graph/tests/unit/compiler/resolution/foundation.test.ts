import { describe, expect, it } from 'vitest';
import type { SupportedDialect } from '@bobsled-inc/model-spec';

import {
  buildAuditListQuery,
  buildAuditVerifyQuery,
  generateAuditInsertSql,
  generateAuditLogDdl,
  generateReviewApplyAuditSql,
} from '../../../../src/compiler/audit/codegen.js';
import { generateEntityGraphUnionSql } from '../../../../src/compiler/entity-graph/codegen.js';
import { generateUnmergeSql } from '../../../../src/compiler/identity/codegen-unmerge.js';
import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';
import type { ResolvedObjectSpec } from '../../../../src/compiler/object/types.js';
import type { ResolvedEntityRelationshipSpec } from '../../../../src/compiler/relationship/types.js';

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'crm.accounts',
      fqTableName: 'RAW.ACCOUNTS',
      alias: 's0',
      idFields: ['account_id'],
    },
  ],
  standardize: [
    { field: 'company_name', transforms: ['lowercase'] },
    { field: 'domain', transforms: ['lowercase'] },
  ],
  deterministicRules: [],
  thresholds: {
    autoMerge: 0.9,
    review: 0.6,
    autoReject: 0.4,
  },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'ENTITY_GRAPH',
};

const SPEC_WITH_METADATA: ResolvedResolutionSpec = {
  ...SPEC,
  inputs: [
    {
      ...SPEC.inputs[0]!,
      sourceFieldMetadata: {
        domain: {
          name: 'domain',
          type: 'string',
          description: 'Raw company domain.',
          semantic_role: 'url',
          format: 'hostname',
        },
      },
    },
  ],
  profile: {
    displayName: { field: 'company_name' },
    attributes: [{ field: 'domain', alias: 'website' }],
    quality: {
      freshnessWindows: [{ days: 7, score: 1 }],
      sourceDiversityCap: 3,
      trustWeights: {
        identity: 0.4,
        freshness: 0.25,
        diversity: 0.2,
        coverage: 0.15,
      },
      trustTierThresholds: {
        trusted: 0.85,
        monitor: 0.7,
        review: 0.5,
      },
    },
    activations: [],
  },
  semanticOverrides: {
    website: {
      description: 'Primary website used for account matching.',
      pii: false,
    },
  },
};

const RELATIONSHIP: ResolvedEntityRelationshipSpec = {
  name: 'works_at',
  leftEntity: 'contact',
  rightEntity: 'company',
  joinColumns: [{ left: 'email_domain', right: 'domain' }],
  joinType: 'inner',
  relationshipType: 'many_to_one',
  review: {
    thresholds: {
      auto_confirm: 0.92,
      review: 0.65,
      auto_reject: 0.4,
    },
  },
  targetSchema: 'ENTITY_GRAPH',
};

const OBJECT: ResolvedObjectSpec = {
  name: 'company',
  identityResolutionRef: './company_resolution.yml',
  links: [
    {
      relationRef: './works_at.entity-relationship.yml',
      relationName: 'works_at',
      direction: 'inbound',
    },
  ],
  actions: [],
};

describe('audit foundation codegen', () => {
  it('creates entity_graph.audit_log DDL', () => {
    const statements = generateAuditLogDdl('snowflake');

    expect(statements.map((statement) => statement.name)).toEqual([
      'ddl_entity_graph_schema',
      'ddl_audit_log',
    ]);
    expect(statements[1]?.sql).toContain('"ENTITY_GRAPH"."AUDIT_LOG"');
    expect(statements[1]?.sql).toContain('"PAYLOAD" VARIANT');
  });

  it('builds review apply audit SQL with content-hash skip detection', () => {
    const statement = generateReviewApplyAuditSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'snowflake',
      decisionBatchId: 'batch-1',
      contentHash: 'abc123',
      decisionCount: 2,
      mergeCount: 1,
      notMatchCount: 1,
      deferredCount: 0,
      escalatedCount: 0,
      decisionSource: 'human',
    });

    expect(statement.sql).toContain('"ENTITY_GRAPH"."AUDIT_LOG"');
    expect(statement.sql).toContain('"ENTITY_GRAPH"."COMPANY__REVIEW_DECISIONS"');
    expect(statement.sql).toContain("'review_apply'");
    expect(statement.sql).toContain("'abc123'");
    expect(statement.sql).toContain('WHERE NOT EXISTS');
    expect(statement.sql).toContain('existing."EVENT_ID"');
  });

  it('embeds the decision trace in the review apply payload (nested JSON per dialect)', () => {
    const snowflake = generateReviewApplyAuditSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'snowflake',
      decisionBatchId: 'batch-1',
      contentHash: 'abc123',
      decisionCount: 2,
      mergeCount: 1,
      notMatchCount: 1,
      deferredCount: 0,
      escalatedCount: 0,
      decisionSource: 'agent',
      policyVersion: 'pol-1',
      configSnapshot: { spec: 'company_resolution', auto_apply_threshold: 0.75 },
      langsmithTraceId: 'ls-1',
      precedentRefs: ['batch-0', 'p7'],
      learningContext: 'cited prior merge',
    });

    expect(snowflake.sql).toContain('policy_version');
    expect(snowflake.sql).toContain("'pol-1'");
    expect(snowflake.sql).toContain('langsmith_trace_id');
    expect(snowflake.sql).toContain("'ls-1'");
    expect(snowflake.sql).toContain('config_snapshot');
    expect(snowflake.sql).toContain('auto_apply_threshold');
    // Nested object + array ride as dialect-native JSON values (Snowflake PARSE_JSON).
    expect(snowflake.sql).toContain('PARSE_JSON(');
    expect(snowflake.sql).toContain('precedent_refs');
    expect(snowflake.sql).toContain('batch-0');
    // actor_type derives from decision_source — an agent apply writes 'agent'.
    expect(snowflake.sql).toContain("'agent'");
    // learning_context lands in the audit `reason` column (no longer NULL).
    expect(snowflake.sql).toContain("'cited prior merge'");

    // Postgres encodes the nested values as ::jsonb.
    const postgres = generateReviewApplyAuditSql({
      entityName: 'company',
      targetSchema: 'entity_graph',
      dialect: 'postgres',
      decisionBatchId: 'batch-1',
      contentHash: 'abc123',
      decisionCount: 1,
      mergeCount: 1,
      notMatchCount: 0,
      deferredCount: 0,
      escalatedCount: 0,
      decisionSource: 'agent',
      configSnapshot: { dialect: 'postgres' },
      precedentRefs: ['ref-1'],
    });
    expect(postgres.sql).toContain('::jsonb');
    expect(postgres.sql).toContain('config_snapshot');
    expect(postgres.sql).toContain('precedent_refs');
  });

  it('omits trace fields and keeps reason NULL when no trace is supplied (back-compat)', () => {
    const statement = generateReviewApplyAuditSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'snowflake',
      decisionBatchId: 'batch-1',
      contentHash: 'abc123',
      decisionCount: 1,
      mergeCount: 1,
      notMatchCount: 0,
      deferredCount: 0,
      escalatedCount: 0,
      decisionSource: 'human',
    });

    expect(statement.sql).not.toContain('policy_version');
    expect(statement.sql).not.toContain('config_snapshot');
    expect(statement.sql).not.toContain('langsmith_trace_id');
    expect(statement.sql).not.toContain('precedent_refs');
    // With no learning_context, the audit row's `reason` column stays NULL —
    // the slot immediately before the actor literal ('human' for a human apply).
    expect(statement.sql).toContain("NULL,\n  'human',");
  });

  it('uses a singleton FROM source for Databricks audit inserts', () => {
    const mutation = generateAuditInsertSql({
      name: 'audit_unmerge',
      dialect: 'databricks',
      category: 'mutation',
      subjectType: 'cluster',
      subjectId: 'cluster-1',
      payload: {
        kind: 'unmerge',
        cluster_id: 'cluster-1',
        kept_record_ids: ['r1'],
      },
    });
    const reviewApply = generateReviewApplyAuditSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'databricks',
      decisionBatchId: 'batch-1',
      contentHash: 'abc123',
      decisionCount: 2,
      mergeCount: 1,
      notMatchCount: 1,
      deferredCount: 0,
      escalatedCount: 0,
      decisionSource: 'human',
    });

    expect(mutation.sql).toContain('FROM VALUES (1) AS `audit_source`(`dummy`)');
    expect(reviewApply.sql).toContain('FROM VALUES (1) AS `audit_source`(`dummy`)');
    expect(reviewApply.sql).toContain('WHERE NOT EXISTS');
  });

  it('builds audit list and verify queries', () => {
    expect(buildAuditListQuery('duckdb', { clusterId: '1' })).toContain(`WHERE "cluster_id" = '1'`);
    const verifyQuery = buildAuditVerifyQuery('duckdb');
    expect(verifyQuery).toContain(`'ok'`);
    expect(verifyQuery).toContain('TRIM(');
  });
});

describe('entity_graph union views', () => {
  it('unions per-entity profiles with namespaced entity types', () => {
    const statements = generateEntityGraphUnionSql([SPEC], 'snowflake', {
      targetSchema: 'PUBLIC',
      namespace: 'entity-graph',
    });
    const profiles = statements.find(
      (statement) => statement.name === 'entity_graph_entity_profiles'
    );

    expect(profiles?.sql).toContain('"ENTITY_GRAPH"."ENTITY_PROFILES"');
    expect(profiles?.sql).toContain('\'entity-graph.company\' AS "ENTITY_TYPE"');
    expect(profiles?.sql).toContain('"ENTITY_GRAPH"."COMPANY__ENTITY_PROFILE"');
  });

  it('builds a schema catalog with fallback metadata', () => {
    const catalog = generateEntityGraphUnionSql([SPEC], 'duckdb', {
      targetSchema: 'PUBLIC',
      namespace: 'entity-graph',
    }).find((statement) => statement.name === 'entity_graph_entity_schema_catalog');

    expect(catalog?.sql).toContain('"entity_graph"."entity_schema_catalog"');
    expect(catalog?.sql).toContain("'company_name'");
    expect(catalog?.sql).toContain('"semantic_role"');
    expect(catalog?.sql).toContain('Stub metadata for entity-graph.company.company_name');
  });

  it.each([
    ['snowflake', 'PARSE_JSON('],
    ['bigquery', 'PARSE_JSON('],
    ['postgres', 'CAST('],
    ['pgvector', 'CAST('],
    ['redshift', 'JSON_PARSE('],
    ['duckdb', 'CAST('],
    ['databricks', '\'{"name":"website"'],
    ['mysql', 'JSON_EXTRACT('],
  ] satisfies Array<[SupportedDialect, string]>)(
    'builds a schema catalog with inherited metadata and semantic overrides for %s',
    (dialect, marker) => {
      const catalog = generateEntityGraphUnionSql([SPEC_WITH_METADATA], dialect, {
        targetSchema: 'PUBLIC',
        namespace: 'entity-graph',
      }).find((statement) => statement.name === 'entity_graph_entity_schema_catalog');

      expect(catalog?.sql).toContain(marker);
      expect(catalog?.sql).toContain("'website'");
      expect(catalog?.sql).toContain('"name":"website"');
      expect(catalog?.sql).toContain('"semantic_role":"url"');
      expect(catalog?.sql).toContain('"description":"Primary website used for account matching."');
      expect(catalog?.sql).toContain('"pii":false');
    }
  );

  it('uses a JSON-compatible metadata type for empty schema catalogs', () => {
    const catalog = generateEntityGraphUnionSql([], 'postgres', {
      targetSchema: 'PUBLIC',
      namespace: 'entity-graph',
    }).find((statement) => statement.name === 'entity_graph_entity_schema_catalog');

    expect(catalog?.sql).toContain('CAST(NULL AS JSONB) AS "field_metadata"');
  });

  it('uses dialect-specific string types for empty schema catalogs', () => {
    const bigqueryCatalog = generateEntityGraphUnionSql([], 'bigquery', {
      targetSchema: 'PUBLIC',
      namespace: 'entity-graph',
    }).find((statement) => statement.name === 'entity_graph_entity_schema_catalog');
    const redshiftCatalog = generateEntityGraphUnionSql([], 'redshift', {
      targetSchema: 'PUBLIC',
      namespace: 'entity-graph',
    }).find((statement) => statement.name === 'entity_graph_entity_schema_catalog');

    expect(bigqueryCatalog?.sql).toContain('CAST(NULL AS STRING) AS `entity_type`');
    expect(redshiftCatalog?.sql).toContain('CAST(NULL AS VARCHAR(65535)) AS "entity_type"');
  });

  it('adds relationship and object contract surfaces', () => {
    const statements = generateEntityGraphUnionSql([SPEC], 'duckdb', {
      targetSchema: 'PUBLIC',
      namespace: 'entity-graph',
      relationshipSpecs: [RELATIONSHIP],
      objectSpecs: [OBJECT],
    });

    const names = statements.map((statement) => statement.name);
    expect(names).toContain('entity_graph_relationship_edges');
    expect(names).toContain('entity_graph_relationship_evidence');
    expect(names).toContain('entity_graph_relationship_quality');
    expect(names).toContain('entity_graph_object_types');
    expect(
      statements.find((statement) => statement.name === 'entity_graph_relationship_edges')?.sql
    ).toContain('"entity_graph"."works_at__relationship_edges"');
  });
});

describe('unmerge codegen', () => {
  it('records split events and not_match decisions across the keep boundary', () => {
    const statements = generateUnmergeSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'snowflake',
      clusterId: 'cluster-1',
      keepRecordIds: ['r1', 'r2'],
      reason: 'bad merge',
      decisionBatchId: 'unmerge-1',
      contentHash: 'hash-1',
    });

    expect(statements.map((statement) => statement.name)).toEqual([
      'audit_unmerge',
      'record_split_events',
      'insert_unmerge_not_match_decisions',
      'audit_split',
    ]);
    expect(statements[1]?.sql).toContain('"ENTITY_GRAPH"."COMPANY__SPLIT_EVENTS"');
    expect(statements[1]?.sql).toContain('WHERE NOT EXISTS');
    expect(statements[1]?.sql).toContain('existing."NEW_CLUSTER_ID"');
    expect(statements[2]?.sql).toContain("'not_match'");
    expect(statements[2]?.sql).toContain('"ENTITY_GRAPH"."COMPANY__PAIR_SCORES"');
  });

  it('derives a distinct new_cluster_id rather than aliasing record_id', () => {
    const statements = generateUnmergeSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'duckdb',
      clusterId: 'cluster-1',
      keepRecordIds: ['r1'],
      reason: 'audit fix',
      decisionBatchId: 'unmerge-2',
      contentHash: 'hash-2',
    });

    const splitEvents = statements.find((statement) => statement.name === 'record_split_events');
    expect(splitEvents?.sql).toContain("'split-'");
    expect(splitEvents?.sql).toContain("'cluster-1'");
    // The record_id position must NOT receive the same expression as new_cluster_id.
    const insertHeader = splitEvents?.sql.match(
      /INSERT INTO[\s\S]+?SELECT([\s\S]+?)FROM moved_records moved/
    );
    expect(insertHeader?.[1]).toContain('CONCAT');
    expect(insertHeader?.[1]).toMatch(/moved\."record_id"/);
  });

  it('embeds the content hash in unmerge audit event ids to prevent collisions', () => {
    const statements = generateUnmergeSql({
      entityName: 'company',
      targetSchema: 'ENTITY_GRAPH',
      dialect: 'duckdb',
      clusterId: 'cluster-1',
      keepRecordIds: ['r1'],
      reason: 'audit fix',
      decisionBatchId: 'unmerge-3',
      contentHash: 'unique-hash',
    });

    const auditUnmerge = statements.find((statement) => statement.name === 'audit_unmerge');
    const auditSplit = statements.find((statement) => statement.name === 'audit_split');
    expect(auditUnmerge?.sql).toContain("'unique-hash'");
    expect(auditSplit?.sql).toContain("'unique-hash'");
  });
});
