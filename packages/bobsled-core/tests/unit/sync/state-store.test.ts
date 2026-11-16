import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileSyncStateStore } from '../../../src/sync/state-store.js';

let tempDir: string | undefined;
let outsideDir: string | undefined;

function makeStore(): FileSyncStateStore {
  tempDir = mkdtempSync(join(tmpdir(), 'bobsled-sync-state-'));
  return new FileSyncStateStore(tempDir);
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  if (outsideDir) {
    rmSync(outsideDir, { recursive: true, force: true });
    outsideDir = undefined;
  }
});

describe('FileSyncStateStore', () => {
  it('acquires and releases a lease', async () => {
    const store = makeStore();
    const lease = await store.acquireLease('contacts_to_webhook', 60);
    await expect(store.acquireLease('contacts_to_webhook', 60)).rejects.toThrow(/already leased/);
    await store.releaseLease(lease);
    await expect(store.acquireLease('contacts_to_webhook', 60)).resolves.toMatchObject({
      sync_name: 'contacts_to_webhook',
    });
  });

  it('saves and loads checkpoints atomically', async () => {
    const store = makeStore();
    await store.saveCheckpoint('contacts_to_webhook', {
      cursor_value: '2026-01-01',
      tie_breaker_values: ['ent_1'],
      idempotency_key: 'abc',
      updated_at: '2026-01-01T00:00:00.000Z',
      run_id: 'run_1',
    });
    await expect(store.loadCheckpoint('contacts_to_webhook')).resolves.toMatchObject({
      cursor_value: '2026-01-01',
      tie_breaker_values: ['ent_1'],
    });
  });

  it('rejects traversal-shaped sync and run identifiers', async () => {
    const store = makeStore();
    const summary = {
      run_id: 'run_1',
      sync_name: 'contacts_to_webhook',
      status: 'running' as const,
      started_at: '2026-01-01T00:00:00.000Z',
      dry_run: false,
      counters: { processed: 0, succeeded: 0, failed: 0, skipped: 0 },
    };

    await expect(store.acquireLease('../outside', 60)).rejects.toThrow(/unsafe state path/i);
    await expect(store.startRun('contacts_to_webhook', '../outside', summary)).rejects.toThrow(
      /unsafe state path/i
    );
  });

  it('rejects an intermediate symlink before writing a checkpoint', async () => {
    const store = makeStore();
    outsideDir = mkdtempSync(join(tmpdir(), 'bobsled-sync-outside-'));
    symlinkSync(outsideDir, join(tempDir!, 'contacts_to_webhook'));

    await expect(
      store.saveCheckpoint('contacts_to_webhook', {
        cursor_value: '2026-01-01',
        tie_breaker_values: [],
        updated_at: '2026-01-01T00:00:00.000Z',
        run_id: 'run_1',
      })
    ).rejects.toThrow(/symlink state path/i);
    expect(existsSync(join(outsideDir, 'checkpoint.json'))).toBe(false);
  });

  it('rejects symlink leaves for reads and appends', async () => {
    const store = makeStore();
    outsideDir = mkdtempSync(join(tmpdir(), 'bobsled-sync-outside-'));
    const syncDir = join(tempDir!, 'contacts_to_webhook');
    mkdirSync(join(syncDir, 'receipts'), { recursive: true });

    const outsideCheckpoint = join(outsideDir, 'checkpoint.json');
    writeFileSync(outsideCheckpoint, '{"cursor_value":"secret"}\n');
    symlinkSync(outsideCheckpoint, join(syncDir, 'checkpoint.json'));
    await expect(store.loadCheckpoint('contacts_to_webhook')).rejects.toThrow(
      /symlink state path/i
    );

    const outsideReceipt = join(outsideDir, 'receipts.jsonl');
    writeFileSync(outsideReceipt, '');
    symlinkSync(outsideReceipt, join(syncDir, 'receipts', 'run_1.jsonl'));
    await expect(
      store.appendReceipt('contacts_to_webhook', 'run_1', {
        run_id: 'run_1',
        sync_name: 'contacts_to_webhook',
        entity_key: { id: '1' },
        idempotency_key: 'key_1',
        action: 'upsert',
        status: 'success',
        attempted_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 1,
      })
    ).rejects.toThrow(/symlink state path/i);
    expect(readFileSync(outsideReceipt, 'utf8')).toBe('');
  });
});
