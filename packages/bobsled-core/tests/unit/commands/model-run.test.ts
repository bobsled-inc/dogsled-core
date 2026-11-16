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

import { AgenticHostError } from '@bobsled-inc/model-spec/agentic';
import { runProject } from '@bobsled-inc/model-spec/project';
import { createCliAgenticHost } from '../../../src/runtime/cli-agentic-host.js';
import {
  createProgressPrinter,
  formatAgenticProgress,
  runBobsledModelRunCommand,
} from '../../../src/commands/model-run.js';
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
    const projectRoot = '/tmp/nested-bobsled-project';
    const exit = await runBobsledModelRunCommand(['--project-root', projectRoot, '--quiet']);

    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledWith(projectRoot, expect.any(Object));
    expect(loadApiResourceEntries).toHaveBeenCalledWith(projectRoot);
  });

  it('forwards the managed credential command to model SQL and publish orchestration', async () => {
    const previous = process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'];
    process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'] = 'mint-snowflake-token --json';
    try {
      const exit = await runBobsledModelRunCommand(['--quiet']);

      expect(exit).toBe(0);
      expect(runProject).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentialsTokenCommand: 'mint-snowflake-token --json',
        })
      );
    } finally {
      if (previous === undefined) delete process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'];
      else process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'] = previous;
    }
  });

  it('routes through runProjectWithLazySources when the project has a live source', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('live')]);

    const exit = await runBobsledModelRunCommand(['--quiet']);

    expect(exit).toBe(0);
    expect(runProjectWithLazySources).toHaveBeenCalledTimes(1);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('forwards --integration to the orchestrator when a lazy source is present', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('lazy')]);

    const exit = await runBobsledModelRunCommand(['--integration', 'lake', '--quiet']);

    expect(exit).toBe(0);
    expect(runProjectWithLazySources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runProjectWithLazySources).mock.calls[0]![0].integration).toBe('lake');
    expect(runProject).not.toHaveBeenCalled();
  });

  it('uses plain runProject when there are no live/lazy sources', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('extract')]);

    const exit = await runBobsledModelRunCommand(['--quiet']);

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

    const exit = await runBobsledModelRunCommand(['--quiet']);

    expect(exit).toBe(0);
    expect(runProjectWithLazySources).toHaveBeenCalledTimes(1);
    expect(runProject).not.toHaveBeenCalled();
  });

  it('uses plain runProject under --dry-run and never probes for live/lazy sources', async () => {
    vi.mocked(loadApiResourceEntries).mockResolvedValue([apiEntry('live')]);

    const exit = await runBobsledModelRunCommand(['--dry-run', '--quiet']);

    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledTimes(1);
    expect(runProjectWithLazySources).not.toHaveBeenCalled();
    // Dry run performs no API fetch, so detection is skipped entirely.
    expect(loadApiResourceEntries).not.toHaveBeenCalled();
  });
});

describe('agent executor run identity', () => {
  it('passes explicit identity and resume mode to the durable runner', async () => {
    const exit = await runBobsledModelRunCommand([
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
      await runBobsledModelRunCommand([
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
      await runBobsledModelRunCommand([
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
      await runBobsledModelRunCommand(['--agent-executor', './executor.mjs', ...flags, '--quiet'])
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
      await runBobsledModelRunCommand(['--agent-executor', './executor.mjs', flag, value, '--json'])
    ).toBe(2);
    expect(createCliAgenticHost).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
    expect(loadApiResourceEntries).not.toHaveBeenCalled();
  });

  it.each([
    ['--agent-concurrency', '1'],
    ['--agent-min-dispatch-interval-ms', '0'],
  ])('requires an executor for %s', async (flag, value) => {
    expect(await runBobsledModelRunCommand([flag, value, '--json'])).toBe(2);
    expect(createCliAgenticHost).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
  });
});

describe('agent paid source options', () => {
  it('forwards only explicitly named sources', async () => {
    expect(
      await runBobsledModelRunCommand([
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
      await runBobsledModelRunCommand(['--agent-allow-billable-source', 'web.search', '--json'])
    ).toBe(2);
    expect(createCliAgenticHost).not.toHaveBeenCalled();
  });
});

describe('agent spend and retry options', () => {
  const base = ['--agent-executor', './executor.mjs', '--quiet'];
  it('forwards a cost cap and an explicit failed-assignment retry', async () => {
    const exit = await runBobsledModelRunCommand([
      ...base,
      '--agent-run-id',
      'run-1',
      '--agent-resume',
      '--agent-retry-failed',
      '--agent-max-cost',
      '12.5',
    ]);
    expect(exit).toBe(0);
    expect(runProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agentic: expect.objectContaining({ maxCostUsd: 12.5, retryFailedAssignments: true }),
      })
    );
  });
  it.each([['0'], ['-1'], ['abc'], ['1e3']])('rejects --agent-max-cost %s', async (value) => {
    expect(await runBobsledModelRunCommand([...base, '--agent-max-cost', value, '--json'])).toBe(2);
    expect(runProject).not.toHaveBeenCalled();
  });
  it('requires --agent-resume for --agent-retry-failed', async () => {
    expect(await runBobsledModelRunCommand([...base, '--agent-retry-failed', '--json'])).toBe(2);
    expect(runProject).not.toHaveBeenCalled();
  });
});

describe('agentic fatal errors', () => {
  it('print safe causes without provider text', async () => {
    const provider = Object.assign(new Error('denied for key sk-live-secret'), {
      name: 'APICallError',
      statusCode: 429,
    });
    vi.mocked(runProject).mockRejectedValue(
      new AgenticHostError('Agentic executor failed for step "assess" assignment 0.', {
        cause: provider,
      })
    );
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(
        await runBobsledModelRunCommand(['--agent-executor', './executor.mjs', '--json'])
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const output = writes.join('');
    expect(output).toContain('Agentic executor failed for step');
    expect(output).toContain('caused by: APICallError (status 429)');
    expect(output).not.toContain('sk-live-secret');
  });
});

describe('cancelled agentic runs', () => {
  it('say what was kept and how to resume instead of listing cancelled statements', async () => {
    vi.mocked(runProject).mockResolvedValue({
      ...okResult,
      ok: false,
      cancelled: true,
      byIntegration: [
        {
          handle: 'local',
          dialect: 'duckdb',
          statements: [],
          models: [],
          executionResults: [],
          error: 'SQL execution cancelled before the statement started.',
        },
      ],
    } as unknown as RunProjectResult);
    const writes: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runBobsledModelRunCommand([
        '--agent-executor',
        './executor.mjs',
        '--agent-run-id',
        'run-7',
        '--yaml',
      ]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const text = writes.join('');
    expect(text).toContain('Cancelled. Agentic answers saved before the stop are kept');
    expect(text).toContain('run the same command again with --agent-run-id run-7');
    expect(text).not.toContain('SQL execution cancelled');
  });
});

describe('agentic progress lines', () => {
  const base = {
    runId: 'r1',
    modelName: 'pair_assessments',
    revision: 4,
    status: 'running' as const,
    publication: 'pending' as const,
    totalIsFinal: true,
    steps: [],
    total: 900,
    accepted: 312,
    running: 2,
    pending: 586,
    failed: 0,
    remainingInputTokens: 0,
  };
  it('show assignments and spend against the dollar cap', () => {
    expect(
      formatAgenticProgress({
        ...base,
        spend: { tokens: 241_000, usd: 1.24, tokenCap: null, usdCap: 40 },
      })
    ).toBe(
      'pair_assessments: 312 of 900 assignments done (2 running, 0 failed) · 241,000 tokens · $1.24 of $40.00 cap'
    );
  });
  it('show the input waiting before work starts and an open total', () => {
    expect(
      formatAgenticProgress({
        ...base,
        accepted: 0,
        running: 0,
        totalIsFinal: false,
        remainingInputTokens: 3291,
        spend: { tokens: 0, usd: 0, tokenCap: 10_000, usdCap: null },
      })
    ).toBe(
      'pair_assessments: 0 of at least 900 assignments done · 0 of 10,000 tokens · about 3,291 input tokens to process'
    );
  });
  it('skip reports before work is known and always show the first estimate', () => {
    const lines: string[] = [];
    let clock = 0;
    const print = createProgressPrinter(
      (line) => lines.push(line),
      () => clock
    );
    print({ ...base, total: 0, accepted: 0, running: 0, totalIsFinal: false });
    clock = 100;
    print({ ...base, accepted: 0, running: 0, remainingInputTokens: 1407 });
    clock = 200;
    print({ ...base, accepted: 1 });
    clock = 300;
    print({ ...base, accepted: 900, running: 0, status: 'execution_complete' });
    // The mid-run report is throttled; the estimate and the completed state are not.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('about 1,407 input tokens to process');
    expect(lines.at(-1)).toContain('900 of 900 assignments done');
    expect(lines.some((line) => line.includes('0 of at least 0'))).toBe(false);
  });
});
