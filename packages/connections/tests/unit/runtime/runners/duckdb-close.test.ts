import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DuckDbIntegration } from '../../../../src/schemas/integration.js';

// Observe teardown against a fully mocked driver so the assertions are
// deterministic — the real-driver "persists across instances" test cannot catch
// a regression here because the OS/GC eventually flushes a leaked instance, so
// it passed even before the instance was closed explicitly.
const { instanceCloseSync, connectionCloseSync, connectionDisconnectSync } = vi.hoisted(() => ({
  instanceCloseSync: vi.fn(),
  connectionCloseSync: vi.fn(),
  connectionDisconnectSync: vi.fn(),
}));

vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create: vi.fn(async () => ({
      connect: vi.fn(async () => ({
        run: vi.fn(async () => ({ rowCount: 0 })),
        runAndReadAll: vi.fn(async () => ({ getRowObjects: () => [] })),
        closeSync: connectionCloseSync,
        disconnectSync: connectionDisconnectSync,
      })),
      closeSync: instanceCloseSync,
    })),
  },
}));

// Import after the mock is registered.
const { buildDuckDbRunner } = await import('../../../../src/runtime/runners/duckdb.js');

function memoryIntegration(): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'local_duck',
    source_type: 'duckdb',
    connection: {},
    auth: { type: 'memory' },
  };
}

describe('buildDuckDbRunner — close() releases the owning instance', () => {
  beforeEach(() => {
    instanceCloseSync.mockReset();
    connectionCloseSync.mockReset();
    connectionDisconnectSync.mockReset();
  });

  it('closes the DuckDBInstance, not just the connection', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    await runner.close?.();

    // Closing only the connection leaves the instance's checkpoint to GC, which
    // races a fresh open on the same file in a later phase (resolve → cluster).
    // The owning instance handle must be released too.
    expect(connectionCloseSync).toHaveBeenCalledTimes(1);
    expect(instanceCloseSync).toHaveBeenCalledTimes(1);
  });

  it('still closes the instance when connection teardown throws', async () => {
    connectionCloseSync.mockImplementationOnce(() => {
      throw new Error('connection closeSync failed');
    });
    const runner = await buildDuckDbRunner(memoryIntegration());

    await expect(runner.close?.()).rejects.toThrow('connection closeSync failed');
    // Independent cleanup: an earlier teardown failure must not skip instance close.
    expect(instanceCloseSync).toHaveBeenCalledTimes(1);
  });
});
