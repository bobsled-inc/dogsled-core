import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { MAX_PROTOCOL_LINE_BYTES, readProtocol } from '../../src/runtime/protocol-reader.js';

import { CommandError, type StdoutMessage } from '@bobsled-inc/protocol';

async function collectProtocol(lines: string[]): Promise<StdoutMessage[]> {
  const messages: StdoutMessage[] = [];

  for await (const message of readProtocol(Readable.from(lines))) {
    messages.push(message);
  }

  return messages;
}

async function collectFromBuffer(buffer: Buffer): Promise<StdoutMessage[]> {
  const messages: StdoutMessage[] = [];
  for await (const message of readProtocol(Readable.from(buffer))) {
    messages.push(message);
  }
  return messages;
}

async function collectFromChunks(chunks: Buffer[]): Promise<StdoutMessage[]> {
  const messages: StdoutMessage[] = [];
  const readable = new Readable({
    read() {
      for (const chunk of chunks) {
        this.push(chunk);
      }
      this.push(null);
    },
  });
  for await (const message of readProtocol(readable)) {
    messages.push(message);
  }
  return messages;
}

describe('readProtocol', () => {
  it('parses supported stdout messages', async () => {
    const messages = await collectProtocol([
      `${JSON.stringify({
        _v: 1,
        type: 'SCHEMA',
        stream: 'issues',
        schema: { columns: [{ name: 'id', type: 'integer' }] },
        key_properties: ['id'],
        load_strategy: 'merge',
      })}\n`,
      `${JSON.stringify({
        _v: 1,
        type: 'RECORD',
        stream: 'issues',
        record: { id: 1 },
        time_extracted: '2026-03-23T00:00:00.000Z',
      })}\n`,
      '\n',
      `${JSON.stringify({
        _v: 1,
        type: 'STATE',
        stream: 'issues',
        value: { cursor_type: 'integer', record_count: 1 },
      })}\n`,
    ]);

    expect(messages.map((message) => message.type)).toEqual(['SCHEMA', 'RECORD', 'STATE']);
    expect(messages[0]).toMatchObject({
      type: 'SCHEMA',
      stream: 'issues',
      load_strategy: 'merge',
    });
  });

  it('throws on unsupported stdout message types', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'LOG',
          level: 'info',
          message: 'wrong stream',
          time: '2026-03-23T00:00:00.000Z',
        })}\n`,
      ])
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('Unsupported stdout message type "LOG"'),
    } satisfies Partial<CommandError>);
  });

  it('throws on malformed JSON input', async () => {
    await expect(collectProtocol(['{"_v":1,"type":"SCHEMA"\n'])).rejects.toThrow(
      'Invalid JSON on protocol line 1'
    );
  });

  it('throws on invalid protocol payloads', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 2,
          type: 'STATE',
          stream: 'issues',
          value: { record_count: 1 },
        })}\n`,
      ])
    ).rejects.toThrow('Unsupported protocol version');
  });

  it('preserves U+2028 LINE SEPARATOR inside JSON string values', async () => {
    const record = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { text: 'line\u2028separator' },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const line = JSON.stringify(record) + '\n';
    const messages = await collectFromBuffer(Buffer.from(line, 'utf8'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'RECORD',
      record: { text: 'line\u2028separator' },
    });
  });

  it('preserves U+2029 PARAGRAPH SEPARATOR inside JSON string values', async () => {
    const record = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { text: 'para\u2029separator' },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const line = JSON.stringify(record) + '\n';
    const messages = await collectFromBuffer(Buffer.from(line, 'utf8'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'RECORD',
      record: { text: 'para\u2029separator' },
    });
  });

  it('reassembles partial chunks split across buffers', async () => {
    const record = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { id: 1 },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const line = JSON.stringify(record) + '\n';
    const midpoint = Math.floor(line.length / 2);
    const chunk1 = Buffer.from(line.slice(0, midpoint), 'utf8');
    const chunk2 = Buffer.from(line.slice(midpoint), 'utf8');
    const messages = await collectFromChunks([chunk1, chunk2]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'RECORD', record: { id: 1 } });
  });

  it('parses trailing content without a final newline', async () => {
    const record = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { id: 42 },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    // No trailing newline
    const line = JSON.stringify(record);
    const messages = await collectFromBuffer(Buffer.from(line, 'utf8'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'RECORD', record: { id: 42 } });
  });

  it('parses STATE cursor_type when present', async () => {
    const messages = await collectProtocol([
      `${JSON.stringify({
        _v: 1,
        type: 'STATE',
        stream: 'customers_cdc',
        value: {
          cursor_field: '_commit_lsn',
          cursor_type: 'lsn',
          cursor_value: '16/B374D848',
          record_count: 4,
        },
      })}\n`,
    ]);

    expect(messages[0]).toMatchObject({
      type: 'STATE',
      value: {
        cursor_field: '_commit_lsn',
        cursor_type: 'lsn',
        cursor_value: '16/B374D848',
      },
    });
  });

  it('handles messages larger than 64KB', async () => {
    const largeText = 'x'.repeat(70_000);
    const record = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { text: largeText },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const line = JSON.stringify(record) + '\n';
    const messages = await collectFromBuffer(Buffer.from(line, 'utf8'));
    expect(messages).toHaveLength(1);
    expect((messages[0] as { record: { text: string } }).record.text).toHaveLength(70_000);
  });

  it('rejects a fragmented protocol line above the byte limit before EOF', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    const chunks = Array.from(
      { length: Math.floor(MAX_PROTOCOL_LINE_BYTES / chunk.length) + 1 },
      () => chunk
    );

    await expect(collectFromChunks(chunks)).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
      message: expect.stringContaining(`${MAX_PROTOCOL_LINE_BYTES}-byte limit`),
    } satisfies Partial<CommandError>);
  });

  it('incrementally reassembles many chunks without repeated whole-line concatenation', async () => {
    const record = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { text: 'x'.repeat(256_000) },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < encoded.length; offset += 257) {
      chunks.push(encoded.subarray(offset, offset + 257));
    }

    const messages = await collectFromChunks(chunks);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { record: { text: string } }).record.text).toHaveLength(256_000);
  });

  it('skips empty lines between records', async () => {
    const record1 = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { id: 1 },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const record2 = {
      _v: 1,
      type: 'RECORD',
      stream: 'test',
      record: { id: 2 },
      time_extracted: '2026-01-01T00:00:00Z',
    };
    const input = JSON.stringify(record1) + '\n\n\n' + JSON.stringify(record2) + '\n';
    const messages = await collectFromBuffer(Buffer.from(input, 'utf8'));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ record: { id: 1 } });
    expect(messages[1]).toMatchObject({ record: { id: 2 } });
  });

  it('rejects empty column name in SCHEMA', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: '', type: 'string' }] },
          key_properties: [],
          load_strategy: 'append',
        })}\n`,
      ])
    ).rejects.toThrow('column 0 has an empty name');
  });

  it('rejects column name longer than 300 characters', async () => {
    const longName = 'a'.repeat(301);
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: longName, type: 'string' }] },
          key_properties: [],
          load_strategy: 'append',
        })}\n`,
      ])
    ).rejects.toThrow('column 0 name exceeds 300 characters');
  });

  it('rejects column name containing null byte', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: 'foo\0bar', type: 'string' }] },
          key_properties: [],
          load_strategy: 'append',
        })}\n`,
      ])
    ).rejects.toThrow('column 0 name contains a null byte');
  });

  it('rejects invalid STATE cursor_type values', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'STATE',
          stream: 'issues',
          value: { cursor_type: 'wal_position', record_count: 1 },
        })}\n`,
      ])
    ).rejects.toThrow('STATE message value.cursor_type must be one of');
  });

  it('parses SCHEMA with load_strategy and cursor_field', async () => {
    const messages = await collectProtocol([
      `${JSON.stringify({
        _v: 1,
        type: 'SCHEMA',
        stream: 'issues',
        schema: {
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'updated_at', type: 'timestamp' },
          ],
        },
        key_properties: ['id'],
        load_strategy: 'merge',
        cursor_field: 'updated_at',
      })}\n`,
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'SCHEMA',
      load_strategy: 'merge',
      cursor_field: 'updated_at',
    });
  });

  it('preserves partition_by on SCHEMA messages', async () => {
    const messages = await collectProtocol([
      `${JSON.stringify({
        _v: 1,
        type: 'SCHEMA',
        stream: 'issues',
        schema: {
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'updated_at', type: 'timestamp' },
          ],
        },
        key_properties: ['id'],
        load_strategy: 'merge',
        cursor_field: 'updated_at',
        partition_by: 'updated_at',
      })}\n`,
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'SCHEMA',
      cursor_field: 'updated_at',
      partition_by: 'updated_at',
    });
  });

  it('rejects SCHEMA without load_strategy', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: 'id', type: 'integer' }] },
          key_properties: ['id'],
        })}\n`,
      ])
    ).rejects.toThrow('load_strategy');
  });

  it('rejects SCHEMA with invalid load_strategy', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: 'id', type: 'integer' }] },
          key_properties: ['id'],
          load_strategy: 'upsert',
        })}\n`,
      ])
    ).rejects.toThrow('load_strategy');
  });

  it('rejects SCHEMA with non-string cursor_field', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: 'id', type: 'integer' }] },
          key_properties: ['id'],
          load_strategy: 'append',
          cursor_field: 123,
        })}\n`,
      ])
    ).rejects.toThrow('cursor_field must be a string');
  });

  it('rejects SCHEMA with cursor_field referencing unknown column', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'SCHEMA',
          stream: 'issues',
          schema: { columns: [{ name: 'id', type: 'integer' }] },
          key_properties: ['id'],
          load_strategy: 'merge',
          cursor_field: 'nonexistent',
        })}\n`,
      ])
    ).rejects.toThrow('cursor_field "nonexistent" must reference a declared column');
  });

  it('rejects malformed optional protocol fields instead of silently dropping them', async () => {
    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'BATCH',
          stream: 'issues',
          encoding: { format: 'jsonl', compression: 'snappy' },
          manifest: ['file:///tmp/issues-0.jsonl'],
        })}\n`,
      ])
    ).rejects.toThrow('compression must be gzip');

    await expect(
      collectProtocol([
        `${JSON.stringify({
          _v: 1,
          type: 'STATE',
          stream: 'issues',
          value: { record_count: 1, cursor_value: 123 },
        })}\n`,
      ])
    ).rejects.toThrow('cursor_value must be a string');
  });
});
