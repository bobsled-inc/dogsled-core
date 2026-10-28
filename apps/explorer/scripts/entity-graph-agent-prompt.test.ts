import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentReviewPromptCandidates,
  buildClaudeSystemPrompt,
  buildClaudeUserPrompt,
  type AgentReviewCandidate,
} from '../src/lib/entity-graph-agent-sample-server';

test('system prompt for location entity references entity type, floor, calibration, examples, and anti-patterns', () => {
  const prompt = buildClaudeSystemPrompt('location', 0.5);

  assert.equal(typeof prompt, 'string');

  // Entity type substitution
  assert.match(prompt, /location master data/);
  assert.match(prompt, /store\/location/);

  // Confidence floor substitution
  assert.match(prompt, /below\s+0\.5/);

  // Calibration covers all three tiers (defer / proposed / auto-apply).
  // The text is bulleted prose now (not a table) so we assert the spans
  // rather than fixed table cells. Action-tied verbs matter more than
  // format. Use \s+ everywhere there's whitespace so soft-wrapped lines
  // still match — the prompt wraps at ~75 chars.
  assert.match(prompt, /below\s+0\.5,?\s+return\s+`defer`/);
  assert.match(prompt, /auto-apply\s+bar/);
  assert.match(prompt, /keeps\s+it\s+in\s+the\s+agent\/eval\s+queue/);
  assert.match(prompt, /0\.85\+/);
  assert.match(prompt, /auto-apply\s+without\s+follow-up\s+review/);

  // At least three concrete Example Retail-shape examples
  assert.ok(
    prompt.includes('Example Retail Overland Park') &&
      prompt.includes('Example Retail Atlanta') &&
      prompt.includes('Example Retail Med Spa Park Square'),
    'expected three Example Retail example pairs to be present in the system prompt'
  );

  // Anti-patterns section
  assert.match(prompt, /Anti-patterns to avoid/);
  assert.match(prompt, /Back-solving/);

  // Output format mentions only the new decision union
  assert.match(prompt, /"merge"\s*\|\s*"not_match"\s*\|\s*"defer"/);
  assert.equal(prompt.includes('escalate'), false);
});

test('system prompt for customer entity substitutes entity-singular reference and floor', () => {
  const prompt = buildClaudeSystemPrompt('customer', 0.6);

  assert.match(prompt, /customer master data/);
  assert.match(prompt, /person\/customer/);
  assert.match(prompt, /below\s+0\.6/);
});

test('user prompt embeds raw candidate values, scenario, entity, and the confidence floor task', () => {
  const candidates: AgentReviewCandidate[] = [
    {
      pair_id: 'pair-1',
      record_a_id: 'rec-a',
      record_b_id: 'rec-b',
      source_a: 'crm',
      source_b: 'pos',
      composite_score: 0.82,
      threshold_band: 'review',
      recommended_action: 'review',
      compare_fields: [
        { key: 'full_name', label: 'Full name', a: 'Acme Inc.', b: 'ACME, Inc.' },
        {
          key: 'email',
          label: 'Email',
          a: 'ops@acme.com.example.com',
          b: 'ops@acme.com.example.com',
        },
      ],
      feature_contributions: [
        {
          key: 'email',
          label: 'Email',
          score: 1,
          a: 'ops@acme.com.example.com',
          b: 'ops@acme.com.example.com',
        },
      ],
    },
  ];

  const json = buildClaudeUserPrompt('default', 'location', candidates, 0.5);
  const parsed = JSON.parse(json) as {
    task: string;
    scenario: string;
    entity: string;
    pairs: Array<{
      pair_id: string;
      compare_fields: Array<{ a: string | null; b: string | null; state: string }>;
    }>;
  };

  assert.match(parsed.task, /below\s+0\.5/);
  assert.equal(parsed.scenario, 'default');
  assert.equal(parsed.entity, 'location');
  assert.equal(parsed.pairs.length, 1);
  assert.equal(parsed.pairs[0]?.pair_id, 'pair-1');
  assert.equal(parsed.pairs[0]?.compare_fields[0]?.a, 'Acme Inc.');
  assert.equal(parsed.pairs[0]?.compare_fields[0]?.b, 'ACME, Inc.');
  assert.equal(parsed.pairs[0]?.compare_fields[1]?.state, 'exact_match');
});
