import { describe, it, expect } from 'vitest';

import {
  buildMentionDerivedEdgeSelect,
  buildMentionDerivedEvidenceSelect,
} from '../../src/compiler/relationship/cross-entity-link.js';

describe('buildMentionDerivedEdgeSelect', () => {
  it('selects from __document_mentions with resolved/non-superseded filter', () => {
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.support__document_mentions',
      relationshipName: 'document_mentions_company',
      cardinality: 'many_to_many',
      lineageRunId: 'run-2026-05-07-abc',
      dialect: 'duckdb',
    });
    expect(sql).toContain('FROM eg.support__document_mentions');
    expect(sql).toContain("resolution_method IN ('exact_match', 'llm_disambiguation')");
    expect(sql).toContain('superseded_at IS NULL');
    // relation_type carries the semantic relationship name, not the
    // multiplicity — multiplicity stays as a typed option so callers can
    // persist it into a separate column if needed.
    expect(sql).toContain("'document_mentions_company' AS relation_type");
    expect(sql).toContain('GROUP BY document_id, resolved_entity_id');
    // The lineage run id comes from the caller, never a hardcoded placeholder.
    expect(sql).toContain("'run-2026-05-07-abc' AS lineage_run_id");
    expect(sql).not.toMatch(/'__[a-z0-9_]+_run__'/);
  });

  it('aggregates evidence_count and evidence_diversity per edge', () => {
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.m',
      relationshipName: 'r',
      cardinality: 'one_to_many',
      lineageRunId: 'run-1',
      dialect: 'duckdb',
    });
    expect(sql).toContain('COUNT(*) AS evidence_count');
    expect(sql).toContain('COUNT(DISTINCT chunk_id) AS evidence_diversity');
  });

  it('uses length-prefixed encoding for relationship_id (collision-free)', () => {
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.m',
      relationshipName: 'r',
      cardinality: 'one_to_many',
      lineageRunId: 'run-1',
      dialect: 'duckdb',
    });
    expect(sql).toContain('LENGTH(document_id)');
    expect(sql).toContain('LENGTH(resolved_entity_id)');
    expect(sql).toContain("LENGTH('r')");
  });

  it('backslash-escapes apostrophes for BigQuery instead of doubling them', () => {
    // Regression: BigQuery rejects '' quote-doubling ("concatenated string
    // literals must be separated by whitespace or comments"); it requires \'.
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.m',
      relationshipName: "o'brien_link",
      cardinality: 'many_to_many',
      lineageRunId: 'run-1',
      dialect: 'bigquery',
    });
    // BigQuery literal is backslash-escaped and quote-wrapped: 'o\'brien_link'.
    expect(sql).toContain("'o\\'brien_link'");
    expect(sql).not.toContain("o''brien_link");
  });

  it('joins both __entity_profile rows when leftProfileTable + rightProfileTable supplied', () => {
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.support__document_mentions',
      relationshipName: 'document_mentions_company',
      cardinality: 'many_to_many',
      lineageRunId: 'run-1',
      leftProfileTable: 'eg.profile_document',
      rightProfileTable: 'eg.profile_company',
      dialect: 'duckdb',
    });
    // CTE shape — aggregation pushed before profile lookups.
    expect(sql).toContain('WITH agg AS');
    // Endpoint joins.
    expect(sql).toContain('LEFT JOIN eg.profile_document lp');
    expect(sql).toContain('LEFT JOIN eg.profile_company rp');
    expect(sql).toContain('rp.entity_type = agg.entity_type');
    // Documented confidence rule.
    expect(sql).toContain('LEAST(');
    expect(sql).toContain('lp.confidence');
    expect(sql).toContain('rp.confidence');
    expect(sql).toContain('* agg.link_match_quality AS confidence');
    // Aggregations still present.
    expect(sql).toContain('agg.evidence_count');
    expect(sql).toContain('agg.evidence_diversity');
  });

  it('falls back to MIN(resolution_confidence) when profile tables omitted', () => {
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.m',
      relationshipName: 'r',
      cardinality: 'many_to_many',
      lineageRunId: 'run-1',
      dialect: 'duckdb',
    });
    expect(sql).toContain('MIN(resolution_confidence) AS confidence');
    expect(sql).not.toContain('WITH agg AS');
    expect(sql).not.toContain('identity_confidence');
  });

  it('rejects partial profile-table configuration', () => {
    expect(() =>
      buildMentionDerivedEdgeSelect({
        mentionsTable: 'eg.m',
        relationshipName: 'r',
        cardinality: 'many_to_many',
        lineageRunId: 'run-1',
        leftProfileTable: 'eg.profile_document',
        dialect: 'duckdb',
      })
    ).toThrow('rightProfileTable');
  });
});

describe('buildMentionDerivedEvidenceSelect', () => {
  it('emits one evidence row per mention', () => {
    const sql = buildMentionDerivedEvidenceSelect({
      mentionsTable: 'eg.m',
      relationshipName: 'r',
      dialect: 'duckdb',
    });
    expect(sql).toContain('mention_id AS evidence_ref');
    expect(sql).toContain("'r' AS relation_type");
    expect(sql).toContain('document_id AS left_entity_id');
    expect(sql).toContain('resolved_entity_id AS right_entity_id');
    expect(sql).toContain("'mention_link' AS evidence_kind");
    expect(sql).toContain('document_version_id AS source_document_version_id');
    expect(sql).toContain('COALESCE(resolution_confidence, confidence, 0) AS confidence');
    expect(sql).toContain('FROM eg.m');
  });
});

describe('cross-entity-link string-literal escaping is dialect-aware', () => {
  const base = {
    mentionsTable: 'eg.support__document_mentions',
    relationshipName: "o'brien_rel", // contains a single quote
    cardinality: 'many_to_many' as const,
    lineageRunId: 'run-1',
  };

  it("backslash-escapes interpolated literals for BigQuery (\\')", () => {
    const sql = buildMentionDerivedEdgeSelect({ ...base, dialect: 'bigquery' });
    expect(sql).toContain("'o\\'brien_rel' AS relation_type");
  });

  it("doubles interpolated-literal quotes for an ANSI dialect ('')", () => {
    const sql = buildMentionDerivedEdgeSelect({ ...base, dialect: 'duckdb' });
    expect(sql).toContain("'o''brien_rel' AS relation_type");
  });

  it('threads the dialect through the evidence builder too', () => {
    const bq = buildMentionDerivedEvidenceSelect({
      mentionsTable: 'eg.support__document_mentions',
      relationshipName: "o'brien_rel",
      dialect: 'bigquery',
    });
    const duck = buildMentionDerivedEvidenceSelect({
      mentionsTable: 'eg.support__document_mentions',
      relationshipName: "o'brien_rel",
      dialect: 'duckdb',
    });
    expect(bq).toContain("o\\'brien_rel");
    expect(duck).toContain("o''brien_rel");
  });
});
