import { describe, expect, it } from 'vitest';

import {
  buildRelationshipsReviewApplySql,
  parseRelationshipReviewDecisionFile,
} from '../../src/commands/relationships-review-apply.js';
import {
  buildRelationshipsReviewExportQuery,
  relationshipRowsToCsv,
} from '../../src/commands/relationships-review-export.js';
import { buildRelationshipsCompactSql } from '../../src/commands/relationships-compact.js';

describe('relationships review commands', () => {
  it('builds review export query with parity decision bands', () => {
    const sql = buildRelationshipsReviewExportQuery({
      table: 'entity_graph.__entity_relationship_evidence',
      limit: 10,
    });

    expect(sql).toContain(
      "WHEN review_flag IN ('auto_merge', 'agent_applied', 'agent_review', 'eval_sample', 'unresolved') THEN review_flag"
    );
    expect(sql).toContain("WHEN review_flag = 'human_review' THEN 'agent_review'");
    expect(sql).toContain("WHEN confidence >= 0.92 THEN 'auto_merge'");
    expect(sql).toContain("WHEN confidence >= 0.75 THEN 'agent_applied'");
    expect(sql).toContain("WHEN confidence >= 0.55 THEN 'agent_review'");
    expect(sql).toContain("decision IN ('agent_review', 'eval_sample', 'unresolved')");
    expect(sql).toContain('LIMIT 10');
  });

  it('allows relationship review export thresholds to follow ontology defaults', () => {
    const sql = buildRelationshipsReviewExportQuery({
      table: 'entity_graph.__entity_relationship_evidence',
      reviewThresholds: { auto_confirm: 0.9, review: 0.4 },
    });

    expect(sql).toContain("WHEN confidence >= 0.9 THEN 'auto_merge'");
    expect(sql).toContain("WHEN confidence >= 0.4 THEN 'agent_review'");
  });

  it('renders CSV review rows', () => {
    const csv = relationshipRowsToCsv([
      {
        review_id: 'e1',
        decision: 'agent_review',
        confidence: 0.7,
        evidence_id: 'e1',
        relationship_id: 'r1',
        relation_type: 'competes_with',
        left_entity_id: 'entity_acme',
        right_entity_id: 'entity_globex',
        evidence_excerpt: 'Acme competes with Globex',
        source_document_id: 'doc_1',
        review_flag: 'agent_review',
      },
    ]);

    expect(csv).toContain('review_id,decision,confidence');
    expect(csv).toContain('competes_with');
  });

  it('parses apply YAML and builds insert statements', () => {
    const rows = parseRelationshipReviewDecisionFile(`rows:
  - evidence_id: e1
    relationship_id: r1
    decision: reject
    decided_by: human:alice@example.com
    rationale: wrong endpoint
`);
    const sql = buildRelationshipsReviewApplySql(rows, {
      table: 'entity_graph.__entity_relationship_decisions',
      now: () => new Date('2026-05-12T00:00:00.000Z'),
      decisionId: () => 'decision_1',
    });

    expect(sql).toEqual([
      {
        sql: expect.stringContaining('INSERT INTO entity_graph.__entity_relationship_decisions'),
        params: [
          'decision_1',
          'e1',
          'r1',
          'reject',
          'human:alice@example.com',
          'wrong endpoint',
          '2026-05-12T00:00:00.000Z',
        ],
      },
    ]);
    expect(sql[0]!.sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?)');
  });

  it('rejects non-string evidence ids in relationship review apply input', () => {
    expect(() =>
      parseRelationshipReviewDecisionFile(`rows:
  - evidence_id: 12
    relationship_id: r1
    decision: reject
`)
    ).toThrow('non-string evidence_id');
  });

  it('rejects invalid relationship review export limits', () => {
    expect(() => buildRelationshipsReviewExportQuery({ limit: 0 })).toThrow(
      'Invalid relationship review export limit'
    );
  });

  it('builds compact SQL against the public relationship table', () => {
    const sql = buildRelationshipsCompactSql({ schema: 'entity_graph', dryRun: true });
    expect(sql).toContain('CREATE OR REPLACE TABLE entity_graph.__entity_relationship AS');
    expect(sql).toContain('entity_graph.__entity_relationship_evidence');
  });

  it('rejects unsafe compact evidence and decisions tables', () => {
    expect(() =>
      buildRelationshipsCompactSql({
        evidenceTable: 'entity_graph.evidence; DROP TABLE x; --',
      })
    ).toThrow(/Invalid SQL identifier/);
    expect(() =>
      buildRelationshipsCompactSql({
        decisionsTable: 'entity_graph.decisions; DROP TABLE x; --',
      })
    ).toThrow(/Invalid SQL identifier/);
  });

  it('uses dialect-safe replacement DDL for Postgres', () => {
    const sql = buildRelationshipsCompactSql({
      schema: 'entity_graph',
      dialect: 'postgres',
      dryRun: true,
    });
    expect(sql).toContain('DROP TABLE IF EXISTS entity_graph.__entity_relationship;');
    expect(sql).toContain('CREATE TABLE entity_graph.__entity_relationship AS');
  });
});
