import { describe, expect, it } from 'vitest';

import { resolveSourceEntry, type SourceRegistryEntry } from '../../../src/compiler/parser.js';
import { SourceSpecSchema } from '../../../src/compiler/schemas.js';

const base = {
  spec_version: '0.2',
  name: 'issues',
  type: 'source',
  source_type: 'api_resource',
  integration: 'github',
  resource: 'issues',
  connection: 'github_prod',
  schema: {
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'title', type: 'STRING' },
    ],
  },
};

describe('SourceSpecSchema — api_resource', () => {
  it('parses minimal spec with implicit lazy mode', () => {
    const result = SourceSpecSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success && result.data.source_type === 'api_resource') {
      expect(result.data.mode).toBeUndefined();
    }
  });

  it('parses mode: live', () => {
    expect(SourceSpecSchema.safeParse({ ...base, mode: 'live' }).success).toBe(true);
  });

  it('parses mode: extract', () => {
    expect(SourceSpecSchema.safeParse({ ...base, mode: 'extract' }).success).toBe(true);
  });

  it('parses mode: lazy with max_age, destination, and filter', () => {
    const result = SourceSpecSchema.safeParse({
      ...base,
      mode: 'lazy',
      max_age: '15m',
      filter: { state: 'open' },
      destination: { schema: 'sources_raw' },
    });
    expect(result.success).toBe(true);
  });

  it('parses deprecated mode: cache as lazy', () => {
    const result = SourceSpecSchema.safeParse({ ...base, mode: 'cache' });
    expect(result.success).toBe(true);
    if (result.success && result.data.source_type === 'api_resource') {
      expect(result.data.mode).toBe('lazy');
    }
  });

  it('rejects invalid mode values', () => {
    expect(SourceSpecSchema.safeParse({ ...base, mode: 'foo' }).success).toBe(false);
  });

  it('parses refresh strategies for api resources', () => {
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'merge', cursor_field: 'updated_at', primary_key: 'id' },
      }).success
    ).toBe(true);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'merge', cursor_field: 'updated_at', primary_key: ['id'] },
      }).success
    ).toBe(true);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'append', cursor_field: 'created_at' },
      }).success
    ).toBe(true);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'full_refresh' },
      }).success
    ).toBe(true);
  });

  it('validates refresh strategy requirements', () => {
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'merge', cursor_field: 'updated_at' },
      }).success
    ).toBe(false);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'merge', primary_key: 'id' },
      }).success
    ).toBe(false);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'append' },
      }).success
    ).toBe(false);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'full_refresh', cursor_field: 'updated_at' },
      }).success
    ).toBe(false);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'full_refresh', primary_key: 'id' },
      }).success
    ).toBe(false);
    expect(
      SourceSpecSchema.safeParse({
        ...base,
        refresh: { strategy: 'merge', cursor_field: 'updated_at', primary_key: 'bad-key' },
      }).success
    ).toBe(false);
  });

  it('rejects unknown destination keys', () => {
    expect(SourceSpecSchema.safeParse({ ...base, destination: { handle: 'x' } }).success).toBe(
      false
    );
  });

  it('validates max_age grammar', () => {
    for (const value of ['30s', '15m', '2h', '1d']) {
      expect(SourceSpecSchema.safeParse({ ...base, max_age: value }).success).toBe(true);
    }
    for (const value of ['', '1w', '15 minutes']) {
      expect(SourceSpecSchema.safeParse({ ...base, max_age: value }).success).toBe(false);
    }
  });

  it('warehouse_table continues to parse', () => {
    expect(
      SourceSpecSchema.safeParse({
        spec_version: '0.2',
        name: 'raw',
        type: 'source',
        source_type: 'warehouse_table',
        connection: 'ecom',
        table: 'RAW.X',
        schema: { columns: [{ name: 'ID', type: 'NUMBER' }] },
      }).success
    ).toBe(true);
  });
});

describe('resolveSourceEntry', () => {
  it('carries protocol-compatible columns and mode', () => {
    const spec = SourceSpecSchema.parse({
      ...base,
      mode: 'live',
      filter: { state: 'open' },
      max_age: '15m',
      refresh: { strategy: 'merge', cursor_field: 'updated_at', primary_key: 'id' },
    });
    const entry: SourceRegistryEntry = resolveSourceEntry(spec);
    expect(entry.kind).toBe('api_resource');
    if (entry.kind === 'api_resource') {
      expect(entry.mode).toBe('live');
      expect(entry.refresh).toEqual({
        strategy: 'merge',
        cursor_field: 'updated_at',
        primary_key: 'id',
      });
      expect(entry.columns).toEqual([
        { name: 'id', sqlType: 'INTEGER', type: 'integer' },
        { name: 'title', sqlType: 'STRING', type: 'string' },
      ]);
      expect(entry.fqRef).toBe('sources.issues');
    }
  });

  it('normalizes common warehouse type spellings without rejecting source specs', () => {
    const spec = SourceSpecSchema.parse({
      spec_version: '0.2',
      name: 'raw_events',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'warehouse',
      table: 'RAW.EVENTS',
      schema: {
        columns: [
          { name: 'bigquery_id', type: 'INT64' },
          { name: 'amount', type: 'DECIMAL(10,2)' },
          { name: 'description', type: 'TEXT' },
          { name: 'score', type: 'FLOAT64' },
          { name: 'seen_at', type: 'TIMESTAMPTZ' },
          { name: 'snowflake_seen_at', type: 'TIMESTAMP_NTZ(9)' },
          { name: 'payload', type: 'VARIANT' },
          { name: 'tags', type: 'ARRAY<STRING>' },
          { name: 'unknown_vendor_type', type: 'SUPER_SPECIAL' },
        ],
      },
    });

    const entry = resolveSourceEntry(spec);

    expect(entry.kind).toBe('warehouse_table');
    expect(entry.columns).toEqual([
      { name: 'bigquery_id', sqlType: 'INT64', type: 'integer' },
      { name: 'amount', sqlType: 'DECIMAL(10,2)', type: 'number' },
      { name: 'description', sqlType: 'TEXT', type: 'string' },
      { name: 'score', sqlType: 'FLOAT64', type: 'number' },
      { name: 'seen_at', sqlType: 'TIMESTAMPTZ', type: 'timestamp' },
      { name: 'snowflake_seen_at', sqlType: 'TIMESTAMP_NTZ(9)', type: 'timestamp' },
      { name: 'payload', sqlType: 'VARIANT', type: 'object' },
      { name: 'tags', sqlType: 'ARRAY<STRING>', type: 'array' },
      { name: 'unknown_vendor_type', sqlType: 'SUPER_SPECIAL', type: 'string' },
    ]);
  });
});
