import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from '@bobsled-inc/protocol';
import { AgentAssignmentSchema } from '@bobsled-inc/model-spec/agentic';
import { createJevExecutor } from '../../../src/runtime/jev-executor.js';
import { createCliAgenticHost } from '../../../src/runtime/cli-agentic-host.js';

vi.mock('@bobsled-inc/model-spec/project', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/model-spec/project')>()),
  loadProject: vi.fn().mockResolvedValue({ sourceEntries: new Map(), models: [] }),
  selectIntegrationContexts: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../src/runner/config/loader.js', () => ({
  findBobsledConfig: vi.fn().mockReturnValue(null),
  findBobsledProject: vi.fn().mockReturnValue(null),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture() {
  const assignment = AgentAssignmentSchema.parse({
    contract_version: 2,
    model_name: 'pairs',
    run_id: 'r',
    step_id: 's',
    shard_id: 'one',
    attempt_id: 'a',
    definition_ref: 'd',
    input_snapshot_ref: 'i',
    mode: 'llm_call',
    instructions: 'Same place?',
    skills: [],
    classification: { choices: { same: 'Same place', different: 'Different place' } },
    profile: {
      name: 'review',
      connection: {
        provider: 'typesafe',
        model: 'jev-latest',
        api_key: '$KEY',
        auth_env_vars: ['KEY'],
      },
    },
    input: {
      ref: 'pairs',
      columns: [{ name: 'id', type: 'string', nullable: false }],
      rows: [{ id: 'one' }],
    },
    group_key: { id: 'one' },
    processed_keys: [{ id: 'one' }],
    output: {
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'choice', type: 'string', nullable: false },
        { name: 'confidence', type: 'number', nullable: false },
      ],
      grain: ['id'],
      replacement_keys: ['id'],
    },
    limits: {
      tokens: 10000,
      started_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    },
    allowed_sources: [],
  });
  const reply = {
    answers: {
      classification: {
        type: 'choice',
        choice: 'same',
        confidence: 0.8,
        probabilities: { same: 0.9, different: 0.1 },
      },
    },
    usage: { input_tokens: 20, output_tokens: 10 },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(reply));
  const request = {
    assignment: { ...assignment, mode: 'llm_call' as const },
    signal: new AbortController().signal,
    budget: {
      reserve: vi.fn(async (tokens: number | null) => ({ id: 'b', attempt_id: 'a', tokens })),
      settle: vi.fn(async () => {}),
    },
  };
  const execute = createJevExecutor({ fetch, secretResolver: { resolve: async () => 'test-key' } });
  return { reply, fetch, request, execute };
}
describe('Jev executor', () => {
  it('maps the request and preserves keys with measured usage', async () => {
    const f = fixture();
    const result = await f.execute(f.request);
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.rows[0]).toMatchObject({
        id: 'one',
        choice: 'same',
        confidence: 0.8,
        _dogsled_reason: null,
      });
    }
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      state: '{"id":"one"}',
      questions: { classification: { type: 'choice' } },
    });
    expect(result.usage).toMatchObject({ status: 'measured', total_tokens: 30 });
    expect(f.request.budget.settle).toHaveBeenCalledTimes(1);
  });
  it.each([401, 429, 503])('handles HTTP %s without leaking the response', async (status) => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response('secret-error', { status }));
    const result = await f.execute(f.request);
    expect(result).toMatchObject({ status: 'failed', error: { retryable: status !== 401 } });
    expect(JSON.stringify(result)).not.toContain('secret-error');
    expect(f.request.budget.settle).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown choices and keeps usage', async () => {
    const f = fixture();
    f.reply.answers.classification.choice = 'invented';
    expect(await f.execute(f.request)).toMatchObject({
      status: 'failed',
      usage: { status: 'measured', total_tokens: 30 },
    });
  });
  it('rejects invalid probabilities', async () => {
    const f = fixture();
    f.reply.answers.classification.probabilities.same = 0.2;
    expect(await f.execute(f.request)).toMatchObject({
      status: 'failed',
      error: { code: 'jev_invalid_output' },
    });
  });
  it('charges unknown usage rather than zero', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(Response.json({ answers: f.reply.answers }));
    expect(await f.execute(f.request)).toMatchObject({
      status: 'succeeded',
      usage: { status: 'unknown' },
    });
  });
  it('does not call after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    f.request.signal = controller.signal;
    await expect(f.execute(f.request)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects header injection before dispatch', async () => {
    const f = fixture();
    const execute = createJevExecutor({
      fetch: f.fetch,
      secretResolver: { resolve: async () => 'key\r\nsecret' },
    });
    await expect(execute(f.request)).rejects.toThrow('credential');
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

it('rejects an oversized response and settles unknown usage once', async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
  expect(await f.execute(f.request)).toMatchObject({
    status: 'failed',
    usage: { status: 'unknown' },
  });
  expect(f.request.budget.settle).toHaveBeenCalledTimes(1);
});
it('handles cancellation during a provider call', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.request.signal = controller.signal;
  f.fetch.mockImplementation(async () => {
    controller.abort();
    throw new Error('secret');
  });
  expect(await f.execute(f.request)).toMatchObject({
    status: 'failed',
    error: { code: 'jev_cancelled' },
  });
  expect(f.request.budget.settle).toHaveBeenCalledTimes(1);
});
it('rejects requests above the allowance before fetching', async () => {
  const f = fixture();
  f.request.assignment.limits.tokens = 1;
  await expect(f.execute(f.request)).rejects.toThrow('allowance');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.request.budget.reserve).not.toHaveBeenCalled();
});

it.each([-0.1, 1.1])('rejects confidence outside the range: %s', async (confidence) => {
  const f = fixture();
  f.reply.answers.classification.confidence = confidence;
  expect(await f.execute(f.request)).toMatchObject({
    status: 'failed',
    error: { kind: 'validation' },
  });
});
it('does not leak malformed provider output', async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(new Response('not-json-secret'));
  const result = await f.execute(f.request);
  expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('not-json-secret');
  expect(f.request.budget.settle).toHaveBeenCalledTimes(1);
});

it('classifies without token or execution deadline limits and still reports usage', async () => {
  const f = fixture();
  f.request.assignment.limits.tokens = null;
  f.request.assignment.limits.deadline_at = null;
  const result = await f.execute(f.request);
  expect(result.status).toBe('succeeded');
  expect(result.usage).toMatchObject({ status: 'measured', total_tokens: 30 });
  expect(f.request.budget.reserve).toHaveBeenCalledWith(null);
});

describe('Jev secret resolution', () => {
  const MISSING = 'createJevExecutor requires an explicit secretResolver';

  it.each([
    ['no options', () => (createJevExecutor as (options?: unknown) => unknown)()],
    ['an empty options object', () => createJevExecutor({} as never)],
    ['an undefined resolver', () => createJevExecutor({ secretResolver: undefined } as never)],
    ['a resolver without resolve', () => createJevExecutor({ secretResolver: {} } as never)],
  ])('throws for %s without reading the environment', async (_label, create) => {
    vi.stubEnv('KEY', 'ambient-env-key');
    const f = fixture();
    const read = vi.spyOn(process, 'env', 'get');
    expect(create).toThrow(CommandError);
    expect(create).toThrow(MISSING);
    expect(read).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('never falls back to the environment when only transport is injected', async () => {
    vi.stubEnv('KEY', 'ambient-env-key');
    const f = fixture();
    expect(() => createJevExecutor({ fetch: f.fetch } as never)).toThrow(MISSING);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('reads the key only through the explicit resolver', async () => {
    vi.stubEnv('KEY', 'ambient-env-key');
    const f = fixture();
    const resolve = vi.fn(async () => 'resolver-key');
    const result = await createJevExecutor({ fetch: f.fetch, secretResolver: { resolve } })(
      f.request
    );
    expect(result.status).toBe('succeeded');
    expect(resolve).toHaveBeenCalledWith('KEY');
    const headers = f.fetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer resolver-key');
  });

  it.each([
    [
      'rejects',
      async () => Promise.reject(new CommandError('Environment variable "KEY" is not set', 2)),
    ],
    ['returns an empty value', async () => ''],
  ])('fails closed when the explicit resolver %s', async (_label, resolve) => {
    vi.stubEnv('KEY', 'ambient-env-key');
    const f = fixture();
    const execute = createJevExecutor({ fetch: f.fetch, secretResolver: { resolve } });
    await expect(execute(f.request)).rejects.toThrow('Jev credential is unavailable or invalid');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.request.budget.reserve).not.toHaveBeenCalled();
  });

  it('keeps the CLI typesafe executor on its documented environment resolver', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dogsled-jev-cli-'));
    try {
      vi.stubEnv('KEY', 'cli-env-key');
      const f = fixture();
      vi.stubGlobal('fetch', f.fetch);
      const host = await createCliAgenticHost({
        cwd: directory,
        executorPath: 'typesafe',
        tokensPerAssignment: 8000,
      });
      const result = await host.executeAgent(f.request);
      expect(result.status).toBe('succeeded');
      const headers = f.fetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer cli-env-key');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
