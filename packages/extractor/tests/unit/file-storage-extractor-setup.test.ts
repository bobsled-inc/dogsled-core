import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createEngine: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('../../src/runtime/file-storage-client.js', () => ({
  createFileStorageClient: mocks.createClient,
}));

vi.mock('../../src/runtime/duckdb-engine.js', () => ({
  DuckDbEngine: { create: mocks.createEngine },
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, mkdtemp: mocks.mkdtemp, rm: mocks.rm };
});

import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { extractFileStorageResource } from '../../src/runtime/file-storage-extractor.js';
import type { StateStore } from '../../src/runtime/state.js';
import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';
import { FakeWritable } from '../helpers/fixtures.js';

const integration = {
  auth_env_vars: ['PRIVATE_UPLOAD_ORIGIN', 'PRIVATE_UPLOAD_SIGNED_URL'],
  spec_version: '1',
  type: 'integration',
  name: 'private_upload',
  source_type: 'vercel_blob',
  connection: { blob_ref: 'attachments/project/object' },
  auth: {
    type: 'signed_url_env',
    url_env: 'PRIVATE_UPLOAD_SIGNED_URL',
    origin_env: 'PRIVATE_UPLOAD_ORIGIN',
  },
} as IntegrationSpec;

const resource = {
  spec_version: '1',
  type: 'resource',
  name: 'uploaded_csv',
  source: { path: 'attachments/project/object', format: 'csv' },
  replication: { method: 'full_refresh' },
  output: {},
} as FileResourceSpec;

function stateStore(state: ExtractorState): StateStore {
  return {
    load: vi.fn(async () => state),
    save: vi.fn(async () => undefined),
  };
}

function options(): Parameters<typeof extractFileStorageResource>[0] {
  const state: ExtractorState = { streams: {} };
  return {
    integration,
    resource,
    integrationName: 'private_upload',
    emitter: new Emitter('stdout', 'output', { stdoutStream: new FakeWritable() }),
    logger: new ControlLogger({ stream: new FakeWritable() }),
    state,
    stateStore: stateStore(state),
  };
}

describe('file storage extractor setup cleanup', () => {
  let client: { close: ReturnType<typeof vi.fn> };
  let engine: { close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    client = { close: vi.fn(async () => undefined) };
    engine = { close: vi.fn(async () => undefined) };
    mocks.createClient.mockResolvedValue(client);
    mocks.createEngine.mockResolvedValue(engine);
    mocks.mkdtemp.mockResolvedValue('/tmp/bobsled-file-source-test');
    mocks.rm.mockResolvedValue(undefined);
  });

  it('closes the client when DuckDB engine setup fails', async () => {
    const error = new Error('engine initialization failed');
    mocks.createEngine.mockRejectedValueOnce(error);

    await expect(extractFileStorageResource(options())).rejects.toBe(error);

    expect(client.close).toHaveBeenCalledOnce();
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it('closes the engine and client when staging directory setup fails', async () => {
    const error = new Error('staging directory failed');
    mocks.mkdtemp.mockRejectedValueOnce(error);

    await expect(extractFileStorageResource(options())).rejects.toBe(error);

    expect(engine.close).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(mocks.rm).not.toHaveBeenCalled();
  });
});
