import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { Action } from '@bobsled-inc/integrations';

import type { ActionResult } from '../../../src/lib/action-executor.js';
import type { SyncSpec } from '../../../src/sync/spec.js';
import { SyncSpecSchema } from '../../../src/sync/spec.js';
import type {
  Lease,
  SyncActionIdempotencyClaimResult,
  SyncCheckpoint,
  SyncReceipt,
  SyncStateStore,
} from '../../../src/sync/state-store.js';

const mocks = vi.hoisted(() => ({
  executeAction: vi.fn(),
}));

vi.mock('../../../src/lib/action-executor.js', () => ({
  executeAction: mocks.executeAction,
}));

import { runSync } from '../../../src/sync/run.js';

const FIXED_NOW = new Date('2026-02-01T00:00:00.000Z');

function makeSpec(): SyncSpec {
  return SyncSpecSchema.parse({
    spec_version: '1',
    type: 'sync',
    name: 'contacts_to_webhook',
    source: {
      type: 'projection',
      connection: 'warehouse',
      projection_ref: 'analytics.contacts',
      cursor: { field: 'updated_at', initial_value: '2026-01-01' },
    },
    target: {
      action: 'salesforce/upsert_contact',
      entity_key: { fields: ['id'] },
    },
  });
}

function makeAction(): Action {
  return {
    name: 'upsert_contact',
    qualifiedName: 'salesforce/upsert_contact',
    transport: 'api',
    inputs: {},
  } as unknown as Action;
}

const ROWS = [
  { id: 'c1', updated_at: '2026-01-02' },
  { id: 'c2', updated_at: '2026-01-03' },
];

function makeRunner(rows: Record<string, unknown>[] = ROWS): SqlRunnerModule {
  let served = false;
  return {
    run: vi.fn(async () => ({})),
    // Serve the page once, then return empty so the loop terminates.
    query: vi.fn(async () => {
      if (served) return [];
      served = true;
      return rows;
    }),
    supportsBindings: true,
    close: vi.fn(async () => undefined),
  };
}

interface FakeStore extends SyncStateStore {
  receipts: SyncReceipt[];
  checkpoints: SyncCheckpoint[];
  acquireLease: ReturnType<typeof vi.fn>;
  releaseLease: ReturnType<typeof vi.fn>;
  loadCheckpoint: ReturnType<typeof vi.fn>;
  saveCheckpoint: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
  finishRun: ReturnType<typeof vi.fn>;
  appendReceipt: ReturnType<typeof vi.fn>;
  appendDeadLetter: ReturnType<typeof vi.fn>;
}

function makeStore(claim?: SyncStateStore['claimSyncActionIdempotencyKey']): FakeStore {
  const receipts: SyncReceipt[] = [];
  const checkpoints: SyncCheckpoint[] = [];
  const lease: Lease = {
    sync_name: 'contacts_to_webhook',
    pid: 1,
    host: 'test',
    owner: 'test:1',
    acquired_at: FIXED_NOW.toISOString(),
    ttl_seconds: 900,
  };
  const store: FakeStore = {
    receipts,
    checkpoints,
    acquireLease: vi.fn(async () => lease),
    releaseLease: vi.fn(async () => undefined),
    loadCheckpoint: vi.fn(async () => null),
    saveCheckpoint: vi.fn(async (_name: string, checkpoint: SyncCheckpoint) => {
      checkpoints.push(checkpoint);
    }),
    startRun: vi.fn(async () => undefined),
    finishRun: vi.fn(async () => undefined),
    appendReceipt: vi.fn(async (_name: string, _runId: string, receipt: SyncReceipt) => {
      receipts.push(receipt);
    }),
    appendDeadLetter: vi.fn(async () => undefined),
  };
  if (claim) {
    store.claimSyncActionIdempotencyKey = claim;
  }
  return store;
}

function successResult(): ActionResult {
  return {
    status: 'success',
    action: 'salesforce/upsert_contact',
    transport: 'api',
    target_record_id: 'created_1',
    attempted_at: FIXED_NOW.toISOString(),
    duration_ms: 5,
  };
}

let projectRoot: string;

function run(store: SyncStateStore): ReturnType<typeof runSync> {
  return runSync({
    spec: makeSpec(),
    projectRoot,
    action: makeAction(),
    runner: makeRunner(),
    stateStore: store,
    now: () => FIXED_NOW,
  });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dogsled-sync-run-'));
  mocks.executeAction.mockReset();
  mocks.executeAction.mockResolvedValue(successResult());
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('runSync reverse-ETL idempotency hook', () => {
  it('executes the action when the hook returns claimed', async () => {
    const claim = vi.fn(
      async (): Promise<SyncActionIdempotencyClaimResult> => ({ status: 'claimed' })
    );
    const store = makeStore(claim);

    const summary = await run(store);

    expect(claim).toHaveBeenCalledTimes(ROWS.length);
    expect(mocks.executeAction).toHaveBeenCalledTimes(ROWS.length);
    expect(summary.counters).toMatchObject({
      processed: 2,
      succeeded: 2,
      skipped: 0,
      failed: 0,
    });
    // The API action receives one project index for the whole sync.
    const indexes = mocks.executeAction.mock.calls.map((call) => call[2]?.index);
    expect(indexes[0]).toMatchObject({ root: projectRoot, entries: [] });
    expect(indexes[1]).toBe(indexes[0]);
  });

  it('skips the action when the hook returns already_succeeded', async () => {
    const claim = vi.fn(
      async (): Promise<SyncActionIdempotencyClaimResult> => ({
        status: 'already_succeeded',
        target_record_id: 'ext_1',
      })
    );
    const store = makeStore(claim);

    const summary = await run(store);

    expect(claim).toHaveBeenCalledTimes(ROWS.length);
    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(summary.status).toBe('completed');
  });

  it('appends a skipped receipt and advances the checkpoint for idempotent duplicates', async () => {
    const claim = vi.fn(
      async (): Promise<SyncActionIdempotencyClaimResult> => ({
        status: 'already_succeeded',
        target_record_id: 'ext_1',
      })
    );
    const store = makeStore(claim);

    await run(store);

    expect(store.receipts).toHaveLength(ROWS.length);
    expect(store.receipts[0]).toMatchObject({
      status: 'skipped',
      action: 'salesforce/upsert_contact',
      entity_key: { id: 'c1' },
      target_record_id: 'ext_1',
      attempted_at: FIXED_NOW.toISOString(),
      duration_ms: 0,
    });
    expect(store.receipts[0]?.idempotency_key).toBeTruthy();

    // The checkpoint must advance to the last processed row, otherwise the sync
    // would loop forever on an idempotent duplicate.
    const lastCheckpoint = store.checkpoints.at(-1);
    expect(lastCheckpoint?.cursor_value).toBe('2026-01-03');
  });

  it('counts idempotent duplicates as skipped, not succeeded or failed', async () => {
    const claim = vi.fn(
      async (): Promise<SyncActionIdempotencyClaimResult> => ({
        status: 'already_succeeded',
      })
    );
    const store = makeStore(claim);

    const summary = await run(store);

    expect(summary.counters).toEqual({
      processed: 2,
      succeeded: 0,
      failed: 0,
      skipped: 2,
    });
    expect(store.appendDeadLetter).not.toHaveBeenCalled();
  });

  it('fails before executing any destination action when the hook throws', async () => {
    const claim = vi.fn(async (): Promise<SyncActionIdempotencyClaimResult> => {
      throw new Error('claim backend unavailable');
    });
    const store = makeStore(claim);

    await expect(run(store)).rejects.toThrow('claim backend unavailable');
    expect(mocks.executeAction).not.toHaveBeenCalled();
    expect(store.appendReceipt).not.toHaveBeenCalled();
    expect(store.finishRun).toHaveBeenCalledTimes(1);
    const [, , summary] = store.finishRun.mock.calls[0] ?? [];
    expect(summary).toMatchObject({ status: 'failed' });
  });

  it('behaves as before for state stores without the optional hook', async () => {
    const store = makeStore();
    expect(store.claimSyncActionIdempotencyKey).toBeUndefined();

    const summary = await run(store);

    expect(mocks.executeAction).toHaveBeenCalledTimes(ROWS.length);
    expect(summary.counters).toMatchObject({
      processed: 2,
      succeeded: 2,
      skipped: 0,
      failed: 0,
    });
  });
});
