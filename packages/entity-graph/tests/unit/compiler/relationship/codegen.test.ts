import { describe, expect, it } from 'vitest';

import { compileEntityRelationship } from '../../../../src/compiler/relationship/codegen.js';
import type { ResolvedEntityRelationshipSpec } from '../../../../src/compiler/relationship/types.js';
import { OUTPUT_TABLES, getOutputTableDef } from '../../../../src/compiler/output-tables/index.js';

const WORKS_AT: ResolvedEntityRelationshipSpec = {
  name: 'works_at',
  leftEntity: 'contact',
  rightEntity: 'company',
  joinColumns: [{ left: 'email_domain', right: 'domain' }],
  joinType: 'inner',
  relationshipType: 'many_to_one',
  confidenceScoring: {
    features: [{ field: 'email_domain', algorithm: 'exact', weight: 1 }],
  },
  review: {
    thresholds: {
      auto_confirm: 0.92,
      review: 0.65,
      auto_reject: 0.4,
    },
  },
  targetSchema: 'ENTITY_GRAPH',
};

describe('relationship output tables', () => {
  it('registers the Drop 5 relationship tables', () => {
    expect(OUTPUT_TABLES.for('relationship').map((table) => table.suffix)).toEqual([
      '__relationship_candidates',
      '__relationship_evidence',
      '__relationship_edges',
      '__relationship_review_queue',
      '__relationship_decisions',
      '__entity_relationship_edge',
      '__entity_relationship',
      '__entity_relationship_evidence',
      '__entity_relationship_decisions',
    ]);
    expect(getOutputTableDef('__relationship_decisions').ddlStrategy).toBe('create_if_not_exists');
    expect(getOutputTableDef('__entity_relationship_evidence').ddlStrategy).toBe(
      'create_if_not_exists'
    );
    expect(getOutputTableDef('__entity_relationship_decisions').ddlStrategy).toBe(
      'create_if_not_exists'
    );
  });
});

describe('compileEntityRelationship', () => {
  it('emits candidates, evidence, edges, review queue, and decisions SQL', () => {
    const result = compileEntityRelationship(WORKS_AT, 'duckdb', {
      targetSchema: 'ENTITY_GRAPH',
      namespace: 'entity-graph',
    });

    expect(result.statements.map((statement) => statement.name)).toEqual([
      'ddl_relationship_decisions',
      'relationship_candidates',
      'relationship_evidence',
      'relationship_edges',
      'relationship_review_queue',
    ]);
    expect(result.statements[1]?.sql).toContain('"entity_graph"."contact__entity_profile"');
    expect(result.statements[1]?.sql).toContain('"entity_graph"."company__entity_profile"');
    expect(result.statements[1]?.sql).toContain("'entity-graph.contact'");
    expect(result.statements[1]?.sql).toContain("'entity-graph.company'");
    expect(result.statements[1]?.sql).toContain('json_extract_string');
    expect(result.statements[2]?.sql).toContain('profile_join');
    expect(result.statements[3]?.sql).toContain('"works_at__relationship_edges"');
    expect(result.statements[4]?.sql).toContain('"works_at__relationship_review_queue"');
  });

  it('inlines the Jaro-Winkler UDF into the bigquery evidence statement', () => {
    const fuzzySpec: ResolvedEntityRelationshipSpec = {
      ...WORKS_AT,
      confidenceScoring: {
        features: [{ field: 'email_domain', algorithm: 'jaro_winkler', weight: 1 }],
      },
    };
    const result = compileEntityRelationship(fuzzySpec, 'bigquery', {
      targetSchema: 'ENTITY_GRAPH',
      namespace: 'entity-graph',
    });

    const evidence = result.statements.find(
      (statement) => statement.name === 'relationship_evidence'
    );
    expect(evidence?.sql).toContain('bms_jaro_winkler(');
    expect(evidence?.sql.startsWith('CREATE TEMP FUNCTION bms_jaro_winkler')).toBe(true);
    // Must be the native SQL UDF — a LANGUAGE js UDF is untenably slow.
    expect(evidence?.sql).not.toContain('LANGUAGE js');

    // Statements that do not call the UDF stay unprefixed.
    const candidates = result.statements.find(
      (statement) => statement.name === 'relationship_candidates'
    );
    expect(candidates?.sql).not.toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
  });

  it('emits no Jaro-Winkler UDF for duckdb relationship scoring', () => {
    const fuzzySpec: ResolvedEntityRelationshipSpec = {
      ...WORKS_AT,
      confidenceScoring: {
        features: [{ field: 'email_domain', algorithm: 'jaro_winkler', weight: 1 }],
      },
    };
    const result = compileEntityRelationship(fuzzySpec, 'duckdb', {
      targetSchema: 'ENTITY_GRAPH',
      namespace: 'entity-graph',
    });

    for (const statement of result.statements) {
      expect(statement.sql).not.toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
    }
  });

  it('supports same-entity hierarchy relationships without self edges', () => {
    const result = compileEntityRelationship(
      {
        ...WORKS_AT,
        name: 'subsidiary_of',
        leftEntity: 'company',
        rightEntity: 'company',
        joinColumns: [{ left: 'parent_domain', right: 'domain' }],
      },
      'snowflake',
      { targetSchema: 'ENTITY_GRAPH', namespace: 'entity-graph' }
    );

    const candidates = result.statements.find(
      (statement) => statement.name === 'relationship_candidates'
    );
    expect(candidates?.sql).toContain('l."ENTITY_ID" <> r."ENTITY_ID"');
  });
});
