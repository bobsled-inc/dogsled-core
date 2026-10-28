import { describe, expect, it } from 'vitest';

import {
  COLUMN_TYPES,
  CURSOR_TYPES,
  LOAD_STRATEGIES,
  PROGRESS_EVENTS,
  PROTOCOL_VERSION,
  isColumnType,
  isLoadStrategy,
  isCursorType,
  parseRequiredStdoutMessage,
  parseStderrMessage,
  parseStdoutMessage,
} from '../../src/index.js';

import type { ProgressMessage, SchemaMessage, StateMessage } from '../../src/index.js';

const schemaMessage = {
  _v: PROTOCOL_VERSION,
  type: 'SCHEMA',
  stream: 'items',
  schema: {
    columns: [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'updated_at', type: 'timestamp' },
      { name: 'partitioned_at', type: 'timestamp' },
    ],
  },
  key_properties: ['id'],
  load_strategy: 'merge',
  cursor_field: 'updated_at',
  partition_by: 'partitioned_at',
  schema_behavior: 'strict',
} satisfies SchemaMessage;

describe('contract regressions', () => {
  it('preserves SCHEMA optional fields during parse/round-trip', () => {
    const parsed = parseRequiredStdoutMessage(JSON.parse(JSON.stringify(schemaMessage)));

    expect(parsed).toEqual(schemaMessage);
  });

  it('accepts a minimal SCHEMA message without optional fields', () => {
    const parsed = parseRequiredStdoutMessage({
      _v: PROTOCOL_VERSION,
      type: 'SCHEMA',
      stream: 'items',
      schema: {
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
      key_properties: ['id'],
      load_strategy: 'append',
    });

    expect(parsed).toEqual({
      _v: PROTOCOL_VERSION,
      type: 'SCHEMA',
      stream: 'items',
      schema: {
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
      key_properties: ['id'],
      load_strategy: 'append',
    });
  });

  it('rejects partition_by that does not reference a declared column', () => {
    expect(() =>
      parseStdoutMessage({
        ...schemaMessage,
        partition_by: 'missing_column',
      })
    ).toThrow('partition_by "missing_column" is not a valid column name');
  });

  it('accepts every supported STATE cursor type including lsn', () => {
    for (const cursorType of CURSOR_TYPES) {
      const message = {
        _v: PROTOCOL_VERSION,
        type: 'STATE',
        stream: 'items',
        value: {
          cursor_field: 'bookmark',
          cursor_type: cursorType,
          cursor_value: 'cursor-value',
          record_count: 1,
        },
      } satisfies StateMessage;

      expect(parseRequiredStdoutMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
      expect(isCursorType(cursorType)).toBe(true);
    }
  });

  it('rejects unknown STATE cursor types', () => {
    expect(() =>
      parseRequiredStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'STATE',
        stream: 'items',
        value: {
          cursor_type: 'wal_position',
          record_count: 1,
        },
      })
    ).toThrow('STATE message value.cursor_type must be one of');

    expect(isCursorType('wal_position')).toBe(false);
  });

  it('rejects unknown PROGRESS event names from runtime JSON payloads', () => {
    expect(() =>
      parseStderrMessage({
        _v: PROTOCOL_VERSION,
        type: 'PROGRESS',
        event: 'unknown_event',
        timestamp: '2026-04-15T16:00:00.000Z',
      })
    ).toThrow('PROGRESS message event must be one of');
  });

  it('accepts all declared PROGRESS event names', () => {
    for (const event of PROGRESS_EVENTS) {
      const message = {
        _v: PROTOCOL_VERSION,
        type: 'PROGRESS',
        event,
        resource: 'items',
        timestamp: '2026-04-15T16:00:00.000Z',
        data: { count: 1 },
      } satisfies ProgressMessage;

      expect(parseStderrMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  it('keeps column and load strategy guards exhaustive', () => {
    for (const type of COLUMN_TYPES) {
      expect(isColumnType(type)).toBe(true);
    }
    expect(isColumnType('varchar')).toBe(false);

    for (const strategy of LOAD_STRATEGIES) {
      expect(isLoadStrategy(strategy)).toBe(true);
    }
    expect(isLoadStrategy('upsert')).toBe(false);
  });

  it('preserves nullable stdout parsing for unsupported message types', () => {
    expect(
      parseStdoutMessage({
        _v: PROTOCOL_VERSION,
        type: 'LOG',
        level: 'info',
        message: 'ignored on stdout',
        time: '2026-04-15T16:00:00.000Z',
      })
    ).toBeNull();
  });
});
