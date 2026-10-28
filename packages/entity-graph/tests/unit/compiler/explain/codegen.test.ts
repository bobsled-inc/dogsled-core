import { describe, expect, it } from 'vitest';

import { buildExplainQuery } from '../../../../src/compiler/explain/codegen.js';

describe('buildExplainQuery', () => {
  it.each(['pair', 'cluster', 'edge', 'entity'] as const)('builds %s explain SQL', (subject) => {
    const query = buildExplainQuery({
      subject,
      id: subject === 'edge' ? 'edge-1' : 'entity-1',
      dialect: 'duckdb',
    });

    expect(query).toContain('"section"');
    expect(query).toContain('"subject_id"');
    expect(query).toContain('"payload_json"');
  });

  it('includes identity, quality, provenance, linked entities, object metadata, and lineage_provenance for entities', () => {
    const query = buildExplainQuery({
      subject: 'entity',
      id: 'entity-1',
      dialect: 'snowflake',
    });

    expect(query).toContain('"ENTITY_GRAPH"."ENTITY_PROFILES"');
    expect(query).toContain('"ENTITY_GRAPH"."ENTITY_QUALITY_CURRENT"');
    expect(query).toContain('"ENTITY_GRAPH"."CROSSWALKS"');
    expect(query).toContain('"ENTITY_GRAPH"."RELATIONSHIP_EDGES"');
    expect(query).toContain('"ENTITY_GRAPH"."OBJECT_TYPES"');
    expect(query).toContain('"ENTITY_GRAPH"."LINEAGE"');
    expect(query).toContain("'lineage_provenance'");
  });

  it('lineage_provenance section joins entity_profiles for entity_type resolution', () => {
    const query = buildExplainQuery({
      subject: 'entity',
      id: 'entity-42',
      dialect: 'duckdb',
    });

    expect(query).toContain("'lineage_provenance'");
    expect(query).toContain('"entity_graph"."lineage"');
    expect(query).toContain('"entity_graph"."entity_profiles"');
    expect(query).toContain("'entity-42'");
  });

  it('selects the opposite endpoint for linked entity explanations', () => {
    const query = buildExplainQuery({
      subject: 'entity',
      id: 'entity-1',
      dialect: 'duckdb',
    });

    expect(query).toContain(
      `CASE WHEN e."left_entity_id" = 'entity-1' THEN e."right_entity_id" ELSE e."left_entity_id" END AS "payload_json"`
    );
  });

  it('includes relationship evidence and audit rows for edges', () => {
    const query = buildExplainQuery({
      subject: 'edge',
      id: 'edge-1',
      dialect: 'duckdb',
    });

    expect(query).toContain('"entity_graph"."relationship_edges"');
    expect(query).toContain('"entity_graph"."relationship_evidence"');
    expect(query).toContain('"entity_graph"."audit_log"');
    expect(query).toContain("'edge-1'");
  });

  it('resolves cluster audit rows through matching cluster ids', () => {
    const query = buildExplainQuery({
      subject: 'cluster',
      id: 'entity-1',
      dialect: 'duckdb',
    });

    expect(query).toContain('SELECT DISTINCT c_ids."cluster_id"');
    expect(query).toContain(`OR c_ids."entity_id" = 'entity-1'`);
    expect(query).toContain('a."subject_id" IN (SELECT DISTINCT c_ids."cluster_id"');
  });
});
