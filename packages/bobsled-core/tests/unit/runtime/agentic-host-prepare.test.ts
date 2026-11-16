import { createAgenticHost } from '../../../src/agentic.js';
import { loadProject } from '@bobsled-inc/model-spec/project';
import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), resolveRunner: vi.fn() }));
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  interpolateSecrets: vi.fn().mockResolvedValue({}),
  resolveRunner: mocks.resolveRunner,
}));
vi.mock('@bobsled-inc/model-spec/project', () => ({
  loadProject: vi.fn().mockResolvedValue({ sourceEntries: new Map(), models: [] }),
  selectIntegrationContexts: vi.fn().mockReturnValue([
    {
      integration: { handle: 'local', integration: {} },
      dialect: 'duckdb',
      registry: new Map(),
      modelReg: new Map([
        ['prepared', '"main"."prepared"'],
        ['companies', '"main"."companies"'],
      ]),
    },
  ]),
  buildSecretResolver: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../src/runner/config/loader.js', () => ({
  findBobsledConfig: vi.fn().mockReturnValue(null),
  findBobsledProject: vi.fn().mockReturnValue(null),
}));
import { createCliAgenticHost } from '../../../src/runtime/cli-agentic-host.js';
import type { AgenticProbeContext } from '@bobsled-inc/model-spec/agentic';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'bobsled-prepare-'));
  await writeFile(path.join(directory, 'executor.mjs'), 'export async function executeAgent() {}');
  mocks.query.mockReset().mockResolvedValue([{ pair_id: 'p1' }]);
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.resolveRunner.mockReset().mockResolvedValue({ query: mocks.query, close: mocks.close });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function context(overrides: Partial<AgenticProbeContext> = {}): AgenticProbeContext {
  return {
    resolved: {
      steps: [{ input_columns: [{ name: 'pair_id', type: 'string', nullable: false }] }],
    },
    integration: 'local',
    target: 'out',
    inputRef: 'prepared',
    signal: new AbortController().signal,
    maxRows: 2,
    maxBytes: 100,
    ...overrides,
  } as AgenticProbeContext;
}
async function host() {
  return createCliAgenticHost({
    cwd: directory,
    executorPath: './executor.mjs',
    tokensPerAssignment: 4096,
  });
}
describe('bounded agent input preparation', () => {
  it('uses the supplied project, executor, credentials, and SQL runners without loading files', async () => {
    const project = await loadProject(directory);
    vi.mocked(loadProject).mockClear();
    const customRunners = new CustomRunnerRegistry();
    const secretResolver = { resolve: vi.fn(async () => 'test-only') };
    const executeAgent = vi.fn();
    const tokenProvider = vi.fn();
    const instance = createAgenticHost({
      project,
      executeAgent,
      secretResolver,
      platform: {},
      tokensPerAssignment: 1024,
      concurrency: 3,
      runnerOptions: { customRunners, tokenProvider },
    });
    expect(instance.executeAgent).toBe(executeAgent);
    expect(instance.concurrency).toBe(3);
    expect(await instance.prepare(context())).toEqual([{ pair_id: 'p1' }]);
    expect(loadProject).not.toHaveBeenCalled();
    expect(mocks.resolveRunner).toHaveBeenCalledWith(
      {},
      { customRunners, tokenProvider, secretResolver }
    );
  });
  it('reads only declared columns from the resolved relation and closes the runner', async () => {
    expect(await (await host()).prepare(context())).toEqual([{ pair_id: 'p1' }]);
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT "pair_id" FROM "main"."prepared" LIMIT 3',
      undefined,
      { signal: expect.any(AbortSignal) }
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('uses the current root input columns and ephemeral SQL for later steps', async () => {
    mocks.query.mockResolvedValue([{ company_id: 'c1' }]);
    const input = context({
      inputRef: 'companies',
      inputColumns: [{ name: 'company_id', type: 'string', nullable: false }],
      inputSql: 'SELECT company_id FROM raw.companies',
    });
    expect(await (await host()).prepare(input)).toEqual([{ company_id: 'c1' }]);
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT "company_id" FROM (SELECT company_id FROM raw.companies) AS "agent_input" LIMIT 3',
      undefined,
      { signal: expect.any(AbortSignal) }
    );
  });
  it('filters incremental input before applying the row limit', async () => {
    await (
      await host()
    ).prepare(context({ incremental: { cursor_field: 'updated_at', after: 42 } }));
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT "pair_id" FROM "main"."prepared" WHERE "updated_at" > 42 LIMIT 3',
      undefined,
      { signal: expect.any(AbortSignal) }
    );
  });
  it('reads incremental batches in cursor order and returns one row past the limit', async () => {
    mocks.query.mockResolvedValue([{ pair_id: '1' }, { pair_id: '2' }, { pair_id: '3' }]);
    const rows = await (
      await host()
    ).prepare(context({ incremental: { cursor_field: 'updated_at', after: 42, batch: true } }));
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT "pair_id" FROM "main"."prepared" WHERE "updated_at" > 42 ORDER BY "updated_at" LIMIT 3',
      undefined,
      { signal: expect.any(AbortSignal) }
    );
    // Bobsled Core keeps the ordered prefix that fits; the extra row signals more remain.
    expect(rows).toHaveLength(3);
  });
  it('stops a batch one row past the byte limit instead of failing', async () => {
    mocks.query.mockResolvedValue([
      { pair_id: 'a'.repeat(40) },
      { pair_id: 'b'.repeat(40) },
      { pair_id: 'c'.repeat(40) },
    ]);
    const rows = await (
      await host()
    ).prepare(
      context({
        incremental: { cursor_field: 'updated_at', batch: true },
        maxRows: 5,
        maxBytes: 80,
      })
    );
    expect(rows).toHaveLength(2);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('rejects a row overflow without truncating the input', async () => {
    mocks.query.mockResolvedValue([{ pair_id: '1' }, { pair_id: '2' }, { pair_id: '3' }]);
    await expect((await host()).prepare(context())).rejects.toThrow(
      'Agentic input "prepared" has more than 2 rows; use an incremental source to process it in batches'
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('rejects a byte overflow and releases the runner', async () => {
    await expect((await host()).prepare(context({ maxBytes: 5 }))).rejects.toThrow(
      'Agentic input "prepared" is larger than 5 bytes; use an incremental source'
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('closes the runner when a query fails', async () => {
    mocks.query.mockRejectedValue(new Error('query failed'));
    await expect((await host()).prepare(context())).rejects.toThrow('query failed');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('does not open a runner for an already cancelled request', async () => {
    await expect(
      (await host()).prepare(context({ signal: AbortSignal.abort() }))
    ).rejects.toThrow();
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
  });
});

describe('dry-run executor isolation', () => {
  it('does not import an executor module or run its top-level code', async () => {
    const marker = path.join(directory, 'imported');
    await writeFile(
      path.join(directory, 'executor.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); throw new Error('must not import');`
    );
    await createCliAgenticHost({
      cwd: directory,
      executorPath: './executor.mjs',
      tokensPerAssignment: 8192,
      dryRun: true,
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.resolveRunner).not.toHaveBeenCalled();
  });
});
