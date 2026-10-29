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

// ── BigQueryWarehouseClient.resolveColumnCastExpr — table metadata ──

/**
 * Build a client whose SDK mock also implements the dataset/table/getMetadata
 * path used by resolveColumnCastExpr.
 */
function makeClientWithMetadataMock(
  getMetadata: () => Promise<
    [{ schema?: { fields?: Array<{ name?: string; type?: string }> } }, unknown]
  >
): BigQueryWarehouseClient {
  const client = new BigQueryWarehouseClient({ projectId: 'test-project' });
  const mockDataset = {
    table: (_tableId: string) => ({ getMetadata }),
  };
  (client as unknown as { sdkClient: unknown }).sdkClient = {
    createQueryJob: async () => {
      throw new Error('not needed');
    },
    dataset: (_datasetId: string, _opts?: unknown) => mockDataset,
  };
  return client;
}

describe('BigQueryWarehouseClient.resolveColumnCastExpr — table metadata', () => {
  it('INT64 column → CAST(? AS INT64)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'name', type: 'STRING' },
          ],
        },
      },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'id')).toBe(
      'CAST(? AS INT64)'
    );
  });

  it('INTEGER alias → CAST(? AS INT64)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'id', type: 'INTEGER' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'id')).toBe(
      'CAST(? AS INT64)'
    );
  });

  it('FLOAT64 column → CAST(? AS FLOAT64)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'score', type: 'FLOAT64' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'score')).toBe(
      'CAST(? AS FLOAT64)'
    );
  });

  it('NUMERIC column → CAST(? AS NUMERIC)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'amount', type: 'NUMERIC' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'amount')).toBe(
      'CAST(? AS NUMERIC)'
    );
  });

  it('BIGNUMERIC column → CAST(? AS BIGNUMERIC)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'total', type: 'BIGNUMERIC' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'total')).toBe(
      'CAST(? AS BIGNUMERIC)'
    );
  });

  it('STRING column → ? (no cast; STRING binding)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'category', type: 'STRING' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'category')).toBe('?');
  });

  it('DATETIME column → ? (BigQuery coerces STRING params to DATETIME)', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'created_at', type: 'DATETIME' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'created_at')).toBe('?');
  });

  it('DATE column → ?', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'updated_date', type: 'DATE' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'updated_date')).toBe('?');
  });

  it('TIMESTAMP column → ?', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'ts', type: 'TIMESTAMP' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'ts')).toBe('?');
  });

  it('metadata error → undefined (caller should log warning and fall back)', async () => {
    const client = makeClientWithMetadataMock(async () => {
      throw new Error('403 Forbidden');
    });
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'id')).toBeUndefined();
  });

  it('cursor field absent from schema → undefined', async () => {
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'other_col', type: 'STRING' }] } },
      {},
    ]);
    expect(await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'id')).toBeUndefined();
  });

  it('STRING cursor value "00999" with no declared type → ? (no unsafe cast)', async () => {
    // Regression: a STRING column whose values look like numbers must not produce
    // CAST(? AS INT64). The metadata returns STRING → plain ?.
    const client = makeClientWithMetadataMock(async () => [
      { schema: { fields: [{ name: 'code', type: 'STRING' }] } },
      {},
    ]);
    const expr = await client.resolveColumnCastExpr(undefined, 'ds', 'orders', 'code');
    expect(expr).toBe('?');
    expect(expr).not.toContain('INT64');
  });
});
