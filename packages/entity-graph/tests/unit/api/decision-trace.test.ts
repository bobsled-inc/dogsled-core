import { describe, expect, it } from 'vitest';

import { buildSimilarDecisionsQuery } from '../../../src/api/decision-trace.js';

describe('buildSimilarDecisionsQuery', () => {
  it('builds a keyed precedent SELECT against <entity>__review_decisions', () => {
    const sql = buildSimilarDecisionsQuery('company', 'entity_graph', 'duckdb', {
      pairId: 'p1',
      limit: 5,
    });

    expect(sql).toContain('company__review_decisions');
    // Precedent columns the agent reasons over.
    expect(sql).toContain('"pair_id"');
    expect(sql).toContain('"decision"');
    expect(sql).toContain('"confidence"');
    expect(sql).toContain('"reason"');
    expect(sql).toContain('"decision_source"');
    expect(sql).toContain('"decided_at"');
    // Keyed filter + recency ordering + explicit limit.
    expect(sql).toContain(`"pair_id" = 'p1'`);
    expect(sql).toContain('ORDER BY "decided_at" DESC');
    expect(sql).toContain('LIMIT 5');
  });

  it('omits the WHERE clause and defaults the limit when no pair id is given', () => {
    const sql = buildSimilarDecisionsQuery('company', 'public', 'duckdb');

    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('LIMIT 10');
  });

  it('uppercases + quotes the table for case-folding dialects (snowflake)', () => {
    const sql = buildSimilarDecisionsQuery('company', 'entity_graph', 'snowflake', {
      pairId: 'p1',
    });

    expect(sql).toContain('"ENTITY_GRAPH"."COMPANY__REVIEW_DECISIONS"');
  });

  it('quotes the pair id as a literal so it cannot break out of the predicate', () => {
    const sql = buildSimilarDecisionsQuery('company', 'public', 'duckdb', {
      pairId: "p'1",
    });

    // The embedded single quote is escaped by the dialect literal quoter.
    expect(sql).toContain("''");
    expect(sql).not.toMatch(/=\s*'p'1'/);
  });
});
