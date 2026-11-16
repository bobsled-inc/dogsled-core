import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { AlwaysOkBudgetLedger, mockStructuredOk } from '@bobsled-inc/bobsled-core/ai/test-stubs';
import {
  AgentAssignmentSchema,
  parseAgentAssignmentOutcome,
} from '@bobsled-inc/bobsled-core/model-spec/agentic';
const ledger = new AlwaysOkBudgetLedger();
export async function executeAgent(request) {
  request.signal.throwIfAborted();
  const assignment = AgentAssignmentSchema.parse(request.assignment);
  const pair = assignment.input.rows[0];
  appendFileSync('calls.jsonl', JSON.stringify({ pair: pair.pair_id, event: 'attempt' }) + '\n');
  if (process.env.SHOWCASE_CRASH === '1' && pair.pair_id === 'pair-011' && !existsSync('crashed')) {
    writeFileSync('crashed', 'yes');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  const reservation = await request.budget.reserve(100);
  const result = mockStructuredOk({
    rows: [
      {
        pair_id: pair.pair_id,
        assessment: 'insufficient_evidence',
        _dogsled_evidence: [
          {
            source: assignment.input.ref,
            reference: pair.pair_id,
            retrieved_at: assignment.input.retrieved_at,
            support_excerpt: pair.evidence,
          },
        ],
        _dogsled_confidence: 0.9,
        _dogsled_reason: null,
      },
    ],
  });
  const cost = await ledger.tryReserveCost('showcase', '2025-01-01', result.costUsd, 1);
  assert.equal(cost.ok, true);
  const usage = { status: 'measured', input_tokens: 60, output_tokens: 40, total_tokens: 100 };
  await request.budget.settle(reservation, usage);
  const outcome = parseAgentAssignmentOutcome(assignment, {
    contract_version: 2,
    attempt_id: assignment.attempt_id,
    status: 'succeeded',
    rows: result.value.rows,
    usage,
  });
  appendFileSync(
    'calls.jsonl',
    JSON.stringify({
      pair: pair.pair_id,
      event: 'accepted',
      tokens: result.tokenUsage,
      cost: result.costUsd,
    }) + '\n'
  );
  return outcome;
}
