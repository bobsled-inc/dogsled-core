import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitSyncResult } from '../../../src/commands/sync.js';

describe('sync command text output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(run: () => void): string {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    run();
    return chunks.join('');
  }

  it('prints objects as YAML instead of [object Object]', () => {
    const text = capture(() =>
      emitSyncResult(
        { syncs: [{ name: 'contacts_to_webhook' }] },
        { json: false, verbose: false, quiet: false, color: false }
      )
    );
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('name: contacts_to_webhook');
  });

  it('keeps JSON output unchanged', () => {
    const text = capture(() =>
      emitSyncResult({ ok: true }, { json: true, verbose: false, quiet: false, color: false })
    );
    expect(JSON.parse(text)).toEqual({ ok: true });
  });
});
