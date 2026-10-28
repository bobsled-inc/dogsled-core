import * as http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startEntityGraphHttpServer,
  type StartedEntityGraphHttpServer,
} from '../../../src/runtime/services/http-api.js';

import type { ResolvedResolutionSpec } from '../../../src/compiler/identity/types.js';

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'HTTP fixture.',
  inputs: [
    {
      ref: 'crm.accounts',
      fqTableName: 'main.accounts',
      alias: 's0',
      idFields: ['account_id'],
      sourceColumns: ['account_id', 'name'],
    },
  ],
  standardize: [{ field: 'name', transforms: ['normalize_company'] }],
  blocking: { rules: [{ name: 'name', key: 'standardized_name' }] },
  deterministicRules: [],
  thresholds: { autoMerge: 0.95, review: 0.6, autoReject: 0.4 },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'entity_graph',
};

function createRunner() {
  return {
    run: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('company__golden')) {
        return [{ entity_id: 'entity-1', display_name: 'Acme', trust_score: 0.98 }];
      }
      if (sql.includes('company__entity_quality')) {
        return [{ entity_id: 'entity-1', trust_tier: 'trusted' }];
      }
      if (sql.includes('company__crosswalks')) {
        return [{ record_id: 'record-1', entity_id: 'entity-1', source_ref: 'crm.accounts' }];
      }
      return [];
    }),
  };
}

async function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
          });
        });
      }
    );
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

let started: StartedEntityGraphHttpServer | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => started?.server.close(() => resolve()) ?? resolve());
  started = undefined;
});

describe('entity graph HTTP API', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => started?.server.close(() => resolve()) ?? resolve());
    started = undefined;
  });

  it('serves health and entity get JSON responses', async () => {
    started = startEntityGraphHttpServer({
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;
    const health = await fetch(`${started.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const entity = await fetch(`${started.url}/entities/company/entity-1`);
    expect(entity.status).toBe(200);
    expect(await entity.json()).toMatchObject({ entity_id: 'entity-1' });
  });

  it('serves BIGINT warehouse values as JSON strings', async () => {
    const runner = createRunner();
    runner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('company__golden')) {
        return [{ entity_id: 'entity-1', display_name: 'Acme', version: 3n }];
      }
      return [];
    });
    started = startEntityGraphHttpServer({
      runner,
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;

    const entity = await fetch(`${started.url}/entities/company/entity-1`);
    expect(entity.status).toBe(200);
    expect(await entity.json()).toMatchObject({ entity_id: 'entity-1', profile: { version: '3' } });
  });

  it('blocks mutating match modes unless writes are explicitly allowed', async () => {
    started = startEntityGraphHttpServer({
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;
    const response = await fetch(`${started.url}/entities/company/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: started.url },
      body: JSON.stringify({ mode: 'assign', record: { account_id: 'a1', name: 'Acme' } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'assign/stage require --allow-writes.' });
  });

  it('rejects unsupported match modes', async () => {
    started = startEntityGraphHttpServer({
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;
    const response = await fetch(`${started.url}/entities/company/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: started.url },
      body: JSON.stringify({ mode: 'assgin', record: { account_id: 'a1', name: 'Acme' } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'mode must be lookup, assign, or stage.',
    });
  });

  it('rejects non-loopback Host headers by default', async () => {
    started = startEntityGraphHttpServer({
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;

    const response = await requestJson(`${started.url}/healthz`, {
      headers: { host: 'example.com' },
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Host must be localhost, 127.0.0.1, or [::1].' });
  });

  it('rejects cross-origin mutating requests using Referer when Origin is absent', async () => {
    started = startEntityGraphHttpServer({
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;
    const host = new URL(started.url).host;

    const response = await requestJson(`${started.url}/entities/company/match`, {
      method: 'POST',
      headers: {
        host,
        referer: 'http://evil.example/form',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ record: { account_id: 'a1', name: 'Acme' } }),
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Cross-origin mutating requests are rejected.' });
  });

  it('returns generic messages for unexpected server errors', async () => {
    const runner = createRunner();
    runner.query.mockRejectedValueOnce(new Error('warehouse secret detail'));
    started = startEntityGraphHttpServer({
      runner,
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;

    const response = await fetch(`${started.url}/entities/company`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('searches profile text instead of hash-like entity IDs', async () => {
    const runner = createRunner();
    started = startEntityGraphHttpServer({
      runner,
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      host: '127.0.0.1',
      port: 0,
    });
    await started.ready;

    const response = await fetch(`${started.url}/entities/company?query=acme`);

    expect(response.status).toBe(200);
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('display_name'));
    expect(runner.query).not.toHaveBeenCalledWith(expect.stringContaining('entity_id) LIKE'));
  });
});

it.each([undefined, 'null', 'invalid', 'https://example.com'])(
  'rejects unsafe entity API origin %s',
  async (origin) => {
    const runner = createRunner();
    started = startEntityGraphHttpServer({
      runner,
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      port: 0,
    });
    await started.ready;
    const response = await requestJson(`${started.url}/entities/company/match`, {
      method: 'POST',
      headers: {
        ...(origin ? { origin } : {}),
        referer: started.url,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(runner.query).not.toHaveBeenCalled();
  }
);

it('rejects non JSON bodies at the entity API boundary', async () => {
  started = startEntityGraphHttpServer({
    runner: createRunner(),
    schema: 'entity_graph',
    dialect: 'duckdb',
    specs: [SPEC],
    port: 0,
  });
  await started.ready;
  expect(
    (
      await requestJson(`${started.url}/entities/company/match`, {
        method: 'POST',
        headers: { origin: started.url, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status
  ).toBe(415);
});
