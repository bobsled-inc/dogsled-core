import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlParams } from '@bobsled-inc/connections';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { resolveWarehouseCheckpointTarget } from '../../../src/agentic/warehouse-checkpoint-target.js';
import { publicationNames } from '../../../src/agentic/sql-publication-dialect.js';
import { checkpointIntegrations, checkpointTransport } from '../../support/checkpoint-transport.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { runFixture } from './state-fixture.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
afterEach(() => resolve.mockReset());
const snowflake = checkpointIntegrations.find((item) => item.source_type === 'snowflake')!;

describe('checkpoint database target', () => {
  it('resolves the integration default and treats a dotted schema as one identifier', () => {
    expect(resolveWarehouseCheckpointTarget(snowflake, { schema: 'other.checkpoints' })).toEqual({
      catalog: 'TEST',
      schema: 'OTHER.CHECKPOINTS',
    });
  });

  it.each(checkpointIntegrations.filter((item) => item.source_type !== 'snowflake'))(
    'rejects a database override for $source_type before opening a runner',
    (integration) => {
      expect(() =>
        createWarehouseCheckpointStore(integration, {
          database: 'writable',
          schema: 'checkpoints',
        })
      ).toThrow('only supported for Snowflake');
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['', ' ', 'x'.repeat(1025)])('rejects invalid database identifiers', (database) => {
    expect(() =>
      createWarehouseCheckpointStore(snowflake, {
        database,
        schema: 'checkpoints',
      })
    ).toThrow('Invalid checkpoint database');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses the same escaped namespace for checkpoint DDL, leases, payloads and cursors', async () => {
    const transport = checkpointTransport();
    const statements: string[] = [];
    const runner = {
      ...transport.runner,
      run: vi.fn(async (sql: string) => {
        statements.push(sql);
        return transport.runner.run(sql);
      }),
      query: vi.fn(async (sql: string, params?: SqlParams) => {
        statements.push(sql);
        if (sql.includes('__BOBSLED_CURSORS')) {
          return sql.startsWith('SELECT "TOKEN"') ? [{ TOKEN: '' }] : [];
        }
        return transport.runner.query!(sql, params);
      }),
    };
    resolve.mockResolvedValue(runner);
    const store = createWarehouseCheckpointStore(snowflake, {
      database: 'write"db',
      schema: 'check.points"store',
    });
    const f = runFixture(1);
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: '/unused',
      stateStore: store,
      run: { id: 'selected-database', mode: 'start' },
    });
    await store.cursors!.begin(
      { scope: 'test', model: 'model', target: 'target' },
      'a'.repeat(64),
      'run'
    );
    const namespace = '"WRITE""DB"."CHECK.POINTS""STORE"';
    expect(statements.filter((sql) => sql.startsWith('CREATE SCHEMA'))).toEqual([
      `CREATE SCHEMA IF NOT EXISTS ${namespace}`,
      `CREATE SCHEMA IF NOT EXISTS ${namespace}`,
    ]);
    expect(statements.some((sql) => sql.startsWith('EXECUTE IMMEDIATE'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('INSERT INTO'))).toBe(true);
    expect(statements.some((sql) => sql.includes('__BOBSLED_CURSORS'))).toBe(true);
    for (const sql of statements) {
      for (const match of sql.matchAll(/"__BOBSLED_(?:CP_[A-F0-9]{48}_[CP]|CURSORS)"/g)) {
        expect(sql.slice(0, match.index).endsWith(`${namespace}.`)).toBe(true);
      }
      expect(sql).not.toContain('"TEST".');
    }
    expect(resolve).toHaveBeenCalledWith(
      snowflake,
      expect.objectContaining({ database: 'write"db' })
    );
  });

  it('keeps publication metadata in the output target catalog', () => {
    const names = publicationNames('output.analytics.result', 'snowflake', 'checkpoints');
    expect(names.target).toBe('"OUTPUT"."ANALYTICS"."RESULT"');
    expect(names.storageNamespace).toBe('"OUTPUT"."CHECKPOINTS"');
    expect(names.receipts).toMatch(/^"OUTPUT"\."CHECKPOINTS"\./);
  });
});
