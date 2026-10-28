import {
  AgentAssignmentSchema,
  AgenticProfileSchema,
  resolveAgenticModel,
} from '@bobsled-inc/model-spec/agentic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgenticHost } from '../../../src/runtime/agentic-host.js';
import { createJevExecutor } from '../../../src/runtime/jev-executor.js';
import type { AgenticHostOptions } from '../../../src/runtime/agentic-host.js';
import type { AgenticProbeContext } from '@bobsled-inc/model-spec/agentic';

const mocks = vi.hoisted(() => ({ resolveRunner: vi.fn() }));
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: mocks.resolveRunner,
}));
vi.mock('@bobsled-inc/model-spec/project', () => ({
  selectIntegrationContexts: () => [
    {
      integration: { handle: 'local', integration: { auth: { password_env: 'HOST_PASSWORD' } } },
      dialect: 'duckdb',
      registry: new Map(),
      modelReg: new Map([['prepared', '"main"."prepared"']]),
    },
  ],
}));

describe('agentic host resolver declarations', () => {
  it('authorizes host model profiles without mutating authored declarations or resolving values', () => {
    const connection = {
      provider: 'openai',
      model: 'fake',
      api_key: '$HOST_MODEL_KEY',
      auth_env_vars: ['YAML_MODEL_KEY'],
    };
    const resolve = vi.fn(async () => 'host-canary');
    const options = {
      project: { sourceEntries: new Map(), models: [] },
      executeAgent: vi.fn(),
      secretResolver: { resolve },
      platform: { models: { review: connection } },
    } as unknown as AgenticHostOptions;
    const undeclared = createAgenticHost(options);
    expect(() =>
      AgenticProfileSchema.parse({ name: 'review', connection: undeclared.platform.models!.review })
    ).toThrow('Undeclared API key environment variable: HOST_MODEL_KEY');
    const host = createAgenticHost({ ...options, declaredSecretNames: ['HOST_MODEL_KEY'] });
    const profile = AgenticProfileSchema.parse({
      name: 'review',
      connection: host.platform.models!.review,
    });
    expect(profile.connection.auth_env_vars).toEqual(['YAML_MODEL_KEY', 'HOST_MODEL_KEY']);
    expect(connection.auth_env_vars).toEqual(['YAML_MODEL_KEY']);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects undeclared resolver reads and authorizes only host-listed names', async () => {
    const resolve = vi.fn(async () => 'host-canary');
    mocks.resolveRunner.mockResolvedValue({
      query: vi.fn(async () => [{ id: 'one' }]),
      close: vi.fn(),
    });
    const options = {
      project: { sourceEntries: new Map(), models: [] },
      executeAgent: vi.fn(),
      secretResolver: { resolve },
      platform: {},
    } as unknown as AgenticHostOptions;
    const context = {
      resolved: { steps: [{ input_columns: [{ name: 'id', type: 'string', nullable: false }] }] },
      integration: 'local',
      inputRef: 'prepared',
      signal: new AbortController().signal,
      maxRows: 2,
      maxBytes: 100,
    } as AgenticProbeContext;
    await expect(createAgenticHost(options).prepare(context)).rejects.toThrow(
      'Undeclared environment variable: HOST_PASSWORD'
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
    const host = createAgenticHost({ ...options, declaredSecretNames: ['HOST_PASSWORD'] });
    expect(await host.prepare(context)).toEqual([{ id: 'one' }]);
    expect(resolve).toHaveBeenCalledWith('HOST_PASSWORD');
    expect(mocks.resolveRunner).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { password: 'host-canary' } }),
      expect.any(Object)
    );
  });
});

describe('host-managed model auth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const connection = { provider: 'typesafe', model: 'jev-latest', api_key: '$LLM_API_KEY' };
  const options = {
    project: { sourceEntries: new Map(), models: [] },
    executeAgent: vi.fn(),
    secretResolver: { resolve: vi.fn() },
    platform: { models: { review: connection } },
  } as unknown as AgenticHostOptions;
  const definition = {
    spec_version: '0.2',
    type: 'model',
    model_kind: 'agentic',
    name: 'pair_matches',
    description: 'Classify prepared pairs.',
    grain: ['pair_id'],
    sources: { pairs: { ref: 'undecided_pairs' } },
    llm: { profile: 'review' },
    limits: { tokens: 100000, timeout_seconds: 600 },
    plan: {
      steps: [
        {
          id: 'match',
          source: { ref: 'pairs' },
          map: { over: 'pairs', group_by: ['pair_id'] },
          execution: { mode: 'llm_call' },
          instructions: 'Same place?',
          classification: { choices: { same: 'Same place', different: 'Different places' } },
          columns: [
            { name: 'pair_id', type: 'string', nullable: false },
            { name: 'choice', type: 'string', nullable: false },
            { name: 'confidence', type: 'number', nullable: false },
          ],
        },
      ],
    },
    output: { from: 'match' },
    materialization: { type: 'table', strategy: 'replace_processed_keys', keys: ['pair_id'] },
  };
  const inputs = { undecided_pairs: [{ name: 'pair_id', type: 'string', nullable: false }] };

  function jevRequest(host: ReturnType<typeof createAgenticHost>) {
    const resolved = resolveAgenticModel(definition, { ...host, inputs });
    const step = resolved.steps[0]!;
    const assignment = AgentAssignmentSchema.parse({
      contract_version: 2,
      model_name: 'pair_matches',
      run_id: 'r',
      step_id: 'match',
      shard_id: 'one',
      attempt_id: 'a',
      definition_ref: 'd',
      input_snapshot_ref: 'i',
      mode: 'llm_call',
      instructions: 'Same place?',
      skills: [],
      classification: step.step.classification,
      profile: step.profile,
      input: { ref: 'pairs', columns: step.input_columns, rows: [{ pair_id: 'one' }] },
      group_key: { pair_id: 'one' },
      processed_keys: [{ pair_id: 'one' }],
      output: {
        columns: step.step.columns,
        grain: ['pair_id'],
        replacement_keys: ['pair_id'],
      },
      limits: {
        tokens: 10000,
        started_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 60000).toISOString(),
      },
      allowed_sources: [],
    });
    return {
      profile: step.profile,
      request: {
        assignment: { ...assignment, mode: 'llm_call' as const },
        signal: new AbortController().signal,
        budget: {
          reserve: vi.fn(async (tokens: number | null) => ({ id: 'b', attempt_id: 'a', tokens })),
          settle: vi.fn(async () => {}),
        },
      },
    };
  }

  it('marks only an opted-in host and leaves its profiles unchanged', () => {
    for (const hostManagedModelAuth of [undefined, false]) {
      const host = createAgenticHost({ ...options, hostManagedModelAuth });
      expect(host).not.toHaveProperty('hostManagedModelAuth');
      expect(() => resolveAgenticModel(definition, { ...host, inputs })).toThrow(
        'Undeclared API key environment variable: LLM_API_KEY'
      );
    }
    const host = createAgenticHost({ ...options, hostManagedModelAuth: true });
    expect(host.hostManagedModelAuth).toBe(true);
    expect(host.platform.models!.review).toEqual(connection);
    expect(connection).not.toHaveProperty('auth_env_vars');
  });

  it('keeps the built-in executor on the explicit resolver and fails closed on a missing key', async () => {
    vi.stubEnv('LLM_API_KEY', 'ambient-canary');
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolve = vi.fn(async (name: string): Promise<string> => {
      throw new Error(`Secret ${name} is not available`);
    });
    const host = createAgenticHost({
      ...options,
      executeAgent: createJevExecutor({ fetch, secretResolver: { resolve } }),
      hostManagedModelAuth: true,
    });
    const { profile, request } = jevRequest(host);
    expect(profile.connection).toEqual({ ...connection, auth_env_vars: ['LLM_API_KEY'] });
    await expect(host.executeAgent(request)).rejects.toThrow(
      'Jev credential is unavailable or invalid'
    );
    expect(resolve).toHaveBeenCalledWith('LLM_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
    expect(request.budget.reserve).not.toHaveBeenCalled();
  });
});
