import { analyzeModelDependencies } from '../../../src/compiler/model-dependency-analysis.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import {
  compileProject,
  loadProject,
  runProject,
  validateProject,
} from '../../../src/api/index.js';
import type { AgenticPublisher, ExperimentalAgenticProbe } from '../../../src/agentic/index.js';

import { MemoryStateStore } from '../agentic/state-fixture.js';
const warehouseFactory = vi.hoisted(() => vi.fn());
vi.mock('../../../src/agentic/warehouse-state.js', () => ({
  createWarehouseCheckpointStore: warehouseFactory,
}));
const factory = vi.hoisted(() => vi.fn());
vi.mock('../../../src/agentic/sql-publisher.js', () => ({ createSqlAgenticPublisher: factory }));
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  factory.mockReset();
  warehouseFactory.mockReset();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentic-dag-'));
  roots.push(root);
  for (const dir of ['integrations', 'sources', 'models']) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, 'integrations/lake.yml'),
    stringify({
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: '/tmp/probe-unused.duckdb' },
    })
  );
  writeFileSync(
    join(root, 'sources/pairs.yml'),
    stringify({
      spec_version: '0.2',
      name: 'pairs',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'lake',
      table: 'raw.pairs',
      schema: { columns: [{ name: 'pair_id', type: 'STRING' }] },
    })
  );
  const derived = (name: string, ref: string, columns: string[]) => ({
    spec_version: '0.2',
    type: 'model',
    name,
    description: 'Test model',
    grain: 'pair_id',
    source: { ref },
    columns: columns.map((name) => ({ name, expr: name, type: 'STRING' })),
    materialization: { type: 'table' },
  });
  writeFileSync(
    join(root, 'models/undecided_pairs.yml'),
    stringify(derived('undecided_pairs', 'lake.pairs', ['pair_id']))
  );
  writeFileSync(
    join(root, 'models/advice.yml'),
    stringify(derived('advice', 'pair_assessments', ['pair_id', 'assessment', '_dogsled_run_id']))
  );
  const model = parse(
    readFileSync(new URL('../../fixtures/agentic/prepared-pairs.yml', import.meta.url), 'utf8')
  );
  writeFileSync(join(root, 'models/agentic.yml'), stringify(model));
  const events: string[] = [];
  let staged: unknown[] = [];
  let published: readonly unknown[] = [];
  const downstream: unknown[] = [];
  const run = vi.fn(async (sql: string) => {
    if (sql.includes('"undecided_pairs"')) {
      events.push('derived');
      staged = [{ pair_id: 'p1' }];
    }
    if (sql.includes('"advice"')) {
      events.push('downstream');
      downstream.push(...structuredClone(published));
    }
    return { rowCount: 1 };
  });
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('duckdb', 'file', async () => ({ run }));
  const host: ExperimentalAgenticProbe = {
    supportedDialects: ['duckdb'],
    tokensPerAssignment: 100,
    inputs: { undecided_pairs: [{ name: 'pair_id', type: 'string', nullable: false }] },
    platform: {
      models: {
        review: {
          provider: 'openai',
          model: 'fake',
          api_key: '$FAKE_KEY',
          auth_env_vars: ['FAKE_KEY'],
        },
      },
    },
    prepare: vi.fn(async () => {
      events.push('prepare');
      return staged;
    }),
    executeAgent: vi.fn(async ({ assignment }) => {
      events.push('agent');
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage: { status: 'measured', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        rows: [
          {
            pair_id: 'p1',
            assessment: 'review',
            _dogsled_evidence: null,
            _dogsled_confidence: null,
            _dogsled_reason: null,
          },
        ],
      };
    }),
    publish: vi.fn(async (_context, rows) => {
      events.push('publish');
      published = rows;
    }),
  };
  return {
    root,
    model,
    host,
    events,
    run,
    downstream,
    options: { customRunners, experimentalAgenticProbe: host },
  };
}

describe('mixed agentic dispatch probe', () => {
  it('authorizes host model keys only with explicit resolver declarations', async () => {
    const f = fixture();
    const connection = {
      provider: 'openai',
      model: 'fake',
      api_key: '$HOST_MODEL_KEY',
      auth_env_vars: ['YAML_MODEL_KEY'],
    };
    f.host.platform = { models: { review: connection } };
    const secretResolver = { resolve: vi.fn(async () => 'host-canary') };
    await expect(runProject(f.root, { ...f.options, secretResolver })).rejects.toThrow(
      'Undeclared API key environment variable: HOST_MODEL_KEY'
    );
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    const result = await runProject(f.root, {
      ...f.options,
      secretResolver,
      declaredSecretNames: ['HOST_MODEL_KEY'],
    });
    expect(result.ok).toBe(true);
    expect(f.host.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        assignment: expect.objectContaining({
          profile: expect.objectContaining({
            connection: expect.objectContaining({
              api_key: '$HOST_MODEL_KEY',
              auth_env_vars: ['YAML_MODEL_KEY', 'HOST_MODEL_KEY'],
            }),
          }),
        }),
      })
    );
    expect(connection.auth_env_vars).toEqual(['YAML_MODEL_KEY']);
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });

  it('runs undeclared profile keys only for a host that manages model auth', async () => {
    const f = fixture();
    const connection = { provider: 'openai', model: 'fake', api_key: '$LLM_API_KEY' };
    f.host.platform = { models: { review: connection } };
    const secretResolver = { resolve: vi.fn(async () => 'host-canary') };
    await expect(runProject(f.root, { ...f.options, secretResolver })).rejects.toThrow(
      'Undeclared API key environment variable: LLM_API_KEY'
    );
    f.host.hostManagedModelAuth = false;
    await expect(runProject(f.root, { ...f.options, secretResolver })).rejects.toThrow(
      'Undeclared API key environment variable: LLM_API_KEY'
    );
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    f.host.hostManagedModelAuth = true;
    const result = await runProject(f.root, { ...f.options, secretResolver });
    expect(result.ok).toBe(true);
    expect(f.host.executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        assignment: expect.objectContaining({
          profile: {
            name: 'review',
            connection: { ...connection, auth_env_vars: ['LLM_API_KEY'] },
          },
        }),
      })
    );
    expect(connection).toEqual({ provider: 'openai', model: 'fake', api_key: '$LLM_API_KEY' });
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });

  it('does not silently reset incremental cursors on full refresh', async () => {
    const f = fixture();
    f.model.sources.pairs.incremental = { cursor_field: 'updated_at' };
    f.host.inputs = {
      undecided_pairs: [
        { name: 'pair_id', type: 'string', nullable: false },
        { name: 'updated_at', type: 'integer', nullable: false },
      ],
    };
    writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
    const result = await runProject(f.root, { ...f.options, fullRefresh: true });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('cannot be reset with fullRefresh');
    expect(f.host.prepare).not.toHaveBeenCalled();
  });
  it.each(['skills', 'sources'])(
    'validates %s on later steps before preparation',
    async (capability) => {
      const f = fixture();
      const later = structuredClone(f.model.plan.steps[0]);
      later.id = 'later';
      if (capability === 'skills') later.skills = ['review'];
      else later.execution.mode = 'agent_loop';
      f.model.plan.steps.push(later);
      f.model.output.from = 'later';
      writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
      await expect(runProject(f.root, f.options)).rejects.toThrow(
        capability === 'skills' ? 'authored skills' : 'scoped source host'
      );
      expect(f.host.prepare).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    }
  );
  it('creates and closes the default publisher for the selected integration', async () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'model-spec.yml'),
      stringify({ checkpoint_store: { integration: 'lake', schema: 'system_store' } })
    );
    warehouseFactory.mockReturnValue(new MemoryStateStore());
    const close = vi.fn(async () => {});
    const publisher: AgenticPublisher = {
      preflight: vi.fn(async () => {}),
      claim: async () => ({ version: 0, fence: 'owner' }),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => null,
      commit: async (intent) => ({ intent, committed_version: 1 }),
      close,
    };
    factory.mockResolvedValueOnce(publisher);
    const secretResolver = { resolve: vi.fn(async () => 'test-secret') };
    const tokenProvider = vi.fn(async () => ({ accessToken: 'token', expiresAt: 2000000000 }));
    const result = await runProject(f.root, {
      customRunners: f.options.customRunners,
      secretResolver,
      tokenProvider,
      warehouse: 'compute',
      queryTag: 'agentic-test',
      agentic: { host: f.host, run: { id: 'automatic', mode: 'start' } },
    });
    expect(result.ok).toBe(true);
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({ source_type: 'duckdb', name: 'lake' }),
      expect.objectContaining({
        secretResolver,
        tokenProvider,
        warehouse: 'compute',
        queryTag: 'agentic-test',
        systemSchema: 'system_store',
        customRunners: f.options.customRunners,
      })
    );
    expect(publisher.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ integration: 'lake', target: 'main.pair_assessments' }),
      expect.anything()
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not open the default publisher or resolve secrets in a dry run', async () => {
    const f = fixture();
    factory.mockClear();
    const secretResolver = {
      resolve: vi.fn(async () => {
        throw new Error('must not resolve');
      }),
    };
    const result = await runProject(f.root, {
      dryRun: true,
      secretResolver,
      agentic: { host: f.host },
    });
    expect(result.ok).toBe(true);
    expect(result.state.models['lake.pair_assessments']).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });

  it('closes the default publisher when preparation fails', async () => {
    const f = fixture();
    const close = vi.fn(async () => {});
    factory.mockResolvedValueOnce({
      preflight: async () => {
        throw new Error('preflight failure');
      },
      close,
    });
    const result = await runProject(f.root, {
      customRunners: f.options.customRunners,
      agentic: { host: f.host },
    });
    expect(result.ok).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(result.state.models['lake.pair_assessments']).toBeUndefined();
    expect(f.events).not.toContain('downstream');
  });

  it.each([false, true])(
    'reports confirmed publication with target overrides %s',
    async (overrides) => {
      const f = fixture();
      if (overrides) {
        f.model.target_schema = 'classified';
        f.model.target_database = 'catalog';
        writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
      }
      const publisher: AgenticPublisher = {
        preflight: vi.fn(async () => {}),
        claim: async () => ({ version: 0, fence: 'owner' }),
        prepare: async (_context, identity, _rows, _keys, claim) => ({
          identity,
          expected_version: claim.version,
          stage: `stage_${identity.operation_id}`,
        }),
        inspect: async () => null,
        commit: async (intent) => {
          f.events.push('confirmed');
          return { intent, committed_version: 1 };
        },
        close: vi.fn(async () => {}),
      };
      const stateStore = new MemoryStateStore();
      const result = await runProject(f.root, {
        customRunners: f.options.customRunners,
        state: { models: {} },
        agentic: { run: { id: 'real', mode: 'start' }, host: f.host, publisher, stateStore },
      });
      expect(result.ok).toBe(true);
      expect(result.state.models['lake.pair_assessments']).toMatchObject({
        lastRunAt: expect.any(String),
        materialization: 'table',
        specChecksum: expect.any(String),
        priorFqName: overrides
          ? '"catalog"."classified"."pair_assessments"'
          : 'main.pair_assessments',
        targetSchema: overrides ? 'classified' : 'main',
        ...(overrides ? { targetDatabase: 'catalog' } : {}),
      });
      expect(f.events.indexOf('confirmed')).toBeLessThan(f.events.indexOf('downstream'));
      expect(f.host.publish).not.toHaveBeenCalled();
      expect(publisher.preflight).toHaveBeenCalledTimes(1);
      expect(publisher.close).not.toHaveBeenCalled();
      const resumed = await runProject(f.root, {
        customRunners: f.options.customRunners,
        models: ['pair_assessments'],
        state: { models: {} },
        agentic: { run: { id: 'real', mode: 'resume' }, host: f.host, publisher, stateStore },
      });
      expect(resumed.ok).toBe(true);
      expect(resumed.state.models['lake.pair_assessments']).toMatchObject({
        ...result.state.models['lake.pair_assessments'],
        lastRunAt: expect.any(String),
      });
      expect(f.host.executeAgent).toHaveBeenCalledOnce();
    }
  );
  it('blocks downstream when the model deadline fires during a confirmed commit', async () => {
    const f = fixture();
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const publisher: AgenticPublisher = {
      preflight: async () => {},
      claim: async () => ({ version: 0, fence: 'owner' }),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => null,
      commit: async (intent) => {
        f.events.push('confirmed');
        deadline.abort();
        return { intent, committed_version: 1 };
      },
      close: async () => {},
    };
    try {
      const result = await runProject(f.root, {
        customRunners: f.options.customRunners,
        agentic: { run: { id: 'deadline-mixed', mode: 'start' }, host: f.host, publisher },
      });
      expect(result.cancelled).toBe(true);
      expect(result.ok).toBe(false);
      expect(f.events).toContain('confirmed');
      expect(f.events).not.toContain('downstream');
    } finally {
      timer.mockRestore();
    }
  });

  it.each([undefined, 300])(
    'resolves configured checkpoints with lease %s and host credentials',
    async (leaseSeconds) => {
      const f = fixture();
      writeFileSync(
        join(f.root, 'model-spec.yml'),
        stringify({
          checkpoint_store: {
            integration: 'lake',
            schema: 'checkpoints',
            lease_seconds: leaseSeconds,
          },
        })
      );
      const store = new MemoryStateStore();
      warehouseFactory.mockReturnValue(store);
      const secretResolver = { resolve: vi.fn(async () => 'test-secret') };
      const result = await runProject(f.root, {
        ...f.options,
        state: { models: {} },
        secretResolver,
      });
      expect(result.ok).toBe(true);
      expect(warehouseFactory).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'lake' }),
        expect.objectContaining({
          schema: 'checkpoints',
          ...(leaseSeconds === undefined ? {} : { leaseMs: leaseSeconds * 1000 }),
          secretResolver,
          customRunners: f.options.customRunners,
        })
      );
      expect(f.host.executeAgent).toHaveBeenCalled();
    }
  );

  it('rejects an unknown checkpoint integration during validation', async () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'model-spec.yml'),
      stringify({ checkpoint_store: { integration: 'missing', schema: 'checkpoints' } })
    );
    await expect(validateProject(f.root)).rejects.toMatchObject({
      kind: 'validation',
      cause: { message: 'checkpoint_store references an unknown integration' },
    });
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('never falls back to local checkpoints for an explicit checkpoint_store', async () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'model-spec.yml'),
      stringify({
        checkpoint_store: { integration: 'missing', schema: 'checkpoints' },
      })
    );
    await expect(runProject(f.root, f.options)).rejects.toThrow('checkpoint_store');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it('requires checkpoints when regular model state is supplied', async () => {
    const f = fixture();
    await expect(runProject(f.root, { ...f.options, state: { models: {} } })).rejects.toThrow(
      'checkpoint store'
    );
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('does not republish a completed run or start downstream models on resume', async () => {
    const f = fixture();
    const first = await runProject(f.root, {
      ...f.options,
      agentic: { run: { id: 'saved-run', mode: 'start' } },
    });
    expect(first.ok).toBe(true);
    f.events.length = 0;
    const resumed = await runProject(f.root, {
      ...f.options,
      agentic: { run: { id: 'saved-run', mode: 'resume' } },
    });
    expect(resumed.ok).toBe(false);
    expect(f.events).not.toContain('publish');
    expect(f.events).not.toContain('agent');
    expect(f.events).not.toContain('downstream');
    expect(resumed.byIntegration[0]?.error).toContain('publication is pending');
  });

  it('runs derived → fake agentic → derived with metadata, with local execution checkpoints', async () => {
    const f = fixture();
    const result = await runProject(f.root, f.options);
    expect(result.ok).toBe(true);
    expect(f.downstream).toEqual([
      expect.objectContaining({
        pair_id: 'p1',
        assessment: 'review',
        _dogsled_run_id: expect.any(String),
      }),
    ]);
    expect(f.events).toEqual(['derived', 'prepare', 'agent', 'publish', 'downstream']);
    // Keep the serialized context unchanged for existing single-map run identities.
    expect(f.host.prepare).toHaveBeenCalledWith(
      expect.not.objectContaining({ inputSqlByRef: expect.anything() })
    );
    expect(Object.keys(result.state.models)).toEqual(['lake.undecided_pairs', 'lake.advice']);
    expect(f.host.publish).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ _dogsled_run_id: expect.any(String) })],
      [{ pair_id: 'p1' }]
    );
    for (const call of f.run.mock.calls) expect(call).toHaveLength(1);
  });
  it('separates agentic plans from SQL and keeps selection closure', async () => {
    const f = fixture();
    const project = await loadProject(f.root);
    expect(project.models.map((node) => node.name)).toEqual([
      'undecided_pairs',
      'pair_assessments',
      'advice',
    ]);
    const compile = await compileProject(f.root, { models: ['+advice'] });
    expect(compile.ok).toBe(true);
    expect(
      compile.byIntegration[0]?.agenticPlans?.[0]?.outputColumns.map((column) => column.name)
    ).toContain('_dogsled_run_id');
    expect(compile.byIntegration[0]?.results).toHaveLength(2);
    expect((await validateProject(f.root)).ok).toBe(true);
    await runProject(f.root, { ...f.options, models: ['+pair_assessments'] });
    expect(f.events).not.toContain('downstream');
  });
  it.each(['missing host', 'unsupported warehouse', 'missing profile', 'bad key'])(
    'fails %s before SQL or calls',
    async (kind) => {
      const f = fixture();
      if (kind === 'unsupported warehouse') f.host.supportedDialects = [];
      if (kind === 'missing profile') f.host.platform.models = {};
      if (kind === 'bad key') {
        f.host.inputs = { undecided_pairs: [{ name: 'wrong', type: 'string', nullable: false }] };
      }
      await expect(
        runProject(f.root, {
          ...f.options,
          experimentalAgenticProbe: kind === 'missing host' ? undefined : f.host,
        })
      ).rejects.toThrow();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.host.executeAgent).not.toHaveBeenCalled();
    }
  );
  it.each(['failed', 'foreign key', 'metadata', 'malformed'])(
    'blocks publication and downstream on %s results',
    async (kind) => {
      const f = fixture();
      f.host.executeAgent = vi.fn(async ({ assignment }) => {
        const usage = { status: 'unknown' as const, reason: 'unavailable' as const };
        if (kind === 'failed') {
          return {
            contract_version: 2,
            attempt_id: assignment.attempt_id,
            status: 'failed',
            usage,
            error: { kind: 'internal', code: 'FAKE_FAILED', retryable: false },
          };
        }
        return {
          contract_version: 2,
          attempt_id: assignment.attempt_id,
          status: 'succeeded',
          usage,
          rows: [
            {
              pair_id: kind === 'foreign key' ? 'foreign' : 'p1',
              assessment: kind === 'malformed' ? 123 : 'review',
              _dogsled_evidence: null,
              _dogsled_confidence: kind === 'metadata' ? 2 : null,
              _dogsled_reason: null,
            },
          ],
        };
      });
      const result = await runProject(f.root, f.options);
      expect(result.ok).toBe(false);
      expect(f.host.publish).not.toHaveBeenCalled();
      expect(f.events).not.toContain('downstream');
    }
  );
  it.each(['tests', 'expect', 'timeout'])(
    'rejects unsupported %s before execution',
    async (kind) => {
      const f = fixture();
      if (kind === 'tests') f.model.tests = [{ type: 'not_null', column: 'pair_id' }];
      if (kind === 'expect') f.model.expect = [{ kind: 'non_null', column: 'pair_id' }];
      if (kind === 'timeout') f.model.limits.timeout_seconds = 4_294_968;
      writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
      await expect(runProject(f.root, f.options)).rejects.toThrow();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.host.prepare).not.toHaveBeenCalled();
    }
  );
  it('retains live-source ancestry through agentic models and ignores exact old-target refs', async () => {
    const f = fixture();
    f.model.sources.previous = { ref: f.model.name };
    writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
    const project = await loadProject(f.root);
    project.sourceEntries.set('lake.pairs', {
      kind: 'api_resource',
      fqRef: 'sources.pairs',
      integration: 'lake',
      resource: 'pairs',
      connection: 'lake',
      mode: 'live',
      columns: [],
    });
    const result = analyzeModelDependencies({
      models: project.models.map((node) => node.parsedSpec),
      sourceEntries: project.sourceEntries,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.analyses.find((entry) => entry.modelName === 'advice')).toMatchObject({
      executionMode: 'on_read',
      closure: {
        models: ['undecided_pairs', 'pair_assessments', 'advice'],
        liveSources: ['lake.pairs'],
      },
    });
  });
  it('distinguishes empty findings from empty preparation', async () => {
    const f = fixture();
    f.host.executeAgent = vi.fn(async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [],
    }));
    expect((await runProject(f.root, f.options)).ok).toBe(true);
    expect(f.host.publish).toHaveBeenCalledWith(expect.anything(), [], [{ pair_id: 'p1' }]);
    vi.mocked(f.host.publish).mockClear();
    f.host.prepare = vi.fn(async () => []);
    expect((await runProject(f.root, f.options)).ok).toBe(true);
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it('warns that deprecated per-assignment limits are ignored by new runs', async () => {
    const f = fixture();
    f.model.limits.tokens_per_assignment = 500;
    f.model.plan.steps[0]!.limits = { model_calls_per_assignment: 2 };
    writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
    const result = await runProject(f.root, f.options);
    const warning = result.warnings.find((text) => text.includes('deprecated'));
    expect(warning).toContain('limits.tokens_per_assignment');
    expect(warning).toContain('plan.steps.assess.limits.model_calls_per_assignment');
    expect(warning).toContain('new runs ignore them');
  });
  it('stops before the next assignment when the token cap is reached', async () => {
    const f = fixture();
    f.model.limits.tokens = 2000;
    writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
    f.host.prepare = vi.fn(async () => [{ pair_id: 'p1' }, { pair_id: 'p2' }]);
    f.host.executeAgent = vi.fn(async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'measured', input_tokens: 3000, output_tokens: 2000, total_tokens: 5000 },
      rows: [],
    }));
    const result = await runProject(f.root, f.options);
    expect(result.ok).toBe(false);
    expect(result.byIntegration[0]!.error).toContain('spend_cap_reached');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
    expect(f.host.publish).not.toHaveBeenCalled();
    expect(f.events).not.toContain('downstream');
  });
  it.each(['duplicate groups', 'row bound', 'byte bound'])(
    'rejects %s before executor calls',
    async (kind) => {
      const f = fixture();
      f.host.prepare = vi.fn(async () =>
        kind === 'duplicate groups'
          ? [{ pair_id: 'p1' }, { pair_id: 'p1' }]
          : kind === 'row bound'
            ? Array.from({ length: 1001 }, (_, i) => ({ pair_id: String(i) }))
            : [{ pair_id: 'x'.repeat(1048577) }]
      );
      expect((await runProject(f.root, f.options)).ok).toBe(false);
      expect(f.host.executeAgent).not.toHaveBeenCalled();
      expect(f.host.publish).not.toHaveBeenCalled();
    }
  );
  it('blocks a final grain collision across otherwise valid assignments', async () => {
    const f = fixture();
    f.model.grain = ['assessment'];
    writeFileSync(join(f.root, 'models/agentic.yml'), stringify(f.model));
    f.host.prepare = vi.fn(async () => [{ pair_id: 'p1' }, { pair_id: 'p2' }]);
    f.host.executeAgent = vi.fn(async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [
        {
          pair_id: assignment.group_key.pair_id!,
          assessment: 'same',
          _dogsled_evidence: null,
          _dogsled_confidence: null,
          _dogsled_reason: null,
        },
      ],
    }));
    expect((await runProject(f.root, f.options)).ok).toBe(false);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it('supplies an ephemeral input SELECT rather than a nonexistent table', async () => {
    const f = fixture();
    const path = join(f.root, 'models/undecided_pairs.yml');
    const model = parse(readFileSync(path, 'utf8'));
    model.materialization.type = 'ephemeral';
    writeFileSync(path, stringify(model));
    f.host.prepare = vi.fn(async ({ inputSql }) => {
      expect(inputSql).toContain('SELECT');
      expect(inputSql).toContain('raw');
      return [{ pair_id: 'p1' }];
    });
    const result = await runProject(f.root, f.options);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.events).not.toContain('derived');
  });
  it.each(['prepare', 'executeAgent', 'publish'] as const)(
    'does not expose raw %s failures',
    async (phase) => {
      const f = fixture();
      f.host[phase] = vi.fn(async () => {
        throw new Error('provider-secret-and-private-row');
      });
      const result = await runProject(f.root, f.options);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('provider-secret-and-private-row');
      expect(f.events).not.toContain('downstream');
    }
  );
  it('checks cancellation again after provisional publication', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.publish = vi.fn(async () => {
      controller.abort();
    });
    const result = await runProject(f.root, { ...f.options, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(f.events).not.toContain('downstream');
    expect(result.state.models['lake.pair_assessments']).toBeUndefined();
  });
  it('stops after cancellation during prepare and never advances agentic state', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.prepare = vi.fn(async ({ signal }) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return [{ pair_id: 'p1' }];
    });
    const result = await runProject(f.root, { ...f.options, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect(f.host.publish).not.toHaveBeenCalled();
    expect(f.events).not.toContain('downstream');
  });
});

describe('agent host concurrency validation', () => {
  it.each([
    { concurrency: 0 },
    { concurrency: 65 },
    { concurrency: 1.5 },
    { concurrency: NaN },
    { minDispatchIntervalMs: -1 },
    { minDispatchIntervalMs: 60001 },
    { minDispatchIntervalMs: 0.5 },
    { minDispatchIntervalMs: Infinity },
  ])('rejects invalid options %j before dispatch', async (limits) => {
    const f = fixture();
    Object.assign(f.host, limits);
    await expect(
      runProject(f.root, {
        customRunners: f.options.customRunners,
        agentic: { host: f.host, run: { id: 'invalid-limits', mode: 'start' } },
      })
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.host.prepare).not.toHaveBeenCalled();
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
