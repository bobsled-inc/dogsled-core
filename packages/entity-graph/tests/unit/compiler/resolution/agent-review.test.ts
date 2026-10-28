import { describe, expect, it } from 'vitest';

import {
  generateAgentDecisionSql,
  generateUnreviewedPairsQuery,
} from '../../../../src/compiler/identity/agent-review.js';

import type { PairDecision } from '../../../../src/compiler/identity/types.js';

// ---------------------------------------------------------------------------
// generateAgentDecisionSql
// ---------------------------------------------------------------------------

// `autoApplyThreshold` is required on AgentDecisionSqlOptions; pick a default
// that lets existing high-confidence fixtures (>= 0.85) still flow into
// `applied` so legacy assertions remain valid.
const DEFAULT_TEST_OPTIONS = { autoApplyThreshold: 0.85 } as const;

describe('generateAgentDecisionSql', () => {
  it('returns empty array when given no decisions', () => {
    const statements = generateAgentDecisionSql(
      [],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    );
    expect(statements).toHaveLength(0);
  });

  it('produces a single INSERT into __review_decisions for merge-only decisions', () => {
    const decisions: PairDecision[] = [
      { pairId: 'pair-001', decision: 'merge', confidence: 0.95, reasoning: 'Same domain' },
      { pairId: 'pair-002', decision: 'merge', confidence: 0.88, reasoning: 'Exact name match' },
    ];

    const statements = generateAgentDecisionSql(
      decisions,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.name).toBe('agent_review_decisions');
    expect(statements[0]!.sql).toContain('INSERT INTO');
    expect(statements[0]!.sql.toUpperCase()).toContain('__REVIEW_DECISIONS');
  });

  it('produces two INSERT statements when there are not_match decisions', () => {
    const decisions: PairDecision[] = [
      { pairId: 'pair-001', decision: 'merge', confidence: 0.95, reasoning: 'Same domain' },
      {
        pairId: 'pair-002',
        decision: 'not_match',
        confidence: 0.92,
        reasoning: 'Different entities',
      },
    ];

    const statements = generateAgentDecisionSql(
      decisions,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]!.name).toBe('agent_review_decisions');
    expect(statements[1]!.name).toBe('agent_not_match_edges');
    expect(statements[1]!.sql.toUpperCase()).toContain('__NOT_MATCH_EDGES');
  });

  it('does not emit __not_match_edges INSERT when all decisions are merges', () => {
    const decisions: PairDecision[] = [
      { pairId: 'pair-001', decision: 'merge', confidence: 0.9, reasoning: 'Match' },
    ];

    const statements = generateAgentDecisionSql(
      decisions,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    );

    expect(statements).toHaveLength(1);
    expect(statements.some((s) => s.name === 'agent_not_match_edges')).toBe(false);
  });

  it('INSERT into __review_decisions includes confidence-routing columns', () => {
    const decisions: PairDecision[] = [
      { pairId: 'pair-001', decision: 'merge', confidence: 0.9, reasoning: 'Same entity' },
    ];

    const sql = generateAgentDecisionSql(
      decisions,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    )[0]!.sql;

    // Column names are uppercased + double-quoted for Snowflake
    expect(sql).toContain('"PAIR_ID"');
    expect(sql).toContain('"DECISION"');
    expect(sql).toContain('"REVIEWER"');
    expect(sql).toContain('"REASON"');
    expect(sql).toContain('"CONFIDENCE"');
    expect(sql).toContain('"PROPOSED_DECISION"');
    expect(sql).toContain('"PROPOSED_CONFIDENCE"');
    expect(sql).toContain('"STATUS"');
    expect(sql).toContain('"DECIDED_AT"');
    expect(sql).toContain('"DECISION_BATCH_ID"');
    expect(sql).toContain('"DECISION_SOURCE"');
  });

  it('writes the pair_id and decision values into the VALUES clause', () => {
    const decisions: PairDecision[] = [
      { pairId: 'pair-abc', decision: 'not_match', confidence: 0.85, reasoning: 'Diff company' },
    ];

    const sql = generateAgentDecisionSql(
      decisions,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    )[0]!.sql;

    expect(sql).toContain("'pair-abc'");
    expect(sql).toContain("'not_match'");
    expect(sql).toContain("'agent'"); // reviewer is always 'agent'
    expect(sql).toContain("'Diff company'"); // reasoning is passed through
    expect(sql).toContain('0.85');
    expect(sql).toContain("'applied'");
    expect(sql).toContain("'agent_auto'"); // decision_source is always 'agent_auto'
  });

  it('escapes apostrophes in reasoning', () => {
    const sql = generateAgentDecisionSql(
      [
        {
          pairId: 'pair-escaped',
          decision: 'not_match',
          confidence: 0.85,
          reasoning: "O'Reilly",
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    )[0]!.sql;

    expect(sql).toContain("'pair-escaped'");
    expect(sql).toContain("'O''Reilly'");
    expect(sql).not.toContain("'O'Reilly'");
  });

  it('works with bigquery dialect (backtick quoting, lowercase identifiers)', () => {
    const decisions: PairDecision[] = [
      { pairId: 'pair-001', decision: 'merge', confidence: 0.9, reasoning: 'Match' },
    ];

    const statements = generateAgentDecisionSql(
      decisions,
      'company',
      'bigquery',
      'entity_graph',
      DEFAULT_TEST_OPTIONS
    );

    expect(statements).toHaveLength(1);
    const sql = statements[0]!.sql;
    expect(sql).toContain('`pair_id`');
    expect(sql).toContain('`decision`');
    expect(sql).toContain('`reviewer`');
    expect(sql).toContain('`status`');
  });

  it('only inserts the not_match pair IDs into __not_match_edges, not the merge ones', () => {
    const decisions: PairDecision[] = [
      { pairId: 'merge-pair', decision: 'merge', confidence: 0.95, reasoning: 'Match' },
      { pairId: 'reject-pair', decision: 'not_match', confidence: 0.9, reasoning: 'No match' },
    ];

    const statements = generateAgentDecisionSql(
      decisions,
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      DEFAULT_TEST_OPTIONS
    );
    const reviewSql = statements[0]!.sql;
    const edgesSql = statements[1]!.sql;
    const batchId = reviewSql.match(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
    )?.[0];

    expect(batchId).toBeDefined();
    expect(edgesSql).toContain("'reject-pair'");
    expect(edgesSql).not.toContain("'merge-pair'");
    expect(edgesSql).toContain('"PAIR_ID"');
    expect(edgesSql).toContain(`"DECISION_BATCH_ID" = '${batchId}'`);
  });

  it('stores low-confidence apply decisions as proposed, preserving the agent call', () => {
    const statements = generateAgentDecisionSql(
      [
        { pairId: 'pair-low', decision: 'not_match', confidence: 0.61, reasoning: 'unclear' },
        { pairId: 'pair-high', decision: 'not_match', confidence: 0.93, reasoning: 'clear miss' },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      {
        mode: 'apply',
        autoApplyThreshold: 0.75,
      }
    );

    const decisionsStatement = statements.find(
      (statement) => statement.name === 'agent_review_decisions'
    );
    const edgesStatement = statements.find(
      (statement) => statement.name === 'agent_not_match_edges'
    );

    expect(decisionsStatement).toBeDefined();
    // The agent's call (`not_match`) is preserved on the row regardless of
    // confidence; only the status differentiates applied vs proposed.
    expect(decisionsStatement!.sql).toContain("'proposed'");
    expect(decisionsStatement!.sql).toContain("'applied'");
    // not_match_edges is only emitted for applied rows, not proposed.
    expect(edgesStatement).toBeDefined();
    expect(edgesStatement!.sql).toContain("'pair-high'");
    expect(edgesStatement!.sql).not.toContain("'pair-low'");
  });

  it('records agent-defer decisions with status=deferred and decision=defer', () => {
    const statements = generateAgentDecisionSql(
      [
        {
          pairId: 'pair-defer',
          decision: 'defer',
          confidence: 0.3,
          reasoning: 'too sparse to evaluate',
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      { mode: 'apply', autoApplyThreshold: 0.75 }
    );

    expect(statements[0]!.sql).toContain("'pair-defer'");
    expect(statements[0]!.sql).toContain("'defer'");
    expect(statements[0]!.sql).toContain("'deferred'");
    expect(statements.some((statement) => statement.name === 'agent_not_match_edges')).toBe(false);
  });

  it('routes merge decisions to applied or proposed based on auto-apply threshold', () => {
    const statements = generateAgentDecisionSql(
      [
        { pairId: 'pair-applied', decision: 'merge', confidence: 0.95, reasoning: 'exact match' },
        {
          pairId: 'pair-proposed',
          decision: 'merge',
          confidence: 0.7,
          reasoning: 'name typo, same email',
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      { mode: 'apply', autoApplyThreshold: 0.85 }
    );

    const decisionsStatement = statements.find(
      (statement) => statement.name === 'agent_review_decisions'
    );
    expect(decisionsStatement).toBeDefined();
    expect(decisionsStatement!.sql).toContain("'pair-applied'");
    expect(decisionsStatement!.sql).toContain("'pair-proposed'");
    expect(decisionsStatement!.sql).toContain("'applied'");
    expect(decisionsStatement!.sql).toContain("'proposed'");
    // Both rows store decision='merge' — the agent's call is preserved.
    expect(decisionsStatement!.sql).toContain("'merge'");
  });

  it('promotes the agent confidence onto proposed_confidence for low-confidence applies', () => {
    const statements = generateAgentDecisionSql(
      [
        {
          pairId: 'pair-prop',
          decision: 'merge',
          confidence: 0.6,
          reasoning: 'partial overlap',
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      { mode: 'apply', autoApplyThreshold: 0.85 }
    );

    const decisionsStatement = statements.find(
      (statement) => statement.name === 'agent_review_decisions'
    );
    expect(decisionsStatement).toBeDefined();
    // Both proposed_decision and proposed_confidence should carry the agent's
    // call so reviewers can see "agent proposed merge @ 0.60" as evidence.
    expect(decisionsStatement!.sql).toContain('0.6');
    expect(decisionsStatement!.sql).toContain("'merge'");
    expect(decisionsStatement!.sql).toContain("'proposed'");
  });

  it('treats not_match parallel to merge for the proposed gate', () => {
    const statements = generateAgentDecisionSql(
      [
        { pairId: 'pair-nm-app', decision: 'not_match', confidence: 0.92, reasoning: 'distinct' },
        {
          pairId: 'pair-nm-prop',
          decision: 'not_match',
          confidence: 0.65,
          reasoning: 'leaning distinct',
        },
      ],
      'company',
      'snowflake',
      'ENTITY_GRAPH',
      { mode: 'apply', autoApplyThreshold: 0.85 }
    );

    const decisionsStatement = statements.find(
      (statement) => statement.name === 'agent_review_decisions'
    );
    const edgesStatement = statements.find(
      (statement) => statement.name === 'agent_not_match_edges'
    );
    expect(decisionsStatement).toBeDefined();
    expect(decisionsStatement!.sql).toContain("'pair-nm-app'");
    expect(decisionsStatement!.sql).toContain("'pair-nm-prop'");
    expect(edgesStatement).toBeDefined();
    // Only the applied not_match writes through to the edges projection.
    expect(edgesStatement!.sql).toContain("'pair-nm-app'");
    expect(edgesStatement!.sql).not.toContain("'pair-nm-prop'");
  });
});

// ---------------------------------------------------------------------------
// generateUnreviewedPairsQuery
// ---------------------------------------------------------------------------

describe('generateUnreviewedPairsQuery', () => {
  it('returns a SQL string', () => {
    const sql = generateUnreviewedPairsQuery('company', 'snowflake', 'ENTITY_GRAPH');
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(0);
  });

  it('filters threshold_band to review', () => {
    const sql = generateUnreviewedPairsQuery('company', 'snowflake', 'ENTITY_GRAPH');
    expect(sql).toContain("'review'");
  });

  it('filters unreviewed pairs to the review bands', () => {
    const sql = generateUnreviewedPairsQuery('company', 'snowflake', 'ENTITY_GRAPH');
    expect(sql).toContain(`"THRESHOLD_BAND" IN ('review', 'deterministic_review')`);
    expect(sql).not.toContain("'agent_review'");
    expect(sql).not.toContain("'human_review'");
  });

  it('excludes already-reviewed pairs using a subquery against __review_decisions', () => {
    const sql = generateUnreviewedPairsQuery('company', 'snowflake', 'ENTITY_GRAPH');
    expect(sql.toUpperCase()).toContain('__REVIEW_DECISIONS');
    expect(sql.toUpperCase()).toContain('NOT EXISTS');
  });

  it('selects from __review_queue and references __review_decisions in the subquery', () => {
    const sql = generateUnreviewedPairsQuery('company', 'snowflake', 'ENTITY_GRAPH');
    expect(sql.toUpperCase()).toContain('__REVIEW_QUEUE');
    expect(sql.toUpperCase()).toContain('__REVIEW_DECISIONS');
  });

  it('orders results by composite_score ascending', () => {
    const sql = generateUnreviewedPairsQuery('company', 'snowflake', 'ENTITY_GRAPH');
    expect(sql.toUpperCase()).toContain('ORDER BY');
    expect(sql.toUpperCase()).toContain('COMPOSITE_SCORE');
    expect(sql.toUpperCase()).toContain('ASC');
  });

  it('uses entity name in the table names', () => {
    const sql = generateUnreviewedPairsQuery('account', 'snowflake', 'ENTITY_GRAPH');
    expect(sql.toUpperCase()).toContain('ACCOUNT__REVIEW_QUEUE');
    expect(sql.toUpperCase()).toContain('ACCOUNT__REVIEW_DECISIONS');
  });

  it('works with bigquery dialect (backtick quoting)', () => {
    const sql = generateUnreviewedPairsQuery('company', 'bigquery', 'entity_graph');
    expect(sql).toContain('`threshold_band`');
    expect(sql).toContain('`pair_id`');
    expect(sql.toUpperCase()).toContain('__REVIEW_DECISIONS');
  });
});
