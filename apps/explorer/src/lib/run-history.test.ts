import { afterEach, describe, expect, it } from 'vitest';

import { loadRuns } from './run-history';

class LocalStorageMock {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const originalWindow = globalThis.window;
const RUN_HISTORY_STORAGE_KEY = 'bobsled-explorer-run-history';

afterEach(() => {
  if (originalWindow) {
    globalThis.window = originalWindow;
    return;
  }

  Reflect.deleteProperty(globalThis as typeof globalThis & { window?: Window }, 'window');
});

describe('loadRuns', () => {
  it('accepts valid run records from localStorage', () => {
    const localStorage = new LocalStorageMock();
    localStorage.setItem(
      RUN_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'run-1',
          command: 'extract',
          args: ['run', 'stripe'],
          sequence: [{ command: 'extract', args: ['run', 'stripe'] }],
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_005_000,
          exitCode: 0,
          stdoutLines: ['done'],
          integration: 'stripe',
          dbPath: '/tmp/dev.duckdb',
        },
      ])
    );

    globalThis.window = { localStorage } as unknown as Window & typeof globalThis;

    expect(loadRuns()).toEqual([
      {
        id: 'run-1',
        command: 'extract',
        args: ['run', 'stripe'],
        sequence: [{ command: 'extract', args: ['run', 'stripe'] }],
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_005_000,
        exitCode: 0,
        stdoutLines: ['done'],
        integration: 'stripe',
        dbPath: '/tmp/dev.duckdb',
      },
    ]);
  });

  it('rejects invalid run records instead of treating them as trusted history', () => {
    const localStorage = new LocalStorageMock();
    localStorage.setItem(
      RUN_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'run-1',
          command: 'extract',
          args: ['run', 1],
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_005_000,
          exitCode: '0',
          stdoutLines: ['done'],
        },
      ])
    );

    globalThis.window = { localStorage } as unknown as Window & typeof globalThis;

    expect(loadRuns()).toEqual([]);
  });
});
