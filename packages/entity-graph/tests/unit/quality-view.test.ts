import { describe, it, expect } from 'vitest';

import {
  buildMentionQualityViewSelect,
  buildRelationshipEvidenceDiversitySelect,
} from '../../src/runtime/mention/quality-view.js';

describe('buildMentionQualityViewSelect', () => {
  it('emits all four documented quality columns when no profile table supplied', () => {
    const sql = buildMentionQualityViewSelect({
      mentionsTable: 'eg.support__document_mentions',
    });
    expect(sql).toContain('m.mention_id');
    expect(sql).toContain('m.resolution_confidence AS mention_confidence');
    expect(sql).toContain('AS freshness_age_seconds');
    expect(sql).toContain('AS source_diversity');
    expect(sql).toContain('AS profile_coverage');
    // No profile table → portable numeric literal fallback. Avoid
    // dialect-specific cast syntax (`CAST(0.0 AS DOUBLE)`) since
    // Postgres requires `DOUBLE PRECISION` and BigQuery `FLOAT64`.
    expect(sql).toContain('0.0 AS profile_coverage');
    expect(sql).not.toContain('CAST(0.0');
  });

  it('joins entity profile when profileTable supplied', () => {
    const sql = buildMentionQualityViewSelect({
      mentionsTable: 'eg.support__document_mentions',
      profileTable: 'eg.profile_company',
    });
    expect(sql).toContain('LEFT JOIN eg.profile_company p ON p.entity_id = m.resolved_entity_id');
    expect(sql).toContain('COALESCE(p.profile_coverage, 0.0)');
  });

  it('aggregates source_diversity over the corpus per resolved entity', () => {
    const sql = buildMentionQualityViewSelect({ mentionsTable: 'eg.m' });
    expect(sql).toContain('WITH entity_corpus_diversity AS');
    expect(sql).toContain('COUNT(DISTINCT document_id) AS source_diversity');
    expect(sql).toContain('GROUP BY resolved_entity_id');
  });

  it('skips superseded mentions in both the diversity CTE and the outer query', () => {
    const sql = buildMentionQualityViewSelect({ mentionsTable: 'eg.m' });
    // Two superseded_at filters: one in the diversity CTE, one outer.
    const matches = sql.match(/superseded_at IS NULL/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects unsafe identifiers via assertSafeIdentifier', () => {
    expect(() =>
      buildMentionQualityViewSelect({ mentionsTable: "eg.m'); DROP TABLE x; --" })
    ).toThrow(/Invalid SQL identifier/);
  });

  it('emits dialect-correct timestamp-diff expressions', () => {
    const duckdb = buildMentionQualityViewSelect({ mentionsTable: 'eg.m', dialect: 'duckdb' });
    expect(duckdb).toContain('EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - m.extracted_at))');

    const postgres = buildMentionQualityViewSelect({ mentionsTable: 'eg.m', dialect: 'postgres' });
    expect(postgres).toContain('EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - m.extracted_at))');

    const snowflake = buildMentionQualityViewSelect({
      mentionsTable: 'eg.m',
      dialect: 'snowflake',
    });
    expect(snowflake).toContain('EXTRACT(epoch_second FROM CURRENT_TIMESTAMP)');
    expect(snowflake).toContain('EXTRACT(epoch_second FROM m.extracted_at)');

    const bigquery = buildMentionQualityViewSelect({
      mentionsTable: 'eg.m',
      dialect: 'bigquery',
    });
    expect(bigquery).toContain('TIMESTAMP_DIFF(CURRENT_TIMESTAMP, m.extracted_at, SECOND)');
  });
});

describe('buildRelationshipEvidenceDiversitySelect', () => {
  it('counts distinct evidence_kind values per edge', () => {
    const sql = buildRelationshipEvidenceDiversitySelect({
      evidenceTable: 'eg.__entity_relationship_evidence',
    });
    expect(sql).toContain('COUNT(DISTINCT evidence_kind) AS evidence_diversity_kinds');
    expect(sql).toContain('COUNT(*) AS evidence_count');
    expect(sql).toContain('AS freshness_age_seconds');
    expect(sql).toContain('GROUP BY relationship_id');
  });

  it('rejects unsafe identifiers', () => {
    expect(() => buildRelationshipEvidenceDiversitySelect({ evidenceTable: 'has space' })).toThrow(
      /Invalid SQL identifier/
    );
  });

  it('honors the dialect option', () => {
    const bq = buildRelationshipEvidenceDiversitySelect({
      evidenceTable: 'eg.evidence',
      dialect: 'bigquery',
    });
    expect(bq).toContain('TIMESTAMP_DIFF(CURRENT_TIMESTAMP, MAX(recorded_at), SECOND)');
    const sf = buildRelationshipEvidenceDiversitySelect({
      evidenceTable: 'eg.evidence',
      dialect: 'snowflake',
    });
    expect(sf).toContain('EXTRACT(epoch_second FROM MAX(recorded_at))');
  });
});
