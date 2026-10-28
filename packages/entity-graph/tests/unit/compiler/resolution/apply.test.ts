import { describe, expect, it } from 'vitest';

import {
  chainReviewApplySql,
  generateApplySql,
} from '../../../../src/compiler/identity/review-apply.js';
import type { ReviewDecisionRow } from '../../../../src/compiler/identity/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MERGE_DECISIONS: ReviewDecisionRow[] = [
  {
    pair_id: 'pair-001',
    decision: 'merge',
    reviewer: 'jane',
    reason: 'Same company',
    decision_batch_id: 'batch-abc',
    decision_source: 'human',
  },
  {
    pair_id: 'pair-002',
    decision: 'merge',
    reviewer: 'john',
  },
];

const NOT_MATCH_DECISIONS: ReviewDecisionRow[] = [
  {
    pair_id: 'pair-003',
    decision: 'not_match',
    reviewer: 'jane',
    reason: 'Different entities',
  },
];

const MIXED_DECISIONS: ReviewDecisionRow[] = [...MERGE_DECISIONS, ...NOT_MATCH_DECISIONS];

const DEFER_DECISIONS: ReviewDecisionRow[] = [
  {
    pair_id: 'pair-004',
    decision: 'defer',
    reviewer: 'human',
  },
  {
    pair_id: 'pair-005',
    decision: 'defer',
  },
];

describe('chainReviewApplySql', () => {
  it('preserves explicit dependencies and stops every later write after a failure', () => {
    const statements = chainReviewApplySql([
      { name: 'audit', sql: 'INSERT audit' },
      { name: 'decisions', sql: 'INSERT decisions' },
      { name: 'materialize', sql: 'UPDATE clusters', deps: ['decision_source_ready'] },
    ]);

    expect(statements[0]!.deps).toBeUndefined();
    expect(statements[1]!.deps).toEqual(['audit']);
    expect(statements[2]!.deps).toEqual(['decision_source_ready', 'decisions']);
  });
});

const DEFAULT_OPTIONS = {
  defaultBatchId: 'batch-default',
  defaultDecisionSource: 'human',
  appliedAt: '2024-01-15T12:00:00Z',
};

function mustFindStatement(statements: ReturnType<typeof generateApplySql>, name: string) {
  const statement = statements.find((entry) => entry.name === name);
  if (!statement) {
    throw new Error(`Expected statement "${name}" to be generated`);
  }
  return statement;
}

// ---------------------------------------------------------------------------
// generateApplySql — statement names and counts
// ---------------------------------------------------------------------------

describe('generateApplySql — statement names', () => {
  it('returns 3 statements with merge decisions (apply, delete, refresh)', () => {
    const statements = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(3);
    expect(statements.map((s) => s.name)).toEqual([
      'apply_review_decisions',
      'delete_affected_not_match_edges',
      'refresh_not_match_edges',
    ]);
  });

  it('returns 3 statements with not_match decisions', () => {
    const statements = generateApplySql(
      NOT_MATCH_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(3);
    expect(statements.some((s) => s.name === 'refresh_not_match_edges')).toBe(true);
  });

  it('returns 3 statements with mixed merge and not_match decisions', () => {
    const statements = generateApplySql(
      MIXED_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(3);
    expect(statements[0]!.name).toBe('apply_review_decisions');
    expect(statements[1]!.name).toBe('delete_affected_not_match_edges');
    expect(statements[2]!.name).toBe('refresh_not_match_edges');
  });

  it('returns empty array when all decisions are deferred', () => {
    const statements = generateApplySql(
      DEFER_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.name).toBe('apply_review_decisions_pending');
  });

  it('returns empty array for empty decisions array', () => {
    const statements = generateApplySql(
      [],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — apply_review_decisions SQL shape
// ---------------------------------------------------------------------------

describe('generateApplySql — apply_review_decisions SQL shape (snowflake)', () => {
  it('targets the correct fully-qualified review_decisions table', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain('"ENTITY_GRAPH"."COMPANY__REVIEW_DECISIONS"');
  });

  it('contains the idempotency NOT EXISTS predicate', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain('WHERE NOT EXISTS');
  });

  it('uses the incoming_decisions CTE', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain('WITH incoming_decisions AS');
    expect(applyStmt!.sql).toContain('FROM incoming_decisions incoming');
  });

  it('inserts into the correct column list', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain('"PAIR_ID"');
    expect(applyStmt!.sql).toContain('"DECISION"');
    expect(applyStmt!.sql).toContain('"REVIEWER"');
    expect(applyStmt!.sql).toContain('"REASON"');
    expect(applyStmt!.sql).toContain('"CONFIDENCE"');
    expect(applyStmt!.sql).toContain('"PROPOSED_DECISION"');
    expect(applyStmt!.sql).toContain('"PROPOSED_CONFIDENCE"');
    expect(applyStmt!.sql).toContain('"STATUS"');
    expect(applyStmt!.sql).toContain('"DECISION_BATCH_ID"');
    expect(applyStmt!.sql).toContain('"DECISION_SOURCE"');
    expect(applyStmt!.sql).toContain('"DECIDED_AT"');
    expect(applyStmt!.sql).toContain('"APPLIED_AT"');
  });

  it('persists confidence and proposal fields when present', () => {
    const [applyStmt] = generateApplySql(
      [
        {
          pair_id: 'pair-123',
          decision: 'merge',
          reviewer: 'agent',
          confidence: 0.72,
          proposed_decision: 'merge',
          proposed_confidence: 0.72,
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain("'merge'");
    expect(applyStmt!.sql).toContain('0.72');
    expect(applyStmt!.sql).toContain('"PROPOSED_DECISION"');
    expect(applyStmt!.sql).toContain("'applied'");
  });

  it('embeds literal pair_id and decision values from input', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain("'pair-001'");
    expect(applyStmt!.sql).toContain("'merge'");
    expect(applyStmt!.sql).toContain("'pair-002'");
  });

  it('escapes SQL metacharacters in decision literals', () => {
    const tricky: ReviewDecisionRow[] = [
      {
        pair_id: "pair-'\\-001",
        decision: 'merge',
        reviewer: `o'hara`,
        reason: `backslash\\quote' "double"`,
      },
    ];

    const [applyStmt] = generateApplySql(
      tricky,
      'company',
      'bigquery',
      'entity_graph',
      DEFAULT_OPTIONS
    );
    expect(applyStmt).toBeDefined();
    if (!applyStmt) {
      throw new Error('Expected apply_review_decisions statement to be generated');
    }
    expect(applyStmt.sql).toContain("'pair-\\'\\\\-001'");
    expect(applyStmt.sql).toContain("'o\\'hara'");
    expect(applyStmt.sql).toContain("'backslash\\\\quote\\' \"double\"'");
  });

  it('uses the provided appliedAt timestamp literal', () => {
    const [applyStmt] = generateApplySql(MERGE_DECISIONS, 'company', 'snowflake', 'ENTITY_GRAPH', {
      ...DEFAULT_OPTIONS,
      appliedAt: '2024-06-01T00:00:00Z',
    });

    expect(applyStmt!.sql).toContain("'2024-06-01T00:00:00Z'");
  });

  it('falls back to CURRENT_TIMESTAMP when appliedAt is omitted', () => {
    const [applyStmt] = generateApplySql(MERGE_DECISIONS, 'company', 'snowflake', 'ENTITY_GRAPH', {
      defaultBatchId: 'batch-x',
    });

    expect(applyStmt!.sql).toContain('CURRENT_TIMESTAMP');
  });

  it('uses defaultBatchId when decision has no batch id', () => {
    const decisionsWithoutBatch: ReviewDecisionRow[] = [{ pair_id: 'pair-999', decision: 'merge' }];

    const [applyStmt] = generateApplySql(
      decisionsWithoutBatch,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      {
        defaultBatchId: 'my-batch-id',
      }
    );

    expect(applyStmt!.sql).toContain("'my-batch-id'");
  });

  it('uses decision.decision_batch_id over defaultBatchId when present', () => {
    const decisionsWithBatch: ReviewDecisionRow[] = [
      { pair_id: 'pair-999', decision: 'merge', decision_batch_id: 'override-batch' },
    ];

    const [applyStmt] = generateApplySql(
      decisionsWithBatch,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      {
        defaultBatchId: 'default-batch',
      }
    );

    expect(applyStmt!.sql).toContain("'override-batch'");
    expect(applyStmt!.sql).not.toContain("'default-batch'");
  });

  it('uses null-safe equality in the idempotency check for nullable columns', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain(
      'existing."PROPOSED_DECISION" = incoming."PROPOSED_DECISION" OR (existing."PROPOSED_DECISION" IS NULL AND incoming."PROPOSED_DECISION" IS NULL)'
    );
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — refresh_not_match_edges SQL shape
// ---------------------------------------------------------------------------

describe('generateApplySql — refresh_not_match_edges SQL shape (snowflake)', () => {
  it('targets the correct fully-qualified not_match_edges table', () => {
    const statements = generateApplySql(
      NOT_MATCH_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const refreshStmt = mustFindStatement(statements, 'refresh_not_match_edges');
    expect(refreshStmt.sql).toContain('"ENTITY_GRAPH"."COMPANY__NOT_MATCH_EDGES"');
  });

  it('contains ROW_NUMBER() deduplication in latest_decisions CTE', () => {
    const statements = generateApplySql(
      NOT_MATCH_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const refreshStmt = mustFindStatement(statements, 'refresh_not_match_edges');
    expect(refreshStmt.sql).toContain('ROW_NUMBER()');
    expect(refreshStmt.sql).toContain('PARTITION BY');
    expect(refreshStmt.sql).toContain('latest_decisions');
  });

  it('joins pair_scores to populate record_a_id and record_b_id', () => {
    const statements = generateApplySql(
      NOT_MATCH_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const refreshStmt = mustFindStatement(statements, 'refresh_not_match_edges');
    expect(refreshStmt.sql).toContain('"ENTITY_GRAPH"."COMPANY__PAIR_SCORES"');
    expect(refreshStmt.sql).toContain('"RECORD_A_ID"');
    expect(refreshStmt.sql).toContain('"RECORD_B_ID"');
  });

  it('filters INSERT to only not_match decisions', () => {
    const statements = generateApplySql(
      MIXED_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const refreshStmt = mustFindStatement(statements, 'refresh_not_match_edges');
    expect(refreshStmt.sql).toContain("'not_match'");
  });

  it('selects status into latest_decisions before filtering on applied rows', () => {
    const statements = generateApplySql(
      NOT_MATCH_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    const refreshStmt = mustFindStatement(statements, 'refresh_not_match_edges');
    expect(refreshStmt.sql).toContain('"status",');
    expect(refreshStmt.sql).toContain(`COALESCE(ld."status", 'applied') = 'applied'`);
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — delete_affected_not_match_edges SQL shape
// ---------------------------------------------------------------------------

describe('generateApplySql — delete_affected_not_match_edges SQL shape (snowflake)', () => {
  it('deletes from not_match_edges table', () => {
    const statements = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const deleteStmt = mustFindStatement(statements, 'delete_affected_not_match_edges');
    expect(deleteStmt.sql).toContain('DELETE FROM');
    expect(deleteStmt.sql).toContain('"ENTITY_GRAPH"."COMPANY__NOT_MATCH_EDGES"');
  });

  it('contains the affected_pairs and latest_decisions CTEs', () => {
    const statements = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const deleteStmt = mustFindStatement(statements, 'delete_affected_not_match_edges');
    expect(deleteStmt.sql).toContain('affected_pairs');
    expect(deleteStmt.sql).toContain('latest_decisions');
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — dialect differences
// ---------------------------------------------------------------------------

describe('generateApplySql — duckdb dialect', () => {
  it('uses lowercase column identifiers with double quotes', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    // DuckDB uses lowercase identifiers
    expect(applyStmt!.sql).toContain('"pair_id"');
    expect(applyStmt!.sql).toContain('"decision"');
    expect(applyStmt!.sql).not.toContain('"PAIR_ID"');
  });

  it('targets the correct duckdb fully-qualified review_decisions table', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain('"entity_graph"."company__review_decisions"');
  });

  it('still contains NOT EXISTS idempotency predicate', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain('WHERE NOT EXISTS');
  });

  it('uses null-safe equality instead of string-coalescing nullable text fields', () => {
    const [applyStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    expect(applyStmt!.sql).toContain(
      'existing."proposed_decision" = incoming."proposed_decision" OR (existing."proposed_decision" IS NULL AND incoming."proposed_decision" IS NULL)'
    );
    expect(applyStmt!.sql).not.toContain(
      'COALESCE(existing."proposed_decision", \'\') = COALESCE(incoming."proposed_decision", \'\')'
    );
  });

  it('refresh_not_match_edges still contains ROW_NUMBER() on duckdb', () => {
    const statements = generateApplySql(
      NOT_MATCH_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    const refreshStmt = mustFindStatement(statements, 'refresh_not_match_edges');
    expect(refreshStmt.sql).toContain('ROW_NUMBER()');
  });
});

describe('generateApplySql — snowflake vs duckdb dialect comparison', () => {
  it('snowflake uses UPPER identifiers, duckdb uses lower identifiers', () => {
    const [sfStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const [duckStmt] = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    expect(sfStmt!.sql).toContain('"PAIR_ID"');
    expect(duckStmt!.sql).toContain('"pair_id"');
  });

  it('both dialects contain NOT EXISTS for idempotency', () => {
    const sfStatements = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const duckStatements = generateApplySql(
      MERGE_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    expect(sfStatements[0]!.sql).toContain('WHERE NOT EXISTS');
    expect(duckStatements[0]!.sql).toContain('WHERE NOT EXISTS');
  });

  it('both dialects return 3 statements for non-deferred decisions', () => {
    const sfStatements = generateApplySql(
      MIXED_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const duckStatements = generateApplySql(
      MIXED_DECISIONS,
      'company',
      'duckdb',
      'entity_graph',
      DEFAULT_OPTIONS
    );

    expect(sfStatements).toHaveLength(3);
    expect(duckStatements).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — defer filtering behavior
// ---------------------------------------------------------------------------

describe('generateApplySql — defer filtering', () => {
  it('filters out deferred decisions, applies only non-deferred', () => {
    const mixedWithDefer: ReviewDecisionRow[] = [
      ...MERGE_DECISIONS,
      { pair_id: 'pair-defer-1', decision: 'defer' },
    ];

    const statements = generateApplySql(
      mixedWithDefer,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(4);

    const [applyStmt, pendingStmt] = statements;
    expect(applyStmt!.sql).not.toContain("'pair-defer-1'");
    expect(pendingStmt!.sql).toContain("'pair-defer-1'");

    // Merge decisions should still be present
    expect(applyStmt!.sql).toContain("'pair-001'");
  });

  it('returns empty when only deferred decisions are present', () => {
    const statements = generateApplySql(
      DEFER_DECISIONS,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.name).toBe('apply_review_decisions_pending');
  });

  it('routes status=proposed merge/not_match decisions into the pending statement', () => {
    const mixedWithProposed: ReviewDecisionRow[] = [
      ...MERGE_DECISIONS,
      {
        pair_id: 'pair-proposed-merge',
        decision: 'merge',
        status: 'proposed',
        reviewer: 'agent',
        confidence: 0.62,
        proposed_decision: 'merge',
        proposed_confidence: 0.62,
      },
      {
        pair_id: 'pair-proposed-nm',
        decision: 'not_match',
        status: 'proposed',
        reviewer: 'agent',
        confidence: 0.7,
        proposed_decision: 'not_match',
        proposed_confidence: 0.7,
      },
    ];

    const statements = generateApplySql(
      mixedWithProposed,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    const applyStmt = statements.find((s) => s.name === 'apply_review_decisions');
    const pendingStmt = statements.find((s) => s.name === 'apply_review_decisions_pending');

    expect(applyStmt).toBeDefined();
    expect(pendingStmt).toBeDefined();
    // Proposed rows are NOT in the auto-apply statement.
    expect(applyStmt!.sql).not.toContain("'pair-proposed-merge'");
    expect(applyStmt!.sql).not.toContain("'pair-proposed-nm'");
    // They land in the pending statement instead.
    expect(pendingStmt!.sql).toContain("'pair-proposed-merge'");
    expect(pendingStmt!.sql).toContain("'pair-proposed-nm'");
    expect(pendingStmt!.sql).toContain("'proposed'");
    // Applied merges still flow through.
    expect(applyStmt!.sql).toContain("'pair-001'");
  });

  it('returns only the pending statement when every decision is proposed', () => {
    const onlyProposed: ReviewDecisionRow[] = [
      {
        pair_id: 'pair-prop-1',
        decision: 'merge',
        status: 'proposed',
        reviewer: 'agent',
        confidence: 0.55,
      },
    ];

    const statements = generateApplySql(
      onlyProposed,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_OPTIONS
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.name).toBe('apply_review_decisions_pending');
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — entity name interpolation
// ---------------------------------------------------------------------------

describe('generateApplySql — entity name in table names', () => {
  it('uses the entity name as a prefix for all output tables (snowflake)', () => {
    const statements = generateApplySql(
      MERGE_DECISIONS,
      'account',
      'snowflake',
      'PUBLIC',
      DEFAULT_OPTIONS
    );

    expect(statements[0]!.sql).toContain('"PUBLIC"."ACCOUNT__REVIEW_DECISIONS"');
    const deleteStmt = mustFindStatement(statements, 'delete_affected_not_match_edges');
    expect(deleteStmt.sql).toContain('"PUBLIC"."ACCOUNT__NOT_MATCH_EDGES"');
  });
});

// ---------------------------------------------------------------------------
// generateApplySql — dialect matrix
// ---------------------------------------------------------------------------

describe('generateApplySql — dialect matrix', () => {
  const DIALECT_CASES = [
    {
      dialect: 'snowflake' as const,
      schema: 'ENTITY_GRAPH',
      expectedTableRef: '"ENTITY_GRAPH"."COMPANY__REVIEW_DECISIONS"',
    },
    {
      dialect: 'duckdb' as const,
      schema: 'entity_graph',
      expectedTableRef: '"entity_graph"."company__review_decisions"',
    },
    {
      dialect: 'bigquery' as const,
      schema: 'entity_graph',
      expectedTableRef: '`entity_graph`.`company__review_decisions`',
    },
    {
      dialect: 'postgres' as const,
      schema: 'public',
      expectedTableRef: '"public"."company__review_decisions"',
    },
    {
      dialect: 'databricks' as const,
      schema: 'analytics',
      expectedTableRef: '`analytics`.`company__review_decisions`',
    },
    {
      dialect: 'mysql' as const,
      schema: 'entity_graph',
      expectedTableRef: '`entity_graph`.`company__review_decisions`',
    },
    {
      dialect: 'clickhouse' as const,
      schema: 'entity_graph',
      expectedTableRef: '`entity_graph`.`company__review_decisions`',
    },
  ];

  it.each(DIALECT_CASES)(
    'emits stable statements for $dialect',
    ({ dialect, schema, expectedTableRef }) => {
      const statements = generateApplySql(
        MIXED_DECISIONS,
        'company',
        dialect,
        schema,
        DEFAULT_OPTIONS
      );
      expect(statements).toHaveLength(3);
      expect(statements.map((s) => s.name)).toEqual([
        'apply_review_decisions',
        'delete_affected_not_match_edges',
        'refresh_not_match_edges',
      ]);
      const applyStmt = mustFindStatement(statements, 'apply_review_decisions');
      expect(applyStmt.sql).toContain(expectedTableRef);
    }
  );
});
