import { describe, expect, it } from 'vitest';

import {
  OUTPUT_TABLE_SUFFIXES,
  OUTPUT_TABLES,
  getOutputTableDef,
  outputTableName,
} from '../../../../src/compiler/output-tables/index.js';

describe('OUTPUT_TABLE_SUFFIXES', () => {
  it('suffixes and table definitions stay in sync', () => {
    expect(OUTPUT_TABLE_SUFFIXES.length).toBe(OUTPUT_TABLES.for('identity').length);
  });

  it('all critical Entity Graph tables are present', () => {
    const suffixes = OUTPUT_TABLE_SUFFIXES as readonly string[];
    expect(suffixes).toContain('__review_queue');
    expect(suffixes).toContain('__pair_scores');
    expect(suffixes).toContain('__clusters');
    expect(suffixes).toContain('__golden_record');
    expect(suffixes).toContain('__golden');
    expect(suffixes).not.toContain('__golden_history');
    expect(suffixes).toContain('__not_match_edges');
    expect(suffixes).toContain('__review_decisions');
    expect(suffixes).toContain('__components');
    expect(suffixes).toContain('__entity_id_events');
    expect(suffixes).toContain('__entity_id_record_map');
    expect(suffixes).toContain('__entity_id_current');
    expect(suffixes).toContain('__entity_id_aliases');
    expect(suffixes).toContain('__entity_profile');
    expect(suffixes).toContain('__entity_quality');
    expect(suffixes).toContain('__forgotten_records');
    expect(OUTPUT_TABLES.for('semantic').map((table) => table.suffix)).toEqual([
      '__embedding_cache',
      '__pair_semantic_scores',
      '__document_mentions',
      '__document_mentions__quality',
    ]);
  });

  it('all suffixes start with double underscore', () => {
    for (const suffix of OUTPUT_TABLE_SUFFIXES) {
      expect(suffix.startsWith('__')).toBe(true);
    }
  });
});

describe('OUTPUT_TABLES', () => {
  it('has definitions for all suffixes', () => {
    expect(OUTPUT_TABLES.for('identity').length).toBe(OUTPUT_TABLE_SUFFIXES.length);
  });

  it('exposes tables by stage', () => {
    expect(OUTPUT_TABLES.for('identity').map((table) => table.suffix)).toEqual(
      OUTPUT_TABLE_SUFFIXES
    );
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
    expect(OUTPUT_TABLES.for('object').map((table) => table.suffix)).toEqual(['object_types']);
  });

  it('append-only tables use create_if_not_exists', () => {
    const appendOnly = OUTPUT_TABLES.all().filter((t) => t.ddlStrategy === 'create_if_not_exists');
    expect(appendOnly.length).toBeGreaterThan(0);

    // __review_decisions must be append-only
    const reviewDecisions = getOutputTableDef('__review_decisions');
    expect(reviewDecisions.ddlStrategy).toBe('create_if_not_exists');

    // __not_match_edges must be append-only
    const notMatchEdges = getOutputTableDef('__not_match_edges');
    expect(notMatchEdges.ddlStrategy).toBe('create_if_not_exists');

    const forgottenRecords = getOutputTableDef('__forgotten_records');
    expect(forgottenRecords.ddlStrategy).toBe('create_if_not_exists');
  });

  it('pipeline tables use create_or_replace', () => {
    const standardized = getOutputTableDef('__standardized');
    expect(standardized.ddlStrategy).toBe('create_or_replace');

    const pairs = getOutputTableDef('__candidate_pairs');
    expect(pairs.ddlStrategy).toBe('create_or_replace');
  });

  it('all tables have at least one column', () => {
    for (const table of OUTPUT_TABLES.all()) {
      expect(table.columns.length).toBeGreaterThan(0);
    }
  });
});

describe('outputTableName', () => {
  it('builds table name from entity and suffix', () => {
    expect(outputTableName('company', '__clusters')).toBe('company__clusters');
    expect(outputTableName('person', '__review_queue')).toBe('person__review_queue');
  });
});

describe('getOutputTableDef', () => {
  it('returns definition for valid suffix', () => {
    const def = getOutputTableDef('__clusters');
    expect(def.suffix).toBe('__clusters');
    expect(def.columns.length).toBeGreaterThan(0);
  });

  it('captures confidence and profile-serving columns in the output contract', () => {
    const reviewDecisions = getOutputTableDef('__review_decisions');
    expect(reviewDecisions.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'content_hash',
        'confidence',
        'proposed_decision',
        'proposed_confidence',
        'status',
        'human_feedback_outcome',
        'human_feedback_reason',
        'feedback_timestamp',
      ])
    );

    const reviewQueue = getOutputTableDef('__review_queue');
    expect(reviewQueue.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['semantic_score', 'semantic_decision', 'rule_name'])
    );

    const embeddingCache = getOutputTableDef('__embedding_cache');
    expect(embeddingCache.ddlStrategy).toBe('create_if_not_exists');
    expect(embeddingCache.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['content_hash', 'provider', 'embedding'])
    );

    const semanticScores = getOutputTableDef('__pair_semantic_scores');
    expect(semanticScores.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['pair_id', 'field', 'semantic_score', 'evaluated_at'])
    );

    const notMatchEdges = getOutputTableDef('__not_match_edges');
    expect(notMatchEdges.columns.map((column) => column.name)).toContain('confidence');

    const entityProfile = getOutputTableDef('__entity_profile');
    expect(entityProfile.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'entity_id',
        'cluster_id',
        'canonical_name',
        'display_name',
        'profile_attrs',
        'confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
        'last_seen_at',
        'lineage_run_id',
        'version',
      ])
    );

    const clusters = getOutputTableDef('__clusters');
    expect(clusters.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['entity_id', 'cluster_id', 'component_id'])
    );

    const crosswalks = getOutputTableDef('__crosswalks');
    expect(crosswalks.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['entity_id', 'cluster_id', 'component_id'])
    );

    const auditLog = getOutputTableDef('audit_log');
    expect(auditLog.stage).toBe('audit');
    expect(auditLog.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['event_id', 'category', 'payload', 'occurred_at'])
    );

    const forgottenRecords = getOutputTableDef('__forgotten_records');
    expect(forgottenRecords.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'tombstone_id',
        'source_ref',
        'source_pk_json',
        'requested_at',
        'reason',
        'content_hash',
      ])
    );
  });

  it('throws for invalid suffix', () => {
    expect(() => getOutputTableDef('__invalid' as unknown as '__clusters')).toThrow(
      'Unknown output table suffix'
    );
  });
});
