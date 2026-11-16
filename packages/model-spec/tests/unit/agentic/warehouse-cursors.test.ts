import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationFile } from '@bobsled-inc/connections';
import type { PublicationDialect } from '../../../src/agentic/sql-publication-dialect.js';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
afterEach(() => resolve.mockReset());
const configs: Record<PublicationDialect, IntegrationFile> = {
  postgres: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'test' },
    auth: { type: 'password', user: 'test', password: 'test' },
  },
  snowflake: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'snowflake',
    connection: { account_identifier: 'test', warehouse: 'test', role: 'test', user: 'test' },
    auth: { type: 'pat', token: 'test' },
  },
  bigquery: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'bigquery',
    connection: { project_id: 'test' },
    auth: { type: 'adc' },
  },
  databricks: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'databricks',
    connection: {
      workspace_url: 'https://test.cloud.databricks.com',
      http_path: '/sql/test',
      catalog: 'test',
      schema: 'main',
    },
    auth: { type: 'pat', token: 'test' },
  },
};
describe.each(Object.values(configs))('shared warehouse cursors: $source_type', (integration) => {
  it('creates a shared table and guards each mutation atomically', async () => {
    const run = vi.fn(async (_sql: string) => ({}));
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'previous-token' }];
      if (/SELECT ["`]?record["`]? FROM/i.test(sql)) return [];
      return [{ valid: 1 }];
    });
    const close = vi.fn(async () => {});
    resolve.mockResolvedValue({ run, query, close, supportsBindings: true });
    const store = createWarehouseAgenticCursorStore(integration, { schema: 'internal' });
    const key = { scope: 'project', model: 'pairs', target: 'models.pairs' };
    expect(await store.begin(key, 'a'.repeat(64), 'run')).toEqual({});
    expect(close).toHaveBeenCalledTimes(1);
    const sql = run.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).toMatch(/__bobsled_cursors/i);
    expect(sql).toContain('previous-token');
    expect(sql).toMatch(/DELETE FROM/i);
    expect(sql).not.toContain('__bobsled_cp_');
    if (integration.source_type === 'snowflake') expect(sql).toContain('matches := (SELECT');
    if (integration.source_type === 'bigquery') expect(sql).toContain('ASSERT');
    if (integration.source_type === 'databricks') expect(sql).toContain('BEGIN ATOMIC');
    if (integration.source_type === 'postgres') expect(sql).toContain('COMMIT');
  });
  it('rejects another active batch before a write', async () => {
    const run = vi.fn(async (_sql: string) => ({}));
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'previous-token' }];
      return [
        {
          record: JSON.stringify({
            signature: 'a'.repeat(64),
            values: { pairs: 10 },
            activeRun: 'first',
            committedRun: null,
          }),
        },
      ];
    });
    const close = vi.fn(async () => {});
    resolve.mockResolvedValue({ run, query, close, supportsBindings: true });
    const store = createWarehouseAgenticCursorStore(integration, { schema: 'internal' });
    await expect(
      store.begin(
        { scope: 'project', model: 'pairs', target: 'models.pairs' },
        'a'.repeat(64),
        'second'
      )
    ).rejects.toThrow();
    expect(run.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);
    expect(close).toHaveBeenCalled();
  });
  it('compares the previous owner and preserves progress during takeover', async () => {
    const record = {
      signature: 'a'.repeat(64),
      values: { pairs: 10 },
      activeRun: 'failed',
      committedRun: 'published',
    };
    const run = vi.fn(async (_sql: string) => ({}));
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'previous-token' }];
      if (/SELECT ["`]?record["`]? FROM/i.test(sql)) return [{ record: JSON.stringify(record) }];
      return [{ valid: 1 }];
    });
    resolve.mockResolvedValue({ run, query, close: vi.fn(), supportsBindings: true });
    const store = createWarehouseAgenticCursorStore(integration, { schema: 'internal' });
    const key = { scope: 'project', model: 'pairs', target: 'models.pairs' };
    await expect(store.supersede!(key, record.signature, 'wrong-owner', 'new')).rejects.toThrow();
    expect(run.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false);
    expect(await store.supersede!(key, record.signature, 'failed', 'new')).toEqual({ pairs: 10 });
    const sql = run.mock.calls.map(([sql]) => sql).join('\n');
    expect(sql).toContain('"activeRun":"failed"');
    expect(sql).toContain('"activeRun":"new"');
    expect(sql).toContain('"committedRun":"published"');
    expect(sql).toContain('previous-token');
  });
  it('reconciles a committed write when its response is lost', async () => {
    const signature = 'a'.repeat(64);
    let record = {
      signature,
      values: { pairs: 10 },
      activeRun: 'run' as string | null,
      committedRun: null as string | null,
    };
    const run = vi.fn(async (sql: string) => {
      if (integration.source_type === 'postgres' ? sql === 'COMMIT' : sql.includes('INSERT INTO')) {
        record = { signature, values: { pairs: 20 }, activeRun: null, committedRun: 'run' };
        throw new Error('Lost transport response');
      }
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('DESCRIBE')) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: 'current-token' }];
      if (sql.includes('AS valid')) return [{ valid: 1 }];
      return [{ record: JSON.stringify(record) }];
    });
    const close = vi.fn(async () => {});
    resolve.mockResolvedValue({ run, query, close, supportsBindings: true });
    const store = createWarehouseAgenticCursorStore(integration, { schema: 'internal' });
    await store.commit(
      { scope: 'project', model: 'pairs', target: 'models.pairs' },
      signature,
      'run',
      { pairs: 20 }
    );
    expect(close).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.filter(([sql]) => sql.includes('INSERT INTO'))).toHaveLength(1);
  });
});
