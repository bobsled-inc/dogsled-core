import { describe, expect, it, vi } from 'vitest';
import {
  agenticSelfTableExists,
  agenticSelfTableProbe,
} from '../../../src/runtime/agentic-self-table.js';
import type { SupportedDialect } from '@bobsled-inc/model-spec';

describe('self source existence probe', () => {
  it.each([
    [
      'duckdb',
      'main.people',
      "information_schema.TABLES WHERE table_catalog = current_database() AND lower(table_schema) = lower('main') AND lower(table_name) = lower('people')",
    ],
    [
      'postgres',
      'public.people',
      "information_schema.TABLES WHERE table_schema = 'public' AND table_name = 'people'",
    ],
    [
      'snowflake',
      'DB.PUBLIC.PEOPLE',
      "\"DB\".information_schema.TABLES WHERE table_schema = 'PUBLIC' AND table_name = 'PEOPLE'",
    ],
    [
      'bigquery',
      '`project.dataset`.people',
      "`project`.`dataset`.INFORMATION_SCHEMA.TABLES WHERE table_schema = 'dataset' AND table_name = 'people'",
    ],
    [
      'databricks',
      'catalog.main.people',
      "`catalog`.information_schema.TABLES WHERE table_schema = 'main' AND table_name = 'people'",
    ],
  ])('builds bounded %s metadata SQL', (dialect, target, expected) => {
    expect(agenticSelfTableProbe(target, dialect as SupportedDialect)).toBe(
      `SELECT table_type FROM ${expected} LIMIT 2`
    );
  });
  it.each(['main.people; DROP TABLE x', 'main.people.', 'people', 'a.b.c.d'])(
    'rejects invalid target %s',
    (target) => {
      expect(() => agenticSelfTableProbe(target, 'duckdb')).toThrow();
    }
  );
  it('distinguishes missing tables from existing tables and invalid metadata', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ TABLE_TYPE: 'BASE TABLE' }])
      .mockResolvedValueOnce([{ table_type: 'VIEW' }])
      .mockResolvedValueOnce([{}, {}])
      .mockRejectedValueOnce(new Error('metadata denied'));
    const signal = new AbortController().signal;
    expect(await agenticSelfTableExists(query, 'main.people', 'duckdb', signal)).toBe(false);
    expect(await agenticSelfTableExists(query, 'main.people', 'duckdb', signal)).toBe(true);
    await expect(agenticSelfTableExists(query, 'main.people', 'duckdb', signal)).rejects.toThrow(
      'base table'
    );
    await expect(agenticSelfTableExists(query, 'main.people', 'duckdb', signal)).rejects.toThrow(
      'base table'
    );
    await expect(agenticSelfTableExists(query, 'main.people', 'duckdb', signal)).rejects.toThrow(
      'metadata denied'
    );
  });
});
