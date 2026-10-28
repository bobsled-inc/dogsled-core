import { describe, expect, it, vi } from 'vitest';

import type {
  ExtractorState,
  FileResourceSpec,
  IntegrationSpec,
} from '../../../src/types/index.js';

const mocks = vi.hoisted(() => ({
  extract: vi.fn(),
}));

vi.mock('../../../src/runtime/file-storage-extractor.js', () => ({
  extractFileStorageResource: mocks.extract,
}));

import { runFileStorageResourceExtraction } from '../../../src/commands/extract-file-storage.js';

function integration(): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'local_exports',
    source_type: 'local',
    connection: { base_directory: '/tmp' },
    auth: { type: 'none' },
  } as IntegrationSpec;
}

function resource(): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'customers',
    source: { path: '*.csv', format: 'csv' },
    replication: { method: 'full_refresh' },
    output: {},
  } as FileResourceSpec;
}

function commandArgs(state: ExtractorState) {
  return {
    integration: integration(),
    resource: resource(),
    integrationName: 'local_exports',
    emitter: {} as never,
    logger: {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      progress: vi.fn().mockResolvedValue(undefined),
    } as never,
    state,
    stateStore: {} as never,
    advanceState: false,
    startedAt: Date.now(),
    circuitBreaker: {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as never,
  };
}

describe('runFileStorageResourceExtraction cancellation', () => {
  it('passes a scoped signal, reports cancellation as a failed resource, and removes listeners', async () => {
    const state: ExtractorState = { streams: {} };
    let receivedSignal: AbortSignal | undefined;
    mocks.extract.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          receivedSignal = signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          process.emit('SIGTERM');
        })
    );

    const sigintListenersBefore = process.listenerCount('SIGINT');
    const sigtermListenersBefore = process.listenerCount('SIGTERM');
    const result = await runFileStorageResourceExtraction(commandArgs(state));

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ failed: true, resourceResult: { status: 'error' } });
    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
  });
});
