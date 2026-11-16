import { z } from 'zod';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor } from './executor.mjs';

function request() {
  const settled = [];
  let reservations = 0;
  const columns = [{ name: 'pair_id', type: 'string', nullable: false }];
  const controller = new AbortController();
  return {
    controller,
    settled,
    get reservations() {
      return reservations;
    },
    signal: controller.signal,
    assignment: {
      contract_version: 2,
      model_name: 'pairs',
      run_id: 'run',
      step_id: 'assess',
      shard_id: 'shard',
      attempt_id: 'attempt',
      definition_ref: 'def',
      input_snapshot_ref: 'snapshot',
      mode: 'llm_call',
      instructions: 'Assess this pair.',
      skills: [],
      profile: {
        name: 'review',
        connection: { provider: 'openai', model: 'gpt-4.1-mini', api_key: '$OPENAI_API_KEY' },
      },
      input: { ref: 'prepared', columns, rows: [{ pair_id: 'a' }] },
      group_key: { pair_id: 'a' },
      processed_keys: [{ pair_id: 'a' }],
      output: { columns, grain: ['pair_id'], replacement_keys: ['pair_id'] },
      limits: {
        tokens: 16000,
        started_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 60000).toISOString(),
      },
      allowed_sources: [],
    },
    budget: {
      async reserve(tokens) {
        reservations++;
        return { id: 'attempt', attempt_id: 'attempt', tokens };
      },
      async settle(receipt, usage) {
        settled.push({ receipt, usage });
      },
    },
  };
}
const row = {
  pair_id: 'a',
  _bobsled_evidence: null,
  _bobsled_confidence: null,
  _bobsled_reason: null,
};
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

test('one bounded call returns validated rows and settles measured usage', async () => {
  const req = request();
  let calls = 0;
  const execute = createExecutor(async (connection, options, controls) => {
    calls++;
    assert.equal(connection.model, 'gpt-4.1-mini');
    assert.equal(options.maxRetries, 0);
    // The SDK converts the input side of Zod schemas for the provider.
    const wire = z.toJSONSchema(options.schema, { io: 'input' });
    assert.equal(wire.properties.rows.items.type, 'object');
    assert.equal(wire.properties.rows.items.additionalProperties, false);
    assert.equal(wire.properties.rows.items.properties.pair_id.type, 'string');
    assert.ok(options.maxOutputTokens > 0 && options.maxOutputTokens <= 2048);
    assert.equal(options.abortSignal.aborted, false);
    assert.equal(controls.costBudgetMode, 'observe');
    assert.ok(!options.prompt.includes('OPENAI_API_KEY'));
    assert.equal('tools' in options, false);
    return { ok: true, value: { rows: [row] }, usage };
  });
  const result = await execute(req);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.usage.total_tokens, 150);
  assert.equal(calls, 1);
  assert.equal(req.reservations, 1);
  assert.deepEqual(req.settled[0].usage, result.usage);
});

test('missing provider usage stays unknown, even if legacy tokenUsage is zero', async () => {
  const req = request();
  const result = await createExecutor(async () => ({
    ok: true,
    value: { rows: [] },
    tokenUsage: 0,
  }))(req);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.usage, { status: 'unknown', reason: 'unavailable' });
});

test('foreign output keys fail validation after measured usage is settled', async () => {
  const req = request();
  const result = await createExecutor(async () => ({
    ok: true,
    value: { rows: [{ ...row, pair_id: 'other' }] },
    usage,
  }))(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_output');
  assert.equal(req.settled[0].usage.total_tokens, 150);
});

test('schema failures retain usage and do not leak raw provider text', async () => {
  const result = await createExecutor(async () => ({
    ok: false,
    error: 'schema_violation',
    raw: 'PRIVATE',
    message: 'PRIVATE',
    usage,
  }))(request());
  assert.equal(result.status, 'failed');
  assert.equal(result.usage.total_tokens, 150);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('cancellation before a call does not reserve tokens or invoke the provider', async () => {
  const req = request();
  req.controller.abort();
  await assert.rejects(
    createExecutor(async () => {
      assert.fail('must not call');
    })(req)
  );
  assert.equal(req.reservations, 0);
});

test('cancellation during a call settles unknown interrupted usage', async () => {
  const req = request();
  const result = await createExecutor(async () => {
    req.controller.abort();
    throw new Error('PRIVATE');
  })(req);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.usage, { status: 'unknown', reason: 'interrupted' });
  assert.equal(req.settled.length, 1);
});

test('too little input allowance fails before a call', async () => {
  const req = request();
  req.assignment.limits.tokens = 1;
  await assert.rejects(
    createExecutor(async () => {
      assert.fail('must not call');
    })(req),
    /token allowance/
  );
  assert.equal(req.reservations, 0);
});

test('loop mode and source capabilities are not accepted', async () => {
  const req = request();
  req.assignment.mode = 'agent_loop';
  await assert.rejects(
    createExecutor(async () => {
      assert.fail('must not call');
    })(req),
    /direct call/
  );
});

test('the provider cannot author an evidence retrieval date', async () => {
  const req = request();
  req.assignment.input.retrieved_at = '2026-09-13T11:00:00.000Z';
  const evidence = { source: 'prepared', reference: 'a', support_excerpt: 'Prepared evidence.' };
  const result = await createExecutor(async (_connection, options) => {
    const wire = z.toJSONSchema(options.schema, { io: 'input' });
    const json = JSON.stringify(wire);
    assert.ok(!json.includes('retrieved_at'));
    return { ok: true, value: { rows: [{ ...row, _bobsled_evidence: [evidence] }] }, usage };
  })(req);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.rows[0]._bobsled_evidence[0].retrieved_at, req.assignment.input.retrieved_at);
});

test('an invented provider date is rejected rather than saved', async () => {
  const req = request();
  req.assignment.input.retrieved_at = '2026-09-13T11:00:00.000Z';
  const result = await createExecutor(async () => ({
    ok: true,
    value: {
      rows: [
        {
          ...row,
          _bobsled_evidence: [
            {
              source: 'prepared',
              reference: 'a',
              support_excerpt: null,
              retrieved_at: '2024-06-01T00:00:00Z',
            },
          ],
        },
      ],
    },
    usage,
  }))(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_output');
});

test('evidence without a saved host date fails rather than inventing a date', async () => {
  const result = await createExecutor(async () => ({
    ok: true,
    value: {
      rows: [
        {
          ...row,
          _bobsled_evidence: [{ source: 'prepared', reference: 'a', support_excerpt: null }],
        },
      ],
    },
    usage,
  }))(request());
  assert.equal(result.status, 'failed');
});

test('named reduce inputs stay separate and evidence uses the matching host date', async () => {
  const req = request();
  const timestamp = '2026-09-14T10:00:00Z';
  req.assignment.inputs = {
    first: { ...req.assignment.input, complete: true, processed_keys: [{ pair_id: 'a' }] },
    second: {
      ...req.assignment.input,
      ref: 'second',
      retrieved_at: timestamp,
      complete: true,
      processed_keys: [{ pair_id: 'a' }],
    },
    empty: {
      ...req.assignment.input,
      ref: 'empty',
      rows: [],
      complete: true,
      processed_keys: [{ pair_id: 'a' }],
    },
  };
  const execute = createExecutor(async (_connection, options) => {
    const prompt = JSON.parse(options.prompt);
    assert.deepEqual(prompt.inputs.empty.rows, []);
    assert.equal(prompt.inputs.empty.complete, true);
    const answer = {
      ...row,
      _bobsled_evidence: [{ source: 'second', reference: 'a', support_excerpt: null }],
    };
    return { ok: true, value: { rows: [answer] }, usage };
  });
  const result = await execute(req);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.rows[0]._bobsled_evidence[0].retrieved_at, timestamp);
});

test('a rejected key is an auth failure that is not billed or retried', async () => {
  const result = await createExecutor(async () => ({
    ok: false,
    error: 'provider_error',
    message: 'invalid x-api-key',
    attempts: 1,
    status: 403,
  }))(request());
  assert.deepEqual(result.error, { kind: 'auth', code: 'auth_failed', retryable: false });
  assert.equal(result.usage.total_tokens, 0);
});

test('a rate limit is a retryable provider failure', async () => {
  const result = await createExecutor(async () => ({
    ok: false,
    error: 'provider_error',
    message: 'slow down',
    attempts: 1,
    status: 429,
  }))(request());
  assert.deepEqual(result.error, { kind: 'provider', code: 'rate_limited', retryable: true });
});
