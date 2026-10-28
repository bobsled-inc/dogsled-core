import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  parseRequiredStdoutMessage,
  parseStderrMessage,
  parseStdoutMessage,
} from '../../src/index.js';

import type {
  MetricMessage,
  ProgressMessage,
  SchemaMessage,
  StdoutMessage,
} from '../../src/index.js';

function roundTripStdout(message: StdoutMessage): StdoutMessage {
  return parseRequiredStdoutMessage(JSON.parse(JSON.stringify(message)));
}

describe('parse round-trips', () => {
  it('round-trips SCHEMA with all optional fields', () => {
    const message = {
      _v: PROTOCOL_VERSION,
      type: 'SCHEMA',
      stream: 'items',
      schema: {
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'updated_at', type: 'timestamp' },
        ],
      },
      key_properties: ['id'],
      load_strategy: 'merge',
      cursor_field: 'updated_at',
      partition_by: 'updated_at',
      schema_behavior: 'evolve',
    } satisfies SchemaMessage;

    expect(roundTripStdout(message)).toEqual(message);
  });

  it('round-trips SCHEMA without optional fields', () => {
    const message = {
      _v: PROTOCOL_VERSION,
      type: 'SCHEMA',
      stream: 'items',
      schema: {
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
      key_properties: ['id'],
      load_strategy: 'append',
    } satisfies SchemaMessage;

    expect(roundTripStdout(message)).toEqual(message);
  });

  it('round-trips RECORD payloads including __proto__ keys', () => {
    const parsed = parseRequiredStdoutMessage(
      JSON.parse(
        '{"_v":1,"type":"RECORD","stream":"items","record":{"__proto__":"kept","nested":{"value":1}},"time_extracted":"2026-04-15T16:00:00.000Z"}'
      )
    );

    expect(parsed).toMatchObject({
      _v: PROTOCOL_VERSION,
      type: 'RECORD',
      stream: 'items',
      record: {
        nested: { value: 1 },
      },
      time_extracted: '2026-04-15T16:00:00.000Z',
    });

    const record = (parsed as Extract<StdoutMessage, { type: 'RECORD' }>).record;
    expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true);
    expect(record['__proto__']).toBe('kept');
  });

  it('round-trips BATCH and STATE messages', () => {
    expect(
      roundTripStdout({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'jsonl', compression: 'gzip' },
        manifest: ['file:///tmp/items-0.jsonl', 'file:///tmp/items-1.jsonl'],
      })
    ).toEqual({
      _v: PROTOCOL_VERSION,
      type: 'BATCH',
      stream: 'items',
      encoding: { format: 'jsonl', compression: 'gzip' },
      manifest: ['file:///tmp/items-0.jsonl', 'file:///tmp/items-1.jsonl'],
    });

    expect(
      roundTripStdout({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'parquet' },
        manifest: ['file:///tmp/items-0.parquet'],
      })
    ).toEqual({
      _v: PROTOCOL_VERSION,
      type: 'BATCH',
      stream: 'items',
      encoding: { format: 'parquet' },
      manifest: ['file:///tmp/items-0.parquet'],
    });

    expect(
      roundTripStdout({
        _v: PROTOCOL_VERSION,
        type: 'STATE',
        stream: 'items',
        value: {
          cursor_field: 'bookmark',
          cursor_type: 'lsn',
          cursor_value: '16/B374D848',
          last_run_at: '2026-04-15T16:00:00.000Z',
          record_count: 4,
        },
      })
    ).toEqual({
      _v: PROTOCOL_VERSION,
      type: 'STATE',
      stream: 'items',
      value: {
        cursor_field: 'bookmark',
        cursor_type: 'lsn',
        cursor_value: '16/B374D848',
        last_run_at: '2026-04-15T16:00:00.000Z',
        record_count: 4,
      },
    });
  });

  it('rejects parquet encodings with jsonl compression fields', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'parquet', compression: 'gzip' },
        manifest: ['file:///tmp/items-0.parquet'],
      })
    ).toThrow('compression is only supported for jsonl encoding');
  });

  it('rejects BATCH messages missing an encoding object', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        manifest: ['file:///tmp/items-0.jsonl'],
      })
    ).toThrow('BATCH message must include an encoding');
  });

  it('rejects BATCH encodings with unknown formats', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'avro' },
        manifest: ['file:///tmp/items-0.avro'],
      })
    ).toThrow('encoding.format must be "jsonl" or "parquet"');
  });

  it('rejects jsonl encodings with unsupported compression values', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'jsonl', compression: 'zstd' },
        manifest: ['file:///tmp/items-0.jsonl.zst'],
      })
    ).toThrow('compression must be gzip when provided');
  });

  it('rejects BATCH messages with non-file:// manifest URIs', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'parquet' },
        manifest: ['https://evil.example.com/items-0.parquet'],
      })
    ).toThrow('manifest entry 0 must be a file:// URI');
  });

  it('rejects BATCH messages with non-string manifest entries', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'BATCH',
        stream: 'items',
        encoding: { format: 'jsonl' },
        manifest: [123],
      })
    ).toThrow('manifest of file URIs');
  });

  it('round-trips stderr LOG, METRIC, and PROGRESS messages', () => {
    expect(
      parseStderrMessage({
        _v: PROTOCOL_VERSION,
        type: 'LOG',
        level: 'info',
        message: 'hello',
        time: '2026-04-15T16:00:00.000Z',
      })
    ).toEqual({
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'hello',
      time: '2026-04-15T16:00:00.000Z',
    });

    const metric = {
      _v: PROTOCOL_VERSION,
      type: 'METRIC',
      stream: 'items',
      metrics: {
        records_emitted: 2,
        api_calls: 1,
        duration_ms: 25,
        files_listed: 3,
        files_skipped: 1,
        files_processed: 2,
        bytes_downloaded: 4096,
        estimate_confidence: 'exact',
        // Document-extraction metrics. Without these in the
        // numericFields whitelist they'd be silently dropped.
        documents_emitted: 2,
        chunks_emitted: 8,
        parse_errors_emitted: 1,
      },
      time: '2026-04-15T16:00:00.000Z',
    } satisfies MetricMessage;
    expect(parseStderrMessage(JSON.parse(JSON.stringify(metric)))).toEqual(metric);

    const progress = {
      _v: PROTOCOL_VERSION,
      type: 'PROGRESS',
      event: 'resource_complete',
      resource: 'items',
      timestamp: '2026-04-15T16:00:00.000Z',
      data: { duration_ms: 10 },
    } satisfies ProgressMessage;
    expect(parseStderrMessage(JSON.parse(JSON.stringify(progress)))).toEqual(progress);
  });

  it('round-trips LOG with optional event + attributes', () => {
    const log = {
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'extracted',
      time: '2026-05-06T16:00:00.000Z',
      event: 'extraction_completed',
      attributes: { resource: 'docs', documents_emitted: 12, chunks_emitted: 87 },
    };
    expect(parseStderrMessage(JSON.parse(JSON.stringify(log)))).toEqual(log);
  });

  it('LOG event="" is dropped (empty string is treated as absent)', () => {
    const result = parseStderrMessage({
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'x',
      time: '2026-05-06T16:00:00.000Z',
      event: '',
    });
    expect(result).toBeTruthy();
    expect((result as { event?: string }).event).toBeUndefined();
  });

  it('LOG attributes that are not plain objects are dropped', () => {
    const arrayResult = parseStderrMessage({
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'x',
      time: '2026-05-06T16:00:00.000Z',
      attributes: ['not', 'an', 'object'],
    });
    expect((arrayResult as { attributes?: unknown }).attributes).toBeUndefined();

    const nullResult = parseStderrMessage({
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'x',
      time: '2026-05-06T16:00:00.000Z',
      attributes: null,
    });
    expect((nullResult as { attributes?: unknown }).attributes).toBeUndefined();

    // Date is `typeof === 'object'` but not a JsonObject — must be rejected.
    const dateResult = parseStderrMessage({
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'x',
      time: '2026-05-06T16:00:00.000Z',
      attributes: new Date(),
    });
    expect((dateResult as { attributes?: unknown }).attributes).toBeUndefined();

    // Class instances / prototype-bearing objects are also not JsonObjects.
    class CustomAttrs {
      foo = 1;
    }
    const protoResult = parseStderrMessage({
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level: 'info',
      message: 'x',
      time: '2026-05-06T16:00:00.000Z',
      attributes: new CustomAttrs(),
    });
    expect((protoResult as { attributes?: unknown }).attributes).toBeUndefined();
  });

  it('returns null for unknown stdout message types', () => {
    expect(
      parseStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'UNKNOWN',
      })
    ).toBeNull();
  });

  it('throws for required stdout parsing and invalid envelopes', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'UNKNOWN',
      })
    ).toThrow('Unsupported stdout message type "UNKNOWN"');

    expect(() =>
      parseRequiredStdoutMessage({
        type: 'RECORD',
        stream: 'items',
        record: { id: 1 },
        time_extracted: '2026-04-15T16:00:00.000Z',
      })
    ).toThrow('Unsupported protocol version');

    expect(() =>
      parseRequiredStdoutMessage({
        _v: 2,
        type: 'RECORD',
        stream: 'items',
        record: { id: 1 },
        time_extracted: '2026-04-15T16:00:00.000Z',
      })
    ).toThrow('Unsupported protocol version');

    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'RECORD',
        stream: 'items',
        record: { id: 1 },
      })
    ).toThrow('RECORD message must include time_extracted');
  });

  it('rejects non-JSON-safe record and progress payloads', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'RECORD',
        stream: 'items',
        record: { created_at: new Date('2026-04-15T16:00:00.000Z') },
        time_extracted: '2026-04-15T16:00:00.000Z',
      })
    ).toThrow('RECORD message must include a JSON-safe record object');

    expect(() =>
      parseStderrMessage({
        _v: PROTOCOL_VERSION,
        type: 'PROGRESS',
        event: 'resource_complete',
        timestamp: '2026-04-15T16:00:00.000Z',
        data: { started_at: new Date('2026-04-15T16:00:00.000Z') },
      })
    ).toThrow('PROGRESS message data must be a JSON-safe object when provided');
  });
});
