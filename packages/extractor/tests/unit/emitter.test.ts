import { describe, expect, it } from 'vitest';

import { Emitter } from '../../src/runtime/emitter.js';
import { buildSchemaMessage } from '../../src/runtime/schema-message.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { Writable } from 'node:stream';

describe('Emitter', () => {
  it('emits SCHEMA, RECORD, and STATE messages to stdout', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema({
      spec_version: '1',
      name: 'issues',
      type: 'resource' as const,
      integration: 'github',
      description: 'Issues',
      api: {
        endpoint: '/issues',
        method: 'GET',
      },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
        title: { type: 'string', path: '$.title' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
        },
      },
    });
    await emitter.emitRecord('issues', { id: 1, title: 'Bug fix' }, '2026-03-22T00:00:00.000Z');
    await emitter.emitState('issues', {
      cursor_field: 'updated_at',
      cursor_value: '2026-03-22T00:00:00.000Z',
      record_count: 1,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages.map((message) => message.type)).toEqual(['SCHEMA', 'RECORD', 'STATE']);
    // No incremental config => default full_refresh
    expect(messages[0].load_strategy).toBe('full_refresh');
    expect(messages[0].key_properties).toEqual(['id']);
  });

  it('derives load_strategy=merge for incremental+PK resources', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema({
      spec_version: '1',
      name: 'issues',
      type: 'resource' as const,
      integration: 'github',
      description: 'Issues',
      api: { endpoint: '/issues', method: 'GET' },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
        updated_at: { type: 'timestamp', path: '$.updated_at' },
      },
      extract: {
        record_path: '$',
        incremental: {
          cursor_field: 'updated_at',
          cursor_param: 'since',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages[0].load_strategy).toBe('merge');
    expect(messages[0].cursor_field).toBe('updated_at');
  });

  it('derives load_strategy=append for incremental without PK', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema({
      spec_version: '1',
      name: 'events',
      type: 'resource' as const,
      integration: 'github',
      description: 'Events',
      api: { endpoint: '/events', method: 'GET' },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
        created_at: { type: 'timestamp', path: '$.created_at' },
      },
      extract: {
        record_path: '$',
        incremental: {
          cursor_field: 'created_at',
          cursor_param: 'since',
        },
      },
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages[0].load_strategy).toBe('append');
    expect(messages[0].cursor_field).toBe('created_at');
  });

  it('derives load_strategy=full_refresh when fullRefresh option is set', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema(
      {
        spec_version: '1',
        name: 'issues',
        type: 'resource' as const,
        integration: 'github',
        description: 'Issues',
        api: { endpoint: '/issues', method: 'GET' },
        input: {},
        output: {
          id: { type: 'integer', path: '$.id' },
          updated_at: { type: 'timestamp', path: '$.updated_at' },
        },
        extract: {
          record_path: '$',
          incremental: {
            cursor_field: 'updated_at',
            cursor_param: 'since',
          },
          table: {
            primary_key: ['id'],
          },
        },
      },
      { fullRefresh: true }
    );

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages[0].load_strategy).toBe('full_refresh');
  });

  it('explicit YAML load_strategy wins over fullRefresh flag', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema(
      {
        spec_version: '1',
        name: 'costs',
        type: 'resource' as const,
        integration: 'vantage',
        description: 'Costs',
        api: { endpoint: '/costs', method: 'GET' },
        input: {},
        output: {
          accrued_at: { type: 'timestamp', path: '$.accrued_at' },
          amount: { type: 'string', path: '$.amount' },
        },
        extract: {
          record_path: '$',
          incremental: {
            strategy: 'filter',
            cursor_field: 'accrued_at',
            cursor_type: 'timestamp',
            since_argument: 'start_date',
            until_argument: 'end_date',
          },
          table: {
            primary_key: ['accrued_at'],
            load_strategy: 'merge',
          },
        },
      },
      { fullRefresh: true }
    );

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages[0].load_strategy).toBe('merge');
  });

  it('emits partition_by from YAML table config', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema({
      spec_version: '1',
      name: 'costs',
      type: 'resource' as const,
      integration: 'vantage',
      description: 'Costs',
      api: { endpoint: '/costs', method: 'GET' },
      input: {},
      output: {
        accrued_at: { type: 'timestamp', path: '$.accrued_at' },
        amount: { type: 'string', path: '$.amount' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['accrued_at'],
          partition_by: 'accrued_at',
        },
      },
    });

    const messages = stdoutStream.chunks.map((chunk: string) => JSON.parse(chunk));
    expect(messages[0].partition_by).toBe('accrued_at');
  });

  it('omits partition_by when it is not configured', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema({
      spec_version: '1',
      name: 'issues',
      type: 'resource' as const,
      integration: 'github',
      description: 'Issues',
      api: { endpoint: '/issues', method: 'GET' },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
        updated_at: { type: 'timestamp', path: '$.updated_at' },
      },
      extract: {
        record_path: '$',
        incremental: {
          cursor_field: 'updated_at',
          cursor_param: 'since',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages[0]).not.toHaveProperty('partition_by');
  });

  it('uses explicit load_strategy from YAML override', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitSchema({
      spec_version: '1',
      name: 'issues',
      type: 'resource' as const,
      integration: 'github',
      description: 'Issues',
      api: { endpoint: '/issues', method: 'GET' },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
      },
      extract: {
        record_path: '$',
        incremental: {
          cursor_field: 'id',
          cursor_param: 'since',
        },
        table: {
          primary_key: ['id'],
          load_strategy: 'append',
        },
      },
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages[0].load_strategy).toBe('append'); // explicit override, not merge
  });

  it('emits the project default schema_behavior when the resource has no load block', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
      defaultSchemaBehavior: 'strict',
    });

    await emitter.emitSchema({
      name: 'issues',
      output: { id: { type: 'integer', path: '$.id' } },
    });

    expect(JSON.parse(stdoutStream.chunks[0]!).schema_behavior).toBe('strict');
  });

  it('lets a resource load block replace the project schema_behavior default', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
      defaultSchemaBehavior: 'strict',
    });

    await emitter.emitSchema({
      name: 'issues',
      output: { id: { type: 'integer', path: '$.id' } },
      load: { defaults: { schema_behavior: 'freeze' } },
    });
    await emitter.emitSchema({
      name: 'events',
      output: { id: { type: 'integer', path: '$.id' } },
      load: {},
    });

    expect(JSON.parse(stdoutStream.chunks[0]!).schema_behavior).toBe('freeze');
    expect(JSON.parse(stdoutStream.chunks[1]!)).not.toHaveProperty('schema_behavior');
  });

  it('waits for stdout drain before writing the next message', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });
    stdoutStream.blockNextWrite();

    const firstWrite = emitter.emitRecord('issues', { id: 1 });
    const secondWrite = emitter.emitRecord('issues', { id: 2 });

    await Promise.all([firstWrite, secondWrite]);

    expect(stdoutStream.chunks).toHaveLength(2);
    expect(stdoutStream.chunks.map((chunk) => JSON.parse(chunk).record.id)).toEqual([1, 2]);
  });

  it('emitBatch writes valid BATCH message with _v, stream, encoding, manifest', async () => {
    const stdoutStream = new FakeWritable();
    const emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });

    await emitter.emitBatch('items', { format: 'jsonl', compression: 'gzip' }, [
      'file:///tmp/batch/items/items-0.jsonl.gz',
    ]);

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      _v: 1,
      type: 'BATCH',
      stream: 'items',
      encoding: { format: 'jsonl', compression: 'gzip' },
      manifest: ['file:///tmp/batch/items/items-0.jsonl.gz'],
    });
  });

  it('waits for file drain when writing JSONL output', async () => {
    const fileStream = new FakeWritable();
    fileStream.blockNextWrite();
    const emitter = new Emitter('file', '/tmp/output', {
      createWriteStream: () => fileStream as unknown as Writable,
    });

    const firstWrite = emitter.emitRecord('issues', { id: 1 });
    const secondWrite = emitter.emitRecord('issues', { id: 2 });

    await Promise.all([firstWrite, secondWrite]);
    await emitter.close();

    expect(fileStream.chunks).toHaveLength(2);
    expect(fileStream.chunks.map((chunk) => JSON.parse(chunk).record.id)).toEqual([1, 2]);
  });
});

describe('buildSchemaMessage for file Resources', () => {
  const fileResource = {
    name: 'events',
    output: { id: { type: 'integer' as const } },
    replication: { method: 'incremental_append' },
  };

  it('appends incremental_append file Resources instead of replacing the table', () => {
    expect(buildSchemaMessage(fileResource).load_strategy).toBe('append');
    expect(
      buildSchemaMessage({ ...fileResource, extract: { table: { primary_key: ['id'] } } })
        .load_strategy
    ).toBe('append');
  });

  it('keeps explicit load_strategy and --full-refresh above the file default', () => {
    expect(buildSchemaMessage(fileResource, { fullRefresh: true }).load_strategy).toBe(
      'full_refresh'
    );
    expect(
      buildSchemaMessage({ ...fileResource, extract: { table: { load_strategy: 'merge' } } })
        .load_strategy
    ).toBe('merge');
  });

  it('keeps full_refresh file Resources as full_refresh', () => {
    expect(
      buildSchemaMessage({ ...fileResource, replication: { method: 'full_refresh' } }).load_strategy
    ).toBe('full_refresh');
  });
});
