import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';

vi.mock('../../../src/api/review-project.js', () => ({
  reviewResolveProject: vi.fn(),
}));
vi.mock('../../../src/runtime/project-context.js', () => ({
  loadEntityGraphProjectContext: vi.fn(),
}));
vi.mock('../../../src/commands/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/utils.js')>();
  return { ...actual, emitEntityGraphPayload: vi.fn() };
});

import {
  reviewResolveProject,
  type ReviewResolveProjectResult,
} from '../../../src/api/review-project.js';
import { reviewHandler } from '../../../src/commands/resolve-review.js';
import { emitEntityGraphPayload } from '../../../src/commands/utils.js';
import { loadEntityGraphProjectContext } from '../../../src/runtime/project-context.js';

const reviewResolveProjectMock = vi.mocked(reviewResolveProject);
const loadContextMock = vi.mocked(loadEntityGraphProjectContext);
const emitPayloadMock = vi.mocked(emitEntityGraphPayload);

function makeContext(options: { confirmBeforeWrite?: boolean } = {}) {
  return {
    specs: [
      {
        entity: 'company',
        agentPolicy: {
          enabled: true,
          ...(options.confirmBeforeWrite ? { confirmBeforeWrite: true } : {}),
        },
      },
    ],
    dialect: 'duckdb',
    targetSchema: 'entity_graph',
    warnings: [],
  } as unknown as Awaited<ReturnType<typeof loadEntityGraphProjectContext>>;
}

function makeResult(
  overrides: Partial<ReviewResolveProjectResult> = {}
): ReviewResolveProjectResult {
  return {
    entity: 'company',
    executed: true,
    pairs_fetched: 2,
    metrics: {
      pairsReviewed: 2,
      pairsMerged: 1,
      pairsRejected: 1,
      costUsd: 0.01,
      tokensUsed: 100,
      pairsRemaining: 0,
    },
    applied_count: 2,
    proposed_count: 0,
    deferred_count: 0,
    decision_batch_id: 'batch-1',
    warnings: [],
    ...overrides,
  };
}

// quiet suppresses the text formatter so tests don't write to stdout.
const GLOBALS = { quiet: true };

beforeEach(() => {
  reviewResolveProjectMock.mockReset();
  loadContextMock.mockReset();
  emitPayloadMock.mockReset();
  loadContextMock.mockResolvedValue(makeContext());
  reviewResolveProjectMock.mockResolvedValue([makeResult()]);
});

describe('resolve review CLI handler', () => {
  it('refuses a real write with CommandError(2) when confirm_before_write is set and --yes is absent', async () => {
    loadContextMock.mockResolvedValue(makeContext({ confirmBeforeWrite: true }));

    const error = await reviewHandler(['company'], {}, GLOBALS).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(2);
    expect((error as CommandError).message).toContain('confirm_before_write');
    expect(reviewResolveProjectMock).not.toHaveBeenCalled();
  });

  it('lets --yes and --dry-run through the confirm_before_write guard', async () => {
    loadContextMock.mockResolvedValue(makeContext({ confirmBeforeWrite: true }));

    await reviewHandler(['company'], { yes: true }, GLOBALS);
    await reviewHandler(['company'], { dryRun: true }, GLOBALS);

    expect(reviewResolveProjectMock).toHaveBeenCalledTimes(2);
    expect(reviewResolveProjectMock.mock.calls[1]![0]).toMatchObject({ dryRun: true });
  });

  it('forwards --max-pairs as maxPairsPerRun and only when set', async () => {
    await reviewHandler(['company'], { maxPairs: 5 }, GLOBALS);
    expect(reviewResolveProjectMock.mock.calls[0]![0]).toMatchObject({ maxPairsPerRun: 5 });

    await reviewHandler(['company'], {}, GLOBALS);
    expect(reviewResolveProjectMock.mock.calls[1]![0]).not.toHaveProperty('maxPairsPerRun');
  });

  it('emits the structured payload in json mode and skips it in text mode', async () => {
    await reviewHandler(['company'], { json: true }, GLOBALS);
    expect(emitPayloadMock).toHaveBeenCalledTimes(1);
    expect(emitPayloadMock.mock.calls[0]![0]).toMatchObject({
      command: 'resolve.review',
      dialect: 'duckdb',
      schema: 'entity_graph',
      entities: [expect.objectContaining({ entity: 'company' })],
    });
    expect(emitPayloadMock.mock.calls[0]![1]).toBe('json');

    emitPayloadMock.mockReset();
    await reviewHandler(['company'], {}, GLOBALS);
    expect(emitPayloadMock).not.toHaveBeenCalled();
  });

  it('does NOT throw for a judge-infra failure (fail-soft, exit 0)', async () => {
    reviewResolveProjectMock.mockResolvedValue([
      makeResult({
        executed: false,
        applied_count: 0,
        warnings: ['company: agent_review:judge failed: judge exploded'],
        failure: {
          entity: 'company',
          failedCount: 1,
          failedStatements: [{ name: 'agent_review:judge', error: 'judge exploded' }],
        },
      }),
    ]);

    await expect(reviewHandler(['company'], {}, GLOBALS)).resolves.toBeUndefined();
  });

  it('treats a failure without failedStatements as a write failure (fail loud, exit 1)', async () => {
    // Only judge failures (every statement prefixed `agent_review:`) are
    // fail-soft; a failure that carries no statement detail cannot be proven
    // to be one, so the handler must not swallow it.
    reviewResolveProjectMock.mockResolvedValue([
      makeResult({
        failure: { entity: 'company', failedCount: 1 },
      }),
    ]);

    const error = await reviewHandler(['company'], {}, GLOBALS).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(1);
  });

  it('throws CommandError(1) for a decision WRITE failure', async () => {
    reviewResolveProjectMock.mockResolvedValue([
      makeResult({
        failure: {
          entity: 'company',
          failedCount: 1,
          failedStatements: [
            { name: 'company:apply_review_decisions', error: 'permission denied' },
          ],
        },
      }),
    ]);

    const error = await reviewHandler(['company'], {}, GLOBALS).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(1);
    expect((error as CommandError).message).toContain('permission denied');
  });
});
