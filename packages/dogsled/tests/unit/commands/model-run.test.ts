import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunProjectResult } from '@bobsled-inc/model-spec/project';
import type { ApiResourceEntry } from '../../../src/runtime/source-materializer/load-specs.js';

// Mock the model-build entrypoints + the source-registry loader so the wiring
// test asserts auto-detection routing only, without touching DuckDB, the API,
// or the model-spec compiler.
vi.mock('../../../src/runtime/cli-agentic-host.js', () => ({
  createCliAgenticHost: vi.fn().mockResolvedValue({ executeAgent: vi.fn() }),
}));

vi.mock('@bobsled-inc/model-spec/project', () => ({
  runProject: vi.fn(),
}));
vi.mock('../../../src/runtime/source-materializer/run-project-with-lazy-sources.js', () => ({
  runProjectWithLazySources: vi.fn(),
}));
vi.mock('../../../src/runtime/source-materializer/load-specs.js', () => ({
  loadApiResourceEntries: vi.fn(),
}));
// cross-warehouse pulls native deps at import time; stub it.
vi.mock('../../../src/runtime/cross-warehouse.js', () => ({
  publishCrossWarehouse: vi.fn(),
}));

import { runProject } from '@bobsled-inc/model-spec/project';
import { createCliAgenticHost } from '../../../src/runtime/cli-agentic-host.js';
import { runDogsledModelRunCommand } from '../../../src/commands/model-run.js';
import { loadApiResourceEntries } from '../../../src/runtime/source-materializer/load-specs.js';
import { runProjectWithLazySources } from '../../../src/runtime/source-materializer/run-project-with-lazy-sources.js';

const okResult: RunProjectResult = {
  ok: true,
  dryRun: false,
  byIntegration: [],
  warnings: [],
  skipped: [],
} as unknown as RunProjectResult;

function apiEntry(mode: 'live' | 'lazy' | 'extract'): ApiResourceEntry {
  return { kind: 'api_resource', fqRef: 'sources.issues', mode } as ApiResourceEntry;
}

beforeEach(() => {
  vi.mocked(createCliAgenticHost).mockClear();
  vi.mocked(runProject).mockReset().mockResolvedValue(okResult);
  vi.mocked(runProjectWithLazySources)
    .mockReset()
    .mockResolvedValue({ hydration: [], run: okResult });
  vi.mocked(loadApiResourceEntries).mockReset().mockResolvedValue([]);
});

describe('dogsled model run live/lazy auto-detection', () => {
  it('uses the explicit project root for model execution and source discovery', async () => {
    const projectRoot = '/tmp/nested-dogsled-project';
    const exit = await runDogsledModelRunCommand(['--project-root', projectRoot, '--quiet']);

    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledWith(projectRoot, expect.any(Object));
    expect(loadApiResourceEntries).toHaveBeenCalledWith(projectRoot);
  });

  it('forwards the managed credential command to model SQL and publish orchestration', async () => {
    const previous = process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'];
    process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'] = 'mint-snowflake-token --json';
    try {
      const exit = await runDogsledModelRunCommand(['--quiet']);

      expect(exit).toBe(0);
      expect(runProject).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentialsTokenCommand: 'mint-snowflake-token --json',
        })
      );
    } finally {
      if (previous === undefined) delete process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'];
      else process.env['DOGSLED_CREDENTIALS_TOKEN_COMMAND'] = previous;
    }
  });

  it('routes through runProjectWithLazySources when the project has a live source', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('live')]);

    const exit = await runDogsledModelRunCommand(['--quiet']);

    expect(exit).toBe(0);
    expect(runProjectWithLazySources).toHaveBeenCalledTimes(1);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('forwards --integration to the orchestrator when a lazy source is present', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('lazy')]);

    const exit = await runDogsledModelRunCommand(['--integration', 'lake', '--quiet']);

    expect(exit).toBe(0);
    expect(runProjectWithLazySources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectWithLazySources).mock.calls[0]![0].integration).toBe('lake');
    expect(runProject).not.toHaveBeenCalled();
  });

  it('uses plain runProject when there are no live/lazy sources', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('extract')]);

    const exit = await runDogsledModelRunCommand(['--quiet']);

    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledTimes(1);
    expect(runProjectWithLazySources).not.toHaveBeenCalled();
  });

  it('routes through the orchestrator for a source with an implicit (undefined) lazy mode', async () => {
    // A missing `mode` defaults to lazy, so it must still be hydrated — not
    // fall through to plain runProject.
    vi.mocked(loadApiResourceEntries).mockResolvedValue([
      { kind: 'api_resource', fqRef: 'sources.issues' } as ApiResourceEntry,
    ]);

    const exit = await runDogsledModelRunCommand(['--quiet']);

    expect(exit).toBe(0);
    expect(runProjectWithLazySources).toHaveBeenCalledTimes(1);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('uses plain runProject under --dry-run and never probes for live/lazy sources', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('live')]);

    const exit = await runDogsledModelRunCommand(['--dry-run', '--quiet']);

    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledTimes(1);
    expect(runProjectWithLazySources).not.toHaveBeenCalled();
    // Dry run performs no API fetch, so detection is skipped entirely.
    expect(loadApiResourceEntries).not.toHaveBeenCalled();
  });
});

describe('agent executor run identity', () => {
  it('passes explicit identity and resume mode to the durable runner', async () => {
    const exit = await runDogsledModelRunCommand([
      '--agent-executor',
      './executor.mjs',
      '--agent-run-id',
      'run-1',
      '--agent-resume',
      '--quiet',
    ]);
    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agentic: expect.objectContaining({ run: { id: 'run-1', mode: 'resume' } }),
      })
    );
  });
  it('requires an explicit identity to resume', async () => {
    expect(
      await runDogsledModelRunCommand([
        '--agent-executor',
        './executor.mjs',
        '--agent-resume',
        '--json',
      ])
    ).toBe(2);
    expect(runProject).not.toHaveBeenCalled();
  });
  it('rejects token limits before loading a module or running SQL', async () => {
    expect(
      await runDogsledModelRunCommand([
        '--agent-executor',
        './executor.mjs',
        '--agent-tokens-per-assignment',
        '0',
        '--json',
      ])
    ).toBe(2);
    expect(runProject).not.toHaveBeenCalled();
  });
});

describe('agent concurrency options', () => {
  it.each([
    [[], 1, 0],
    [['--agent-concurrency', '3', '--agent-min-dispatch-interval-ms', '200'], 3, 200],
    [['--agent-concurrency', '64', '--agent-min-dispatch-interval-ms', '60000'], 64, 60000],
  ])('forwards limits %j to the host', async (flags, concurrency, minDispatchIntervalMs) => {
    expect(
      await runDogsledModelRunCommand(['--agent-executor', './executor.mjs', ...flags, '--quiet'])
    ).toBe(0);
    expect(createCliAgenticHost).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency, minDispatchIntervalMs })
    );
  });

  it.each([
    ['--agent-concurrency', '0'],
    ['--agent-concurrency', '65'],
    ['--agent-concurrency', '1.5'],
    ['--agent-concurrency', 'NaN'],
    ['--agent-min-dispatch-interval-ms', '-1'],
    ['--agent-min-dispatch-interval-ms', '60001'],
    ['--agent-min-dispatch-interval-ms', '0.5'],
    ['--agent-min-dispatch-interval-ms', 'Infinity'],
  ])('rejects %s %s before loading the host or running SQL', async (flag, value) => {
    expect(
      await runDogsledModelRunCommand(['--agent-executor', './executor.mjs', flag, value, '--json'])
    ).toBe(2);
    expect(createCliAgenticHost).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
    expect(loadApiResourceEntries).not.toHaveBeenCalled();
  });

  it.each([
    ['--agent-concurrency', '1'],
    ['--agent-min-dispatch-interval-ms', '0'],
  ])('requires an executor for %s', async (flag, value) => {
    expect(await runDogsledModelRunCommand([flag, value, '--json'])).toBe(2);
    expect(createCliAgenticHost).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
  });
});

describe('agent paid source options', () => {
  it('forwards only explicitly named sources', async () => {
    expect(
      await runDogsledModelRunCommand([
        '--agent-executor',
        './executor.mjs',
        '--agent-allow-billable-source',
        'web.search',
        '--agent-allow-billable-source',
        'crm.lookup',
        '--quiet',
      ])
    ).toBe(0);
    expect(createCliAgenticHost).toHaveBeenCalledWith(
      expect.objectContaining({ allowBillableSources: ['web.search', 'crm.lookup'] })
    );
  });
  it('requires an executor for paid source permission', async () => {
    expect(
      await runDogsledModelRunCommand(['--agent-allow-billable-source', 'web.search', '--json'])
    ).toBe(2);
    expect(createCliAgenticHost).not.toHaveBeenCalled();
  });
});
