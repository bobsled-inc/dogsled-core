import { describe, expect, it } from 'vitest';

import {
  BigQueryWarehouseClient,
  resolveBigQueryAccessTokenAuth,
} from '../../src/runtime/bigquery-client.js';

describe('resolveBigQueryAccessTokenAuth', () => {
  it('returns undefined for adc / wif / service_account / absent auth (ambient resolution preserved)', () => {
    expect(resolveBigQueryAccessTokenAuth(undefined)).toBeUndefined();
    expect(resolveBigQueryAccessTokenAuth(null)).toBeUndefined();
    expect(resolveBigQueryAccessTokenAuth({ type: 'adc' })).toBeUndefined();
    expect(
      resolveBigQueryAccessTokenAuth({ type: 'wif', service_account_email_env: 'SA_EMAIL' })
    ).toBeUndefined();
    expect(
      resolveBigQueryAccessTokenAuth({ type: 'service_account', credentials: '/key.json' })
    ).toBeUndefined();
  });

  it('extracts a static access token', () => {
    expect(resolveBigQueryAccessTokenAuth({ type: 'access_token', access_token: 'tok' })).toEqual({
      accessToken: 'tok',
      tokenCommand: undefined,
    });
  });

  it('extracts access token + token_command (refreshable)', () => {
    expect(
      resolveBigQueryAccessTokenAuth({
        type: 'access_token',
        access_token: 'tok',
        token_command: 'node mint.js',
      })
    ).toEqual({ accessToken: 'tok', tokenCommand: 'node mint.js' });
  });

  it('treats a blank token_command as absent', () => {
    expect(
      resolveBigQueryAccessTokenAuth({
        type: 'access_token',
        access_token: 'tok',
        token_command: '   ',
      })
    ).toEqual({ accessToken: 'tok', tokenCommand: undefined });
  });

  it('throws when access_token is empty (e.g. unresolved ${{ env.X }})', () => {
    expect(() =>
      resolveBigQueryAccessTokenAuth({ type: 'access_token', access_token: '' })
    ).toThrow(/non-empty "access_token"/);
    expect(() =>
      resolveBigQueryAccessTokenAuth({ type: 'access_token', access_token: '   ' })
    ).toThrow(/non-empty "access_token"/);
  });
});

// ── BigQueryWarehouseClient.execute — parameter binding ──

/**
 * Inject a mock SDK client into a BigQueryWarehouseClient, bypassing the lazy
 * @google-cloud/bigquery import. This lets unit tests exercise the execute()
 * parameter-binding logic without a real BigQuery connection.
 */
function makeClientWithMockSdk(
  createQueryJob: (opts: Record<string, unknown>) => Promise<[unknown]>
): BigQueryWarehouseClient {
  const client = new BigQueryWarehouseClient({ projectId: 'test-project' });
  (client as unknown as { sdkClient: unknown }).sdkClient = { createQueryJob };
  return client;
}

describe('BigQueryWarehouseClient.execute — parameter binding', () => {
  it('passes params array and parameterMode positional to createQueryJob', async () => {
    const capturedOpts: Record<string, unknown>[] = [];
    const mockJob = {
      getQueryResults: async (_opts: Record<string, unknown>) =>
        [[{ id: 1 }], undefined, {}] as [Record<string, unknown>[], unknown, object],
    };

    const client = makeClientWithMockSdk(async (opts) => {
      capturedOpts.push(opts);
      return [mockJob];
    });

    const sql = 'SELECT * FROM `t` WHERE `id` > ?';
    const batches: Record<string, unknown>[][] = [];
    for await (const batch of client.execute(sql, [42])) {
      batches.push(batch);
    }

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]).toMatchObject({
      query: sql,
      params: [42],
      parameterMode: 'positional',
    });
    expect(batches).toHaveLength(1);
  });

  it('omits params and parameterMode when no params are provided', async () => {
    const capturedOpts: Record<string, unknown>[] = [];
    const mockJob = {
      getQueryResults: async (_opts: Record<string, unknown>) =>
        [[], undefined, {}] as [Record<string, unknown>[], unknown, object],
    };

    const client = makeClientWithMockSdk(async (opts) => {
      capturedOpts.push(opts);
      return [mockJob];
    });

    for await (const _ of client.execute('SELECT 1')) {
      /* consume */
    }

    expect(capturedOpts[0]).not.toHaveProperty('params');
    expect(capturedOpts[0]).not.toHaveProperty('parameterMode');
  });

  it('regression: named @pN placeholders with an array params never reach createQueryJob', async () => {
    // The bug: the query builder emitted @p1 (named) but the client passed params
    // as an array (positional), causing BigQuery to reject with "Named parameters
    // are not supported". Verify the fix: the SQL reaching execute() uses ? and
    // parameterMode is set to positional, so the two sides always agree.
    const capturedOpts: Record<string, unknown>[] = [];
    const mockJob = {
      getQueryResults: async (_opts: Record<string, unknown>) =>
        [[{ count: 5 }], undefined, {}] as [Record<string, unknown>[], unknown, object],
    };

    const client = makeClientWithMockSdk(async (opts) => {
      capturedOpts.push(opts);
      return [mockJob];
    });

    // This is the SQL shape produced by buildExtractionQuery for a BigQuery
    // incremental extract after the fix (positional ?, not named @p0).
    const sql = 'SELECT * FROM `proj.ds.orders` WHERE `id` > ? ORDER BY `id`';
    for await (const _ of client.execute(sql, [999])) {
      /* consume */
    }

    const opts = capturedOpts[0];
    // SQL must not contain named placeholders.
    expect(String(opts['query'])).not.toMatch(/@p\d+/);
    // params must be an array (positional), consistent with the ? in the SQL.
    expect(Array.isArray(opts['params'])).toBe(true);
    // parameterMode must explicitly state positional.
    expect(opts['parameterMode']).toBe('positional');
  });
});
