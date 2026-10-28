import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonFromClaudeText } from '../src/lib/claude-json';
import {
  AGENT_SAMPLE_LIMIT,
  buildAgentProposalDecisionRows,
  buildAgentReviewSampleResult,
  clampAgentSampleLimit,
  getClaudeFailureHttpStatus,
  parseClaudeAgentAssessmentPayload,
  readAgentProposalFromQueueRow,
} from '../src/lib/entity-graph-agent-sample';
import {
  buildAgentReviewPromptCandidates,
  type AgentReviewCandidate,
} from '../src/lib/entity-graph-agent-sample-server';
import { buildEntityGraphQueueStatusClause } from '../src/lib/entity-graph-review-status';

test('agent sample limit defaults to 10 and clamps to demo bounds', () => {
  assert.equal(AGENT_SAMPLE_LIMIT, 10);
  assert.equal(clampAgentSampleLimit(undefined), AGENT_SAMPLE_LIMIT);
  assert.equal(clampAgentSampleLimit(0), 1);
  assert.equal(clampAgentSampleLimit('99'), AGENT_SAMPLE_LIMIT);
  assert.equal(clampAgentSampleLimit('4.8'), 4);
});

test('Claude assessment parsing accepts fenced JSON and validates pair ids', () => {
  const payload = parseJsonFromClaudeText(`Here is the JSON:
\`\`\`json
{
  "assessments": [
    {
      "pair_id": "pair-1",
      "proposed_decision": "merge",
      "proposed_confidence": 0.82,
      "assessment": "Same phone and home store, with only nickname drift."
    }
  ]
}
\`\`\``);

  const parsed = parseClaudeAgentAssessmentPayload(payload, {
    allowedPairIds: new Set(['pair-1']),
  });

  assert.deepEqual(parsed, [
    {
      pair_id: 'pair-1',
      proposed_decision: 'merge',
      proposed_confidence: 0.82,
      assessment: 'Same phone and home store, with only nickname drift.',
    },
  ]);
});

test('Claude JSON and assessment parsing reject invalid structured output', () => {
  assert.throws(() => parseJsonFromClaudeText('not json at all'), /parseable JSON/);
  assert.equal(
    parseClaudeAgentAssessmentPayload({
      assessments: [{ pair_id: 'pair-2', proposed_decision: 'merge', proposed_confidence: 0.9 }],
    }),
    null
  );
  assert.equal(
    parseClaudeAgentAssessmentPayload(
      {
        assessments: [
          {
            pair_id: 'unknown',
            proposed_decision: 'merge',
            proposed_confidence: 0.9,
            assessment: 'Looks similar.',
          },
        ],
      },
      { allowedPairIds: new Set(['pair-1']) }
    ),
    null
  );
  assert.equal(
    parseClaudeAgentAssessmentPayload({
      assessments: [
        {
          pair_id: 'pair-2',
          decision: 'merge',
          confidence: 0.9,
          reason: 'Fallback fields are not part of the structured contract.',
        },
      ],
    }),
    null
  );
});

test("agent proposal rows preserve the agent's call as a proposed decision", () => {
  const rows = buildAgentProposalDecisionRows(
    [
      {
        pair_id: 'pair-1',
        proposed_decision: 'not_match',
        proposed_confidence: 0.71,
        assessment: 'Name is close, but phone and store disagree.',
      },
      {
        pair_id: 'pair-2',
        proposed_decision: 'merge',
        proposed_confidence: 0.78,
        assessment: 'Same email, name typo only.',
      },
      {
        pair_id: 'pair-3',
        proposed_decision: 'defer',
        proposed_confidence: 0.32,
        assessment: 'Insufficient overlapping fields to evaluate.',
      },
    ],
    'batch-1'
  );

  assert.deepEqual(rows, [
    {
      pair_id: 'pair-1',
      decision: 'not_match',
      status: 'proposed',
      reviewer: 'claude-code-demo',
      reason: 'Name is close, but phone and store disagree.',
      proposed_decision: 'not_match',
      proposed_confidence: 0.71,
      decision_source: 'claude_code_demo',
      decision_batch_id: 'batch-1',
    },
    {
      pair_id: 'pair-2',
      decision: 'merge',
      status: 'proposed',
      reviewer: 'claude-code-demo',
      reason: 'Same email, name typo only.',
      proposed_decision: 'merge',
      proposed_confidence: 0.78,
      decision_source: 'claude_code_demo',
      decision_batch_id: 'batch-1',
    },
    {
      pair_id: 'pair-3',
      decision: 'defer',
      status: 'deferred',
      reviewer: 'claude-code-demo',
      reason: 'Insufficient overlapping fields to evaluate.',
      proposed_decision: 'defer',
      proposed_confidence: 0.32,
      decision_source: 'claude_code_demo',
      decision_batch_id: 'batch-1',
    },
  ]);
});

test('queue-row proposal parsing exposes Claude evidence for the inspector', () => {
  const proposal = readAgentProposalFromQueueRow({
    pair_id: 'pair-1',
    decision: 'defer',
    decision_reason: 'Same phone, different email spelling.',
    proposed_decision: 'merge',
    proposed_confidence: '0.77',
    decision_source: 'claude_code_demo',
    decision_batch_id: 'batch-1',
  });

  assert.deepEqual(proposal, {
    pair_id: 'pair-1',
    proposed_decision: 'merge',
    proposed_confidence: 0.77,
    assessment: 'Same phone, different email spelling.',
    decision_source: 'claude_code_demo',
    decision_batch_id: 'batch-1',
  });
});

test('queue-row proposal parsing rejects impossible confidence values', () => {
  assert.equal(
    readAgentProposalFromQueueRow({
      pair_id: 'pair-1',
      decision: 'defer',
      decision_reason: 'Confidence is out of bounds.',
      proposed_decision: 'merge',
      proposed_confidence: '1.5',
      decision_source: 'claude_code_demo',
      decision_batch_id: 'batch-1',
    }),
    null
  );
});

test('sample result reports per-decision proposal breakdown', () => {
  const result = buildAgentReviewSampleResult({
    entity: 'customer',
    limit: AGENT_SAMPLE_LIMIT,
    candidateCount: 10,
    decisionBatchId: 'batch-1',
    assessments: [
      ...Array.from({ length: 6 }, (_, index) => ({
        pair_id: `merge-${index}`,
        proposed_decision: 'merge' as const,
        proposed_confidence: 0.8,
        assessment: 'Strong shared identity evidence.',
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        pair_id: `not-match-${index}`,
        proposed_decision: 'not_match' as const,
        proposed_confidence: 0.82,
        assessment: 'Different cities and conflicting phones.',
      })),
      {
        pair_id: 'defer-0',
        proposed_decision: 'defer' as const,
        proposed_confidence: 0.3,
        assessment: 'Insufficient overlapping fields.',
      },
    ],
  });

  assert.equal(result.executed, true);
  assert.equal(result.status, 'proposals_saved');
  assert.equal(result.summary.selection?.limit, AGENT_SAMPLE_LIMIT);
  assert.equal(result.summary.candidate_count, 10);
  assert.equal(result.summary.decision_count, 10);
  assert.equal(result.summary.applied_count, undefined);
  assert.equal(result.summary.merge_count, 6);
  assert.equal(result.summary.not_match_count, 3);
  assert.equal(result.summary.deferred_count, 1);
});

test('agent review prompt passes raw Entity Graph record values through with state signal', () => {
  const candidates: AgentReviewCandidate[] = [
    {
      pair_id: 'pair-1',
      record_a_id: 'customer-a',
      record_b_id: 'customer-b',
      source_a: 'crm',
      source_b: 'pos',
      composite_score: 0.82,
      threshold_band: 'review',
      recommended_action: 'review',
      compare_fields: [
        { key: 'full_name', label: 'Full name', a: 'Acme Inc.', b: 'ACME, Inc.' },
        { key: 'email', label: 'Email', a: 'alice@example.com', b: 'alice@example.com' },
        { key: 'phone', label: 'Phone', a: '+1 (555) 010-0199', b: null },
      ],
      feature_contributions: [
        { key: 'email', label: 'Email', score: 1, a: 'alice@example.com', b: 'alice@example.com' },
      ],
    },
  ];

  const prompt = buildAgentReviewPromptCandidates(candidates);
  const serialized = JSON.stringify(prompt);

  assert.equal(serialized.includes('Acme Inc.'), true);
  assert.equal(serialized.includes('ACME, Inc.'), true);
  assert.equal(serialized.includes('alice@example.com'), true);
  assert.equal(serialized.includes('+1 (555) 010-0199'), true);
  assert.deepEqual(prompt[0]?.compare_fields, [
    {
      key: 'full_name',
      label: 'Full name',
      a: 'Acme Inc.',
      b: 'ACME, Inc.',
      state: 'different',
    },
    {
      key: 'email',
      label: 'Email',
      a: 'alice@example.com',
      b: 'alice@example.com',
      state: 'exact_match',
    },
    {
      key: 'phone',
      label: 'Phone',
      a: '+1 (555) 010-0199',
      b: null,
      state: 'record_b_missing',
    },
  ]);
  assert.deepEqual(prompt[0]?.feature_contributions, [
    {
      key: 'email',
      label: 'Email',
      score: 1,
      a: 'alice@example.com',
      b: 'alice@example.com',
    },
  ]);
});

test('no-candidate sample result is a no-op', () => {
  const result = buildAgentReviewSampleResult({
    entity: 'customer',
    limit: AGENT_SAMPLE_LIMIT,
    candidateCount: 0,
    assessments: [],
  });

  assert.equal(result.executed, false);
  assert.equal(result.status, 'no_candidates');
  assert.equal(result.recommended_next_action, 'noop');
});

test('Claude unavailable and timeout errors map to actionable route statuses', () => {
  assert.equal(getClaudeFailureHttpStatus('unavailable'), 503);
  assert.equal(getClaudeFailureHttpStatus('auth'), 503);
  assert.equal(getClaudeFailureHttpStatus('timeout'), 504);
  assert.equal(getClaudeFailureHttpStatus('runtime'), 500);
});

test('deferred proposal rows remain open while applied human decisions are decided', () => {
  assert.match(buildEntityGraphQueueStatusClause('open'), /defer/);
  assert.match(buildEntityGraphQueueStatusClause('decided'), /not_match/);
  assert.throws(() => buildEntityGraphQueueStatusClause('open', 'ld;drop'), /Invalid SQL alias/);
});
