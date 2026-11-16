import { describe, expect, it } from 'vitest';

import { buildCursorQuery } from '../../../src/sync/cursor-query.js';
import type { SyncSpec } from '../../../src/sync/spec.js';

function spec(): SyncSpec {
  return {
    spec_version: '1',
    type: 'sync',
    name: 'contacts_to_webhook',
    tags: [],
    source: {
      type: 'projection',
      connection: 'warehouse_prod',
      projection_ref: 'mart.contacts_projection',
      cursor: {
        field: 'observed_at',
        tie_breaker_fields: ['entity_id'],
        initial_value: '1970-01-01T00:00:00.000Z',
      },
      filters: { readiness_status: 'eligible' },
    },
    target: {
      action: 'webhook/notify_contact',
      entity_key: { fields: ['email'] },
    },
    options: {
      state_backend: 'local',
      checkpoint_interval_records: 100,
      page_size: 500,
      on_record_error: 'skip',
      consecutive_failure_threshold: 10,
      lease_ttl_seconds: 900,
    },
  };
}

describe('buildCursorQuery', () => {
  it('uses placeholders for DuckDB values', () => {
    const query = buildCursorQuery({
      spec: spec(),
      dialect: 'duckdb',
      cursorValue: "'; DROP TABLE contacts; --",
      tieBreakerValues: ['ent_1'],
      limit: 50,
    });

    expect(query.sql).toContain('"mart"."contacts_projection"');
    expect(query.sql).toContain('"observed_at" > ?');
    expect(query.sql).toContain('"readiness_status" = ?');
    expect(query.sql).not.toContain('DROP TABLE');
    expect(query.params).toEqual([
      "'; DROP TABLE contacts; --",
      "'; DROP TABLE contacts; --",
      'ent_1',
      'eligible',
      50,
    ]);
    expect(query.sql.match(/\?/g)).toHaveLength((query.params as unknown[]).length);
  });

  it('uses numbered placeholders for Postgres', () => {
    const query = buildCursorQuery({
      spec: spec(),
      dialect: 'postgres',
      cursorValue: '2026-01-01',
      tieBreakerValues: ['ent_1'],
      limit: 10,
    });

    expect(query.sql).toContain('"observed_at" > $1');
    expect(query.sql).toContain('"entity_id" > $2');
    expect(query.sql).toContain('LIMIT $4');
    expect(query.params).toEqual(['2026-01-01', 'ent_1', 'eligible', 10]);
  });

  it('uses named BigQuery parameters', () => {
    const query = buildCursorQuery({
      spec: spec(),
      dialect: 'bigquery',
      cursorValue: '2026-01-01',
      tieBreakerValues: ['ent_1'],
      limit: 10,
    });

    expect(query.sql).toContain('`observed_at` > @p0');
    expect(query.params).toEqual({
      p0: '2026-01-01',
      p1: 'ent_1',
      p2: 'eligible',
      p3: 10,
    });
  });
});

describe('sync cursor values from DuckDB', () => {
  it('reads DuckDB timestamp value objects as text', async () => {
    const { getRowValue } = await import('../../../src/sync/run.js');
    class DuckDBTimestampValue {
      constructor(private readonly text: string) {}
      toString(): string {
        return this.text;
      }
    }
    expect(
      getRowValue({ observed_at: new DuckDBTimestampValue('2026-01-01 10:00:00') }, 'observed_at')
    ).toBe('2026-01-01 10:00:00');
    expect(() => getRowValue({ observed_at: { nested: true } }, 'observed_at')).toThrow(
      'produced a non-scalar value'
    );
  });

  it('still rejects DuckDB list and struct values as cursors', async () => {
    const { getRowValue } = await import('../../../src/sync/run.js');
    class DuckDBListValue {
      toString(): string {
        return '[1, 2]';
      }
    }
    expect(() => getRowValue({ observed_at: new DuckDBListValue() }, 'observed_at')).toThrow(
      'produced a non-scalar value'
    );
  });
});

describe('buildCursorQuery identifier hardening', () => {
  it.each(['bigquery', 'databricks'] as const)(
    'rejects backslashes in %s identifiers before building SQL',
    (dialect) => {
      const hostile = spec();
      hostile.source.cursor.field = 'x\\` > 0; DROP TABLE t; --';
      expect(() =>
        buildCursorQuery({ spec: hostile, dialect, cursorValue: 'v', limit: 10 })
      ).toThrow('backslashes and control characters are not allowed');
    }
  );
});

describe('buildCursorQuery BigQuery backticks', () => {
  it('rejects backticks in BigQuery identifiers and doubles them for Databricks', () => {
    const hostile = spec();
    hostile.source.cursor.field = 'a`b';
    expect(() =>
      buildCursorQuery({ spec: hostile, dialect: 'bigquery', cursorValue: 'v', limit: 10 })
    ).toThrow('backticks are not allowed');
    expect(
      buildCursorQuery({ spec: hostile, dialect: 'databricks', cursorValue: 'v', limit: 10 }).sql
    ).toContain('`a``b`');
  });
});
