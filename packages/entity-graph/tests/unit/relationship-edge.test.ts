import { describe, it, expect } from 'vitest';

import {
  computeEdgeQuality,
  RELATIONSHIP_EDGE_OUTPUT_TABLES,
} from '../../src/compiler/output-tables/relationship-edge.js';
import {
  MENTION_OUTPUT_TABLES,
  MENTION_QUALITY_VIEW_TABLES,
} from '../../src/compiler/output-tables/mention.js';
import { OUTPUT_TABLES } from '../../src/compiler/output-tables/index.js';

describe('computeEdgeQuality', () => {
  it('confidence is the min of endpoint confidences times link_match_quality', () => {
    const q = computeEdgeQuality({
      left_confidence: 0.9,
      right_confidence: 0.7,
      link_match_quality: 0.8,
      left_freshness_age_seconds: 100,
      right_freshness_age_seconds: 200,
    });
    expect(q.confidence).toBeCloseTo(0.7 * 0.8, 6);
  });

  it('freshness is the max of endpoint freshness ages', () => {
    const q = computeEdgeQuality({
      left_confidence: 1,
      right_confidence: 1,
      link_match_quality: 1,
      left_freshness_age_seconds: 100,
      right_freshness_age_seconds: 9_999,
    });
    expect(q.freshness_age_seconds).toBe(9_999);
  });

  it('zero link_match_quality drives edge confidence to 0', () => {
    const q = computeEdgeQuality({
      left_confidence: 1,
      right_confidence: 1,
      link_match_quality: 0,
      left_freshness_age_seconds: 0,
      right_freshness_age_seconds: 0,
    });
    expect(q.confidence).toBe(0);
  });
});

describe('RELATIONSHIP_EDGE_OUTPUT_TABLES contract', () => {
  it('declares the edge + evidence tables with the documented columns', () => {
    const relationship = RELATIONSHIP_EDGE_OUTPUT_TABLES.find(
      (t) => t.suffix === '__entity_relationship'
    );
    expect(relationship).toBeDefined();
    expect(relationship?.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['relation_type', 'rank', 'evidence_count', 'lineage_run_id'])
    );

    const edge = RELATIONSHIP_EDGE_OUTPUT_TABLES.find(
      (t) => t.suffix === '__entity_relationship_edge'
    );
    expect(edge).toBeDefined();
    const cols = edge?.columns.map((c) => c.name) ?? [];
    for (const required of [
      'relationship_id',
      'left_entity_id',
      'right_entity_id',
      'relation_type',
      'confidence',
      'evidence_count',
      'evidence_diversity',
      'freshness_age_seconds',
    ]) {
      expect(cols).toContain(required);
    }

    const evidence = RELATIONSHIP_EDGE_OUTPUT_TABLES.find(
      (t) => t.suffix === '__entity_relationship_evidence'
    );
    expect(evidence).toBeDefined();
    expect(evidence?.ddlStrategy).toBe('create_if_not_exists');
    expect(evidence?.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'relation_type',
        'source_document_id',
        'span_start',
        'evidence_excerpt',
        'extraction_role',
        'ontology_version',
        'review_flag',
      ])
    );

    const decisions = RELATIONSHIP_EDGE_OUTPUT_TABLES.find(
      (t) => t.suffix === '__entity_relationship_decisions'
    );
    expect(decisions).toBeDefined();
  });

  it('registers public and internal relationship tables globally', () => {
    expect(OUTPUT_TABLES.suffixes()).toEqual(
      expect.arrayContaining([
        '__entity_relationship',
        '__entity_relationship_edge',
        '__entity_relationship_evidence',
        '__entity_relationship_decisions',
      ])
    );
  });
});

describe('MENTION_OUTPUT_TABLES contract', () => {
  it('declares __document_mentions with span_end column (overlap-collision fix)', () => {
    const t = MENTION_OUTPUT_TABLES.find((x) => x.suffix === '__document_mentions');
    const cols = t?.columns.map((c) => c.name) ?? [];
    expect(cols).toContain('span_end');
    expect(cols).toContain('span_start');
    expect(cols).toContain('mention_id');
    expect(cols).toContain('resolved_entity_id');
    expect(cols).toContain('superseded_at');
  });

  it('declares __document_mentions__quality view per Phase 0 contract', () => {
    const v = MENTION_QUALITY_VIEW_TABLES.find((x) => x.suffix === '__document_mentions__quality');
    expect(v).toBeDefined();
    expect(v?.kind).toBe('view');
    expect(v?.ddlStrategy).toBe('create_or_replace');
    const cols = v?.columns.map((c) => c.name) ?? [];
    expect(cols).toEqual(
      expect.arrayContaining([
        'mention_id',
        'mention_confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
      ])
    );
  });
});
