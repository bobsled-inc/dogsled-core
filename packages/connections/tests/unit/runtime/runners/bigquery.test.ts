import { describe, expect, it, vi } from 'vitest';

import { SqlCancelledError } from '../../../../src/runtime/cancellation.js';
import {
  buildBigQueryRunner,
  type BuildBigQueryRunnerOptions,
} from '../../../../src/runtime/runners/bigquery.js';
import type { BigQueryIntegration } from '../../../../src/schemas/integration.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adcIntegration(): BigQueryIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'bq_test',
    source_type: 'bigquery',
    connection: {
      project_id: 'my-project',
      default_location: 'US',
    },
    auth: { type: 'adc' },
  };
}

function serviceAccountIntegration(): BigQueryIntegration {
  return {
    ...adcIntegration(),
    auth: {
      type: 'service_account',
      credentials: JSON.stringify({ type: 'service_account', project_id: 'my-project' }),
    },
  };
}

function serviceAccountFileIntegration(): BigQueryIntegration {
  return {
    ...adcIntegration(),
    auth: {
      type: 'service_account',
      credentials: '/path/to/service-account.json',
    },
  };
}

function wifIntegration(): BigQueryIntegration {
  return {
    ...adcIntegration(),
    auth: {
      type: 'wif',
      service_account_email: 'sa@project.iam.gserviceaccount.com.example.com',
    },
  };
}

function mockBigQueryClient() {
  const getQueryResults = vi.fn(async () => [[{ id: 1, name: 'alpha' }]]);
  const cancel = vi.fn(async () => ({}));
  const job = {
    getQueryResults,
    cancel,
    metadata: { statistics: { query: { numDmlAffectedRows: '3' } } },
  };
  const createQueryJob = vi.fn(async () => [job]);
  return { client: { createQueryJob }, job, getQueryResults, createQueryJob, cancel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildBigQueryRunner — adc auth', () => {
  it('run() executes SQL and returns rowCount from DML metadata', async () => {
    const { client } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    try {
      const result = await runner.run('INSERT INTO t VALUES (1)');
      expect(result).toEqual({ rowCount: 3 });
      expect(client.createQueryJob).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'INSERT INTO t VALUES (1)', location: 'US' })
      );
    } finally {
      await runner.close?.();
    }
  });

  it('query() returns rows', async () => {
    const { client } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    try {
      const rows = await runner.query!('SELECT id, name FROM t');
      expect(rows).toEqual([{ id: 1, name: 'alpha' }]);
    } finally {
      await runner.close?.();
    }
  });

  it('dryRun() validates SQL without fetching query results', async () => {
    const { client, getQueryResults } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });

    await runner.dryRun!('CREATE OR REPLACE VIEW ds.v AS SELECT 1');

    expect(client.createQueryJob).toHaveBeenCalledWith({
      query: 'CREATE OR REPLACE VIEW ds.v AS SELECT 1',
      location: 'US',
      dryRun: true,
      useQueryCache: false,
    });
    expect(getQueryResults).not.toHaveBeenCalled();
  });

  it('run() returns empty result when no DML metadata', async () => {
    const getQueryResults = vi.fn(async () => [[]]);
    const job = { getQueryResults, metadata: {} };
    const client = { createQueryJob: vi.fn(async () => [job]) };
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    const result = await runner.run('CREATE TABLE t (id INT64)');
    expect(result).toEqual({});
  });

  it('close() is a no-op (stateless client)', async () => {
    const { client } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    await expect(runner.close?.()).resolves.toBeUndefined();
  });

  it('unload() emits EXPORT DATA to the configured GCS prefix', async () => {
    const { client, job } = mockBigQueryClient();
    job.metadata = { statistics: { query: { totalBytesProcessed: '1234' } } };
    const runner = await buildBigQueryRunner(adcIntegration(), { client });

    const result = await runner.unload!('SELECT id FROM dataset.table', 'gs://bucket/xwh/run1', {
      format: 'parquet',
    });

    expect(client.createQueryJob).toHaveBeenCalledWith({
      query:
        "EXPORT DATA OPTIONS(uri = 'gs://bucket/xwh/run1/*.parquet', format = 'PARQUET', overwrite = true) AS (SELECT id FROM dataset.table)",
      location: 'US',
    });
    expect(result).toEqual({
      uris: ['gs://bucket/xwh/run1/*.parquet'],
      rowCount: 0,
      bytes: 1234,
    });
  });
});

describe('buildBigQueryRunner — service_account auth (JSON string)', () => {
  it('parses credentials JSON and passes as credentials object', async () => {
    // This test verifies the credentials-parsing path. Since we inject a mock
    // client, we can't directly assert what was passed to the BigQuery
    // constructor, but we verify it works without error.
    const { client } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(serviceAccountIntegration(), { client });
    const result = await runner.run('SELECT 1');
    expect(result).toEqual({ rowCount: 3 });
  });
});

describe('buildBigQueryRunner — service_account auth (file path)', () => {
  it('treats non-JSON credentials as keyFilename', async () => {
    const { client } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(serviceAccountFileIntegration(), { client });
    const result = await runner.run('SELECT 1');
    expect(result).toEqual({ rowCount: 3 });
  });
});

describe('buildBigQueryRunner — wif auth', () => {
  it('builds runner without error for wif auth', async () => {
    const { client } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(wifIntegration(), { client });
    const result = await runner.run('SELECT 1');
    expect(result).toEqual({ rowCount: 3 });
  });
});

describe('buildBigQueryRunner — refreshable managed credentials', () => {
  // Proactive refresh for BigQuery happens inside the google-auth AuthClient's
  // per-request getRequestHeaders() (covered in refreshable-token.test.ts). At
  // the runner level we assert the REACTIVE backstop: a 401 force-refreshes the
  // token-command and retries the operation exactly once.
  it('force-refreshes the token and retries once on a 401', async () => {
    let n = 0;
    const tokenProvider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: 10_000 }));

    let calls = 0;
    const getQueryResults = vi.fn(async () => [[{ id: 1 }]]);
    const job = { getQueryResults, metadata: {} };
    const createQueryJob = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Request had invalid authentication credentials'), {
          code: 401,
        });
      }
      return [job];
    });
    const client = { createQueryJob };

    const runner = await buildBigQueryRunner(adcIntegration(), { client, tokenProvider });
    const rows = await runner.query!('SELECT id FROM t');

    expect(rows).toEqual([{ id: 1 }]);
    expect(createQueryJob).toHaveBeenCalledTimes(2); // failed once, retried once
    expect(tokenProvider).toHaveBeenCalledTimes(1); // forced refresh on the 401
  });

  it('wires a proactively-refreshing authClient into client construction (proactive through the runner)', async () => {
    let now = 0;
    let n = 0;
    const tokenProvider = vi.fn(async () => ({
      accessToken: `tok-${++n}`,
      expiresAt: now + 3_600,
    }));
    let captured: { getRequestHeaders(): Promise<Record<string, string>> } | undefined;
    // Typed against the real `loadClient` contract (no `as never`) so signature
    // drift in how the runner constructs the client surfaces as a type error.
    const loadClient: NonNullable<BuildBigQueryRunnerOptions['loadClient']> = async (
      _projectId,
      _location,
      _credentials,
      _keyFilename,
      authClient
    ) => {
      captured = authClient as { getRequestHeaders(): Promise<Record<string, string>> };
      return { createQueryJob: async () => [{ getQueryResults: async () => [[]] }] };
    };

    const options = {
      tokenProvider,
      now: () => now,
      skewSeconds: 300,
      loadClient,
    } satisfies BuildBigQueryRunnerOptions;

    await buildBigQueryRunner(adcIntegration(), options);

    // The runner built a refreshable authClient and wired it into the client —
    // the real BigQuery SDK consults this per request via getRequestHeaders().
    expect(captured).toBeDefined();
    expect(await captured!.getRequestHeaders()).toEqual({ Authorization: 'Bearer tok-1' });
    now = 3_400; // within skew of tok-1's 3600 expiry → proactive re-mint per request
    expect(await captured!.getRequestHeaders()).toEqual({ Authorization: 'Bearer tok-2' });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-auth errors', async () => {
    const tokenProvider = vi.fn(async () => ({ accessToken: 'tok-1', expiresAt: 10_000 }));
    const createQueryJob = vi.fn(async () => {
      throw new Error('table not found');
    });
    const runner = await buildBigQueryRunner(adcIntegration(), {
      client: { createQueryJob },
      tokenProvider,
    });
    await expect(runner.run('SELECT 1')).rejects.toThrow(/table not found/);
    expect(createQueryJob).toHaveBeenCalledTimes(1);
    expect(tokenProvider).not.toHaveBeenCalled();
  });
});

describe('buildBigQueryRunner — cooperative cancellation', () => {
  /**
   * Client whose result polling hangs until the test releases it, so an abort can
   * land while the job is genuinely in flight. `started` resolves once polling has
   * begun, making the abort deterministic instead of timing-dependent.
   */
  function hangingClient() {
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release!: () => void;
    const cancel = vi.fn(async () => {
      release();
      return {};
    });
    const getQueryResults = vi.fn(
      () =>
        new Promise<[Record<string, unknown>[], ...unknown[]]>((resolve) => {
          begin();
          release = () => resolve([[]]);
        })
    );
    const job = { getQueryResults, cancel, metadata: {} };
    const createQueryJob = vi.fn(async () => [job]);
    return {
      client: { createQueryJob },
      createQueryJob,
      getQueryResults,
      cancel,
      started,
    };
  }

  it('rejects an already-aborted signal without submitting a job', async () => {
    const { client, createQueryJob, cancel } = hangingClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run('SELECT 1', { signal: controller.signal })).rejects.toBeInstanceOf(
      SqlCancelledError
    );
    expect(createQueryJob).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('aborting mid-statement cancels the BigQuery job', async () => {
    const { client, cancel, started } = hangingClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    const controller = new AbortController();

    const pending = runner.run('SELECT 1', { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborting mid-statement cancels the job for query() too', async () => {
    const { client, cancel, started } = hangingClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });
    const controller = new AbortController();

    const pending = runner.query!('SELECT id FROM t', undefined, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('never cancels the job when no signal is passed', async () => {
    const { client, cancel } = mockBigQueryClient();
    const runner = await buildBigQueryRunner(adcIntegration(), { client });

    expect(await runner.run('SELECT 1')).toEqual({ rowCount: 3 });
    expect(await runner.query!('SELECT 1')).toEqual([{ id: 1, name: 'alpha' }]);
    await runner.dryRun!('SELECT 1');
    expect(cancel).not.toHaveBeenCalled();
  });
});
