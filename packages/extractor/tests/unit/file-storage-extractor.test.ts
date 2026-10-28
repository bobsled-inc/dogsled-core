import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../src/runtime/emitter.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { extractFileStorageResource } from '../../src/runtime/file-storage-extractor.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';
import type { StateStore } from '../../src/runtime/state.js';

function createStateStore(state: ExtractorState): StateStore {
  return {
    load: vi.fn().mockResolvedValue(state),
    save: vi.fn().mockImplementation(async (next: ExtractorState) => {
      state.streams = next.streams;
    }),
  };
}

function resource(): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'customers',
    description: '',
    input: {},
    source: {
      path: '*.csv',
      format: 'csv',
      options: { header: true },
      include_file_metadata: true,
    },
    replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
    extract: {},
    output: {
      id: { type: 'integer' },
      name: { type: 'string' },
      _file_path: { type: 'string' },
      _file_uri: { type: 'string' },
      _file_modified_at: { type: 'timestamp' },
      _file_etag: { type: 'string' },
      _file_size: { type: 'integer' },
    },
  };
}

describe('file storage extractor', () => {
  it('emits schema once, records with metadata, and durable file state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'file-source-test-'));
    await writeFile(path.join(dir, 'a.csv'), 'id,name\n1,Ada\n');
    await writeFile(path.join(dir, 'b.csv'), 'id,name\n2,Grace\n');

    const stdout = new FakeWritable();
    const stderr = new FakeWritable();
    const state: ExtractorState = { streams: {} };
    const result = await extractFileStorageResource({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'local_exports',
        source_type: 'local',
        connection: { base_directory: dir },
        auth: { type: 'none' },
      } as IntegrationSpec,
      resource: resource(),
      integrationName: 'local_exports',
      emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
      logger: new ControlLogger({ stream: stderr }),
      state,
      stateStore: createStateStore(state),
      advanceState: true,
    });

    const messages = stdout.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages.filter((message) => message.type === 'SCHEMA')).toHaveLength(1);
    expect(messages.filter((message) => message.type === 'RECORD')).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ type: 'STATE', stream: 'customers' });
    expect(result.recordCount).toBe(2);
    expect(Object.keys(state.streams['local_exports/customers']?.files ?? {})).toHaveLength(2);
    expect(messages.find((message) => message.type === 'RECORD')?.record).toHaveProperty(
      '_file_uri'
    );
  });

  it('skips unchanged files unless full refresh is requested', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'file-source-test-'));
    const filePath = path.join(dir, 'a.csv');
    await writeFile(filePath, 'id,name\n1,Ada\n');

    const firstStdout = new FakeWritable();
    const state: ExtractorState = { streams: {} };
    await extractFileStorageResource({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'local_exports',
        source_type: 'local',
        connection: { base_directory: dir },
        auth: { type: 'none' },
      } as IntegrationSpec,
      resource: resource(),
      integrationName: 'local_exports',
      emitter: new Emitter('stdout', 'output', { stdoutStream: firstStdout }),
      logger: new ControlLogger({ stream: new FakeWritable() }),
      state,
      stateStore: createStateStore(state),
      advanceState: true,
    });

    const secondStdout = new FakeWritable();
    const second = await extractFileStorageResource({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'local_exports',
        source_type: 'local',
        connection: { base_directory: dir },
        auth: { type: 'none' },
      } as IntegrationSpec,
      resource: resource(),
      integrationName: 'local_exports',
      emitter: new Emitter('stdout', 'output', { stdoutStream: secondStdout }),
      logger: new ControlLogger({ stream: new FakeWritable() }),
      state,
      stateStore: createStateStore(state),
      advanceState: true,
    });

    expect(second.recordCount).toBe(0);
    expect(
      secondStdout.chunks.map((chunk) => JSON.parse(chunk)).filter((m) => m.type === 'RECORD')
    ).toHaveLength(0);

    const refreshStdout = new FakeWritable();
    const refreshed = await extractFileStorageResource({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'local_exports',
        source_type: 'local',
        connection: { base_directory: dir },
        auth: { type: 'none' },
      } as IntegrationSpec,
      resource: resource(),
      integrationName: 'local_exports',
      emitter: new Emitter('stdout', 'output', { stdoutStream: refreshStdout }),
      logger: new ControlLogger({ stream: new FakeWritable() }),
      state,
      stateStore: createStateStore(state),
      advanceState: true,
      fullRefresh: true,
    });

    expect(refreshed.recordCount).toBe(1);
    expect(
      refreshStdout.chunks.map((chunk) => JSON.parse(chunk)).filter((m) => m.type === 'RECORD')
    ).toHaveLength(1);
  });

  it('rereads unchanged files when the resource replicates with full_refresh', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'file-source-test-'));
    await writeFile(path.join(dir, 'a.csv'), 'id,name\n1,Ada\n');
    const state: ExtractorState = { streams: {} };
    const fullRefreshResource = {
      ...resource(),
      replication: { method: 'full_refresh' as const },
    };
    const run = async () => {
      const stdout = new FakeWritable();
      const result = await extractFileStorageResource({
        integration: {
          spec_version: '1',
          type: 'integration',
          name: 'local_exports',
          source_type: 'local',
          connection: { base_directory: dir },
          auth: { type: 'none' },
        } as IntegrationSpec,
        resource: fullRefreshResource,
        integrationName: 'local_exports',
        emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
        logger: new ControlLogger({ stream: new FakeWritable() }),
        state,
        stateStore: createStateStore(state),
        advanceState: true,
      });
      return result.recordCount;
    };

    expect(await run()).toBe(1);
    expect(await run()).toBe(1);
  });

  it('skips files that fail to read and continues the extraction', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'file-source-test-'));
    await writeFile(path.join(dir, 'bad.parquet'), 'not a parquet file\n');

    const stdout = new FakeWritable();
    const stderr = new FakeWritable();
    const state: ExtractorState = { streams: {} };
    const parquetResource = {
      ...resource(),
      source: { path: '*.parquet', format: 'parquet', include_file_metadata: true },
      output: {},
    } as FileResourceSpec;

    const result = await extractFileStorageResource({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'local_exports',
        source_type: 'local',
        connection: { base_directory: dir },
        auth: { type: 'none' },
      } as IntegrationSpec,
      resource: parquetResource,
      integrationName: 'local_exports',
      emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
      logger: new ControlLogger({ stream: stderr }),
      state,
      stateStore: createStateStore(state),
      advanceState: true,
    });

    expect(result.recordCount).toBe(0);
    expect(
      stdout.chunks.map((chunk) => JSON.parse(chunk)).filter((m) => m.type === 'RECORD')
    ).toHaveLength(0);
    expect(stderr.chunks.join('')).toContain('Skipping file://');
  });
});
