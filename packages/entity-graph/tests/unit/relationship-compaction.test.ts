import { describe, expect, it } from 'vitest';

import type { ResolvedRelationshipOntology } from '../../src/compiler/ontology/types.js';
import { buildCompactionSelect } from '../../src/compiler/relationship/compaction.js';
import {
  compactRelationshipEvidenceRows,
  logOddsAggregate,
} from '../../src/compiler/relationship/aggregation.js';
import { buildRelationshipsCompactSql } from '../../src/commands/relationships-compact.js';

const ontology: ResolvedRelationshipOntology = {
  name: 'default',
  ontologyVersion: 'default@0.2',
  relationTypes: ['competes_with', 'partners_with'],
  entityTypes: ['customer'],
  relations: [
    {
      relation_type: 'competes_with',
      description: 'Competitors.',
      left_entity: 'customer',
      right_entity: 'customer',
      direction: 'symmetric',
      cardinality: 'many_to_many',
      aliases: [],
      exclusive_with: ['partners_with'],
      temporal: 'stateful',
      review_thresholds: { auto_confirm: 0.92, review: 0.55, auto_reject: 0.3 },
    },
    {
      relation_type: 'partners_with',
      description: 'Partners.',
      left_entity: 'customer',
      right_entity: 'customer',
      direction: 'symmetric',
      cardinality: 'many_to_many',
      aliases: [],
      exclusive_with: ['competes_with'],
      temporal: 'stateful',
      review_thresholds: { auto_confirm: 0.92, review: 0.55, auto_reject: 0.3 },
    },
  ],
};

describe('relationship compaction', () => {
  it('aggregates confidence with log odds', () => {
    expect(logOddsAggregate([0.8, 0.8])).toBeCloseTo(0.941176, 5);
  });

  it('rejects empty confidence arrays', () => {
    expect(() => logOddsAggregate([])).toThrow(
      'logOddsAggregate requires at least one confidence value'
    );
  });

  it('compacts evidence, caps per source, and marks exclusive conflicts', () => {
    const rows = compactRelationshipEvidenceRows(
      [
        {
          evidence_id: 'e1',
          relationship_id: 'r_competes',
          left_entity_id: 'entity_acme',
          right_entity_id: 'entity_globex',
          relation_type: 'competes_with',
          confidence: 0.8,
          source_document_id: 'doc_1',
          evidence_kind: 'llm_extraction',
          observed_at: '2026-05-01T00:00:00.000Z',
          recorded_at: '2026-05-10T00:00:00.000Z',
        },
        {
          evidence_id: 'e2',
          relationship_id: 'r_competes',
          left_entity_id: 'entity_acme',
          right_entity_id: 'entity_globex',
          relation_type: 'competes_with',
          confidence: 0.7,
          source_document_id: 'doc_1',
          evidence_kind: 'llm_extraction',
          observed_at: '2026-05-02T00:00:00.000Z',
          recorded_at: '2026-05-11T00:00:00.000Z',
        },
        {
          evidence_id: 'e3',
          relationship_id: 'r_partners',
          left_entity_id: 'entity_acme',
          right_entity_id: 'entity_globex',
          relation_type: 'partners_with',
          confidence: 0.6,
          source_document_id: 'doc_2',
          evidence_kind: 'llm_extraction',
          observed_at: null,
          recorded_at: '2026-05-11T00:00:00.000Z',
        },
      ],
      [],
      ontology,
      { now: new Date('2026-05-12T00:00:00.000Z'), lineageRunId: 'run_1' }
    );

    expect(rows).toEqual([
      expect.objectContaining({
        relationship_id: 'r_competes',
        confidence: 0.8,
        rank: 'preferred',
        evidence_count: 1,
        evidence_diversity: 1,
        lineage_run_id: 'run_1',
      }),
      expect.objectContaining({
        relationship_id: 'r_partners',
        rank: 'conflicted',
      }),
    ]);
  });

  it('breaks equal-confidence exclusivity conflicts by relationship_id', () => {
    const rows = compactRelationshipEvidenceRows(
      [
        {
          evidence_id: 'e1',
          relationship_id: 'b_partners',
          left_entity_id: 'entity_acme',
          right_entity_id: 'entity_globex',
          relation_type: 'partners_with',
          confidence: 0.8,
          source_document_id: 'doc_1',
          evidence_kind: 'llm_extraction',
          observed_at: null,
          recorded_at: '2026-05-11T00:00:00.000Z',
        },
        {
          evidence_id: 'e2',
          relationship_id: 'a_competes',
          left_entity_id: 'entity_acme',
          right_entity_id: 'entity_globex',
          relation_type: 'competes_with',
          confidence: 0.8,
          source_document_id: 'doc_2',
          evidence_kind: 'llm_extraction',
          observed_at: null,
          recorded_at: '2026-05-11T00:00:00.000Z',
        },
      ],
      [],
      ontology,
      new Date('2026-05-12T00:00:00.000Z')
    );

    expect(rows.map((row) => ({ relationship_id: row.relationship_id, rank: row.rank }))).toEqual([
      { relationship_id: 'a_competes', rank: 'preferred' },
      { relationship_id: 'b_partners', rank: 'conflicted' },
    ]);
  });

  it('emits compaction SQL over evidence and decisions', () => {
    const sql = buildCompactionSelect({
      evidenceTable: 'entity_graph.__entity_relationship_evidence',
      decisionsTable: 'entity_graph.__entity_relationship_decisions',
    });

    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain('relationship_id');
    expect(sql).toContain('__entity_relationship_decisions');
    expect(sql).toContain("WHEN COALESCE(d.has_supersede, 0) = 1 THEN 'deprecated'");
    expect(sql).toContain("WHEN COALESCE(d.has_conflict, 0) = 1 THEN 'conflicted'");
    expect(sql).toContain("DATE_DIFF('second', CAST(a.latest_recorded_at AS TIMESTAMP)");
    expect(sql).not.toContain('0 AS freshness_age_seconds');
    // Without exclusivityPairs the SQL must not carry the conflict CTE so
    // projects without an ontology spec preserve the legacy decision-only
    // ranking.
    expect(sql).not.toContain('exclusivity_pairs');
    expect(sql).not.toContain('conflict_candidates');
  });

  it('uses CONCAT for MySQL evidence diversity keys', () => {
    const sql = buildCompactionSelect({ dialect: 'mysql' });
    expect(sql).toContain(
      "COUNT(DISTINCT CONCAT(COALESCE(source_document_id, '<none>'), ':', evidence_kind)) AS evidence_diversity"
    );
    expect(sql).not.toContain("COALESCE(source_document_id, '<none>') || ':' || evidence_kind");
  });

  it('marks ontology-exclusive relationships as conflicted in SQL', () => {
    const sql = buildCompactionSelect({
      evidenceTable: 'entity_graph.__entity_relationship_evidence',
      decisionsTable: 'entity_graph.__entity_relationship_decisions',
      exclusivityPairs: [
        ['competes_with', 'partners_with'],
        ['partners_with', 'competes_with'],
      ],
    });

    expect(sql).toContain('exclusivity_pairs AS (');
    expect(sql).toContain("SELECT 'competes_with' AS relation_a, 'partners_with' AS relation_b");
    expect(sql).toContain("SELECT 'partners_with' AS relation_a, 'competes_with' AS relation_b");
    expect(sql).toContain('conflict_candidates AS (');
    expect(sql).toContain('LEFT JOIN exclusivity_pairs ex ON ex.relation_a = a1.relation_type');
    expect(sql).toContain("WHEN COALESCE(c.stronger_conflict_count, 0) > 0 THEN 'conflicted'");
    expect(sql).toContain(
      'LEFT JOIN conflict_candidates c ON c.relationship_id = a.relationship_id'
    );
  });

  it('escapes single quotes in ontology relation_type values', () => {
    const sql = buildCompactionSelect({
      exclusivityPairs: [["o'connor_rule", 'partners_with']],
    });
    expect(sql).toContain("SELECT 'o''connor_rule' AS relation_a");
  });

  it('uses dialect-specific lineage run id expressions in compact DDL', () => {
    const sql = buildRelationshipsCompactSql({
      dialect: 'bigquery',
      schema: 'entity_graph',
      dryRun: true,
    });

    expect(sql).toContain('CREATE OR REPLACE TABLE entity_graph.__entity_relationship AS');
    expect(sql).toContain('CAST(CURRENT_TIMESTAMP() AS STRING) AS lineage_run_id');
  });
});

describe('buildCompactionSelect — exclusivity-pair literals are escaped dialect-correctly', () => {
  // A relation name containing a single quote, fed through the exclusivity CTE.
  const exclusivityPairs = [["o'neil_rel", 'other_rel'] as const] as const;

  it("backslash-escapes the relation name for BigQuery (\\')", () => {
    const sql = buildCompactionSelect({ dialect: 'bigquery', exclusivityPairs });
    expect(sql).toContain("'o\\'neil_rel' AS relation_a");
  });

  it("doubles the relation-name quote for a doubling dialect ('')", () => {
    const sql = buildCompactionSelect({ dialect: 'duckdb', exclusivityPairs });
    expect(sql).toContain("'o''neil_rel' AS relation_a");
  });
});
