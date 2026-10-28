import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadState, saveState } from '../../src/runtime/state.js';

describe('state persistence integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws on corrupted JSON (fail closed)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'state.json'), '{ this is not valid json !!!', 'utf-8');
    await expect(loadState(tmpDir)).rejects.toThrow(/Corrupted state file.*invalid JSON/);
  });

  it('returns empty state for non-existent directory (fresh start)', async () => {
    await expect(loadState(path.join(tmpDir, 'does_not_exist'))).resolves.toEqual({ streams: {} });
  });

  it('throws on valid JSON but invalid schema', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'state.json'),
      JSON.stringify({ streams: { 'conn/res': 'not_an_object' } }),
      'utf-8'
    );

    await expect(loadState(tmpDir)).rejects.toThrow(/Corrupted state file/);
  });

  it('round-trips valid state through save and load', async () => {
    const state = {
      streams: {
        'api/items': {
          cursor_field: 'updated_at',
          cursor_value: '2024-06-01T00:00:00Z',
          last_run_at: '2024-06-15T12:00:00Z',
          record_count: 42,
        },
      },
    };

    await saveState(tmpDir, state);
    await expect(loadState(tmpDir)).resolves.toEqual(state);
  });
});
