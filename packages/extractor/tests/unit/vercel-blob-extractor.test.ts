import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../src/runtime/emitter.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { ExtractorDataError } from '../../src/runtime/errors.js';
import { extractFileStorageResource } from '../../src/runtime/file-storage-extractor.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
}));

vi.mock('../../src/runtime/file-storage-client.js', () => ({
  createFileStorageClient: vi.fn(async () => ({
    list: async function* () {
      yield { path: 'attachments/project/object', uri: 'vercel-blob://attachments/project/object' };
    },
    download: mocks.download,
    close: vi.fn(async () => undefined),
  })),
}));

describe('single-object Vercel Blob extraction', () => {
  beforeEach(() => {
    mocks.download.mockReset();
  });

  it('fails the run when the known private object is missing', async () => {
    mocks.download.mockRejectedValueOnce(
      new ExtractorDataError('Vercel Blob object was not found')
    );
    const stdout = new FakeWritable();
    const state: ExtractorState = { streams: {} };
    await expect(
      extractFileStorageResource({
        integration: {
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
        } as IntegrationSpec,
        resource: {
          spec_version: '1',
          type: 'resource',
          name: 'uploaded_csv',
          source: { path: 'attachments/project/object', format: 'csv' },
          replication: { method: 'full_refresh' },
          output: {},
        } as FileResourceSpec,
        integrationName: 'private_upload',
        emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
        logger: new ControlLogger({ stream: new FakeWritable() }),
        state,
        stateStore: { load: vi.fn(async () => state), save: vi.fn(async () => undefined) },
      })
    ).rejects.toThrow('Vercel Blob object was not found');
    expect(stdout.chunks).toHaveLength(0);
  });

  it('enforces the resource size limit after an unknown-size object downloads', async () => {
    mocks.download.mockResolvedValueOnce({
      file: { path: 'attachments/project/object', uri: 'vercel-blob://attachments/project/object' },
      path: '/tmp/staged.csv',
      bytes_downloaded: 5,
    });
    const stdout = new FakeWritable();
    const state: ExtractorState = { streams: {} };
    await expect(
      extractFileStorageResource({
        integration: {
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
        } as IntegrationSpec,
        resource: {
          spec_version: '1',
          type: 'resource',
          name: 'uploaded_csv',
          source: { path: 'attachments/project/object', format: 'csv' },
          limits: { max_file_size_bytes: 4 },
          replication: { method: 'full_refresh' },
          output: {},
        } as FileResourceSpec,
        integrationName: 'private_upload',
        emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
        logger: new ControlLogger({ stream: new FakeWritable() }),
        state,
        stateStore: { load: vi.fn(async () => state), save: vi.fn(async () => undefined) },
      })
    ).rejects.toThrow(/max_file_size_bytes/);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(stdout.chunks).toHaveLength(0);
  });
});
