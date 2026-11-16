import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQueryCommand } from '../../src/commands/query.js';
import { runVqCommand } from '../../src/commands/vq.js';
import { createFakeHttpsServer, type FakeServer } from './helpers/fake-server.js';

import type { SourceMaterializerFeatureFlags } from '../../src/runtime/source-materializer/feature-flags.js';

const FIXTURE_DIR = new URL('./fixtures/incremental-demo/', import.meta.url);

interface DemoRow {
  id: number;
  updated_at: string;
  status: string;
  tenant: string;
}

describe('incremental-demo e2e', () => {
  let server: FakeServer;
  let projectRoot: string;
  let data: DemoRow[];
  let requestCount = 0;
  let priorAllowPrivateHosts: string | undefined;
  let priorTlsUnauthorized: string | undefined;
  let integrationSpecLoader: (
    integrationName: string,
    resourceName: string
  ) => { integration: unknown; resource: unknown } | undefined;

  beforeEach(async () => {
    data = JSON.parse(await readFile(new URL('seed.json', FIXTURE_DIR), 'utf8')) as DemoRow[];
    requestCount = 0;
    server = await createFakeHttpsServer([
      {
        path: '/items',
        handler: (_req, url) => {
          requestCount += 1;
          const status = url.searchParams.get('status');
          const tenant = url.searchParams.get('tenant');
          const updatedAfter = url.searchParams.get('updated_after');
          const rows = data.filter((row) => {
            if (status !== null && row.status !== status) return false;
            if (tenant !== null && row.tenant !== tenant) return false;
            if (updatedAfter !== null && row.updated_at <= updatedAfter) return false;
            return true;
          });
          return { body: rows };
        },
      },
    ]);

    priorAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    priorTlsUnauthorized = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

    projectRoot = await mkdtemp(join(tmpdir(), 'dogsled-incremental-demo-'));
    await writeProject(projectRoot);
    integrationSpecLoader = await loadFixtureSpecs(server.port);
  });

  afterEach(async () => {
    await server.close();
    await rm(projectRoot, { recursive: true, force: true });
    restoreEnv('BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS', priorAllowPrivateHosts);
    restoreEnv('NODE_TLS_REJECT_UNAUTHORIZED', priorTlsUnauthorized);
  });

  it('LIMIT 2 twice rebuilds and then reuses the partial snapshot', async () => {
    const first = await runDemoQuery('SELECT * FROM sources.items LIMIT 2', {
      nowIso: '2026-04-22T13:00:00.000Z',
      featureFlags: { partialMaterialization: true },
    });
    const second = await runDemoQuery('SELECT * FROM sources.items LIMIT 2', {
      nowIso: '2026-04-22T13:05:00.000Z',
      featureFlags: { partialMaterialization: true },
    });

    expect(first.rows).toHaveLength(2);
    expect(first.receipts[0]).toContain('refresh_reason=partial_rebuild');
    expect(second.rows).toHaveLength(2);
    expect(second.receipts[0]).toContain('refresh_reason=partial_reuse');
    expect(requestCount).toBe(1);
  });

  it('unbounded COUNT(*) materializes the canonical snapshot', async () => {
    const result = await runDemoQuery('SELECT COUNT(*) AS n FROM sources.items', {
      nowIso: '2026-04-22T13:00:00.000Z',
    });

    expect(result.rows).toEqual([{ n: 3n }]);
    expect(result.receipts[0]).toContain('refresh_reason=first_load');
    expect(result.receipts[0]).toContain('snapshot_kind=canonical');
  });

  it('reruns through the incremental path and merges only the delta rows', async () => {
    await runDemoQuery('SELECT COUNT(*) AS n FROM sources.items', {
      nowIso: '2026-04-22T13:00:00.000Z',
      featureFlags: { incrementalRefresh: true },
    });

    data.push({
      id: 4,
      updated_at: '2026-04-22T14:00:00Z',
      status: 'open',
      tenant: 'acme',
    });

    const result = await runDemoQuery('SELECT COUNT(*) AS n FROM sources.items', {
      nowIso: '2026-04-22T15:00:00.000Z',
      featureFlags: { incrementalRefresh: true },
    });

    expect(result.rows).toEqual([{ n: 4n }]);
    expect(result.receipts[0]).toContain('refresh_reason=incremental_merge');
    expect(result.receipts[0]).toContain('delta_rows=1');
    expect(result.receipts[0]).toContain('total_rows=4');
  });

  it('passes VQ params and session values through source.filter at runtime', async () => {
    await seedVq(
      projectRoot,
      'open_for_tenant.yml',
      `spec_version: '0.2'
type: vq
name: open_for_tenant
nlq: Which open items belong to the active tenant?
sql: SELECT id FROM {incremental_demo.tenant_items}
parameters:
  - name: status
    type: string
`
    );

    const result = await runVqCommand({
      projectRoot,
      name: 'open_for_tenant',
      params: { status: 'open' },
      session: { tenant: 'acme' },
      integrationSpecLoader,
      nowIso: '2026-04-22T13:00:00.000Z',
    });

    expect(result.rows).toEqual([{ id: 1n }, { id: 3n }]);
  });

  it('coalesces concurrent duplicate queries onto one upstream fetch', async () => {
    const [first, second] = await Promise.all([
      runDemoQuery('SELECT COUNT(*) AS n FROM sources.items', {
        nowIso: '2026-04-22T13:00:00.000Z',
        featureFlags: { inFlightDedup: true },
      }),
      runDemoQuery('SELECT COUNT(*) AS n FROM sources.items', {
        nowIso: '2026-04-22T13:00:00.000Z',
        featureFlags: { inFlightDedup: true },
      }),
    ]);

    expect(first.rows).toEqual([{ n: 3n }]);
    expect(second.rows).toEqual([{ n: 3n }]);
    expect(requestCount).toBe(1);
    expect([first.receipts[0], second.receipts[0]].join(' ')).toContain('action=coalesced');
  });

  it('cleans up failed in-flight query dedup without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    let rejectFetch: ((error: Error) => void) | undefined;
    const upstreamFailure = new Promise<never>((_resolve, reject) => {
      rejectFetch = reject;
    });
    let queryCalls = 0;
    const queryResourceImpl: NonNullable<
      Parameters<typeof runQueryCommand>[0]['queryResourceImpl']
    > = async () => {
      queryCalls += 1;
      return upstreamFailure;
    };

    try {
      const first = runQueryCommand({
        projectRoot,
        sql: 'SELECT COUNT(*) AS n FROM sources.items',
        integrationSpecLoader,
        nowIso: '2026-04-22T13:00:00.000Z',
        featureFlags: { inFlightDedup: true },
        queryResourceImpl,
      });
      const second = runQueryCommand({
        projectRoot,
        sql: 'SELECT COUNT(*) AS n FROM sources.items',
        integrationSpecLoader,
        nowIso: '2026-04-22T13:00:00.000Z',
        featureFlags: { inFlightDedup: true },
        queryResourceImpl,
      });

      for (let attempt = 0; attempt < 50 && queryCalls === 0; attempt += 1) {
        await delay(10);
      }
      rejectFetch?.(new Error('provider down'));

      await expect(Promise.all([first, second])).rejects.toThrow('provider down');
      await delay(0);
      expect(queryCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  async function runDemoQuery(
    sql: string,
    options: {
      nowIso: string;
      featureFlags?: Partial<SourceMaterializerFeatureFlags>;
    }
  ) {
    return runQueryCommand({
      projectRoot,
      sql,
      integrationSpecLoader,
      nowIso: options.nowIso,
      featureFlags: options.featureFlags,
    });
  }
});

async function writeProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, '.dogsled'), { recursive: true });
  await mkdir(join(projectRoot, 'sources'), { recursive: true });
  await mkdir(join(projectRoot, 'vqs'), { recursive: true });
  await writeFile(
    join(projectRoot, '.dogsled', 'config.yml'),
    `default_destination:
  dest: duckdb
  dbPath: ${join(projectRoot, 'incremental-demo.duckdb')}
  targetSchema: analytics
`,
    'utf8'
  );
  await seedSource(
    projectRoot,
    'items.yml',
    `spec_version: '0.2'
name: items
type: source
source_type: api_resource
integration: incremental_demo
resource: items
connection: incremental_demo
mode: lazy
max_age: 30m
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: updated_at, type: TIMESTAMP }
    - { name: status, type: STRING }
    - { name: tenant, type: STRING }
`
  );
  await seedSource(
    projectRoot,
    'tenant_items.yml',
    `spec_version: '0.2'
name: tenant_items
type: source
source_type: api_resource
integration: incremental_demo
resource: items
connection: incremental_demo
mode: live
filter:
  status: "\${{ params.status }}"
  tenant: "\${{ session.tenant }}"
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: updated_at, type: TIMESTAMP }
    - { name: status, type: STRING }
    - { name: tenant, type: STRING }
`
  );
}

async function seedSource(projectRoot: string, fileName: string, body: string): Promise<void> {
  await writeFile(join(projectRoot, 'sources', fileName), body, 'utf8');
}

async function seedVq(projectRoot: string, fileName: string, body: string): Promise<void> {
  await writeFile(join(projectRoot, 'vqs', fileName), body, 'utf8');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadFixtureSpecs(port: number) {
  const integration = YAML.parse(
    (await readFile(new URL('integration.yml', FIXTURE_DIR), 'utf8')).replace(
      '${PORT}',
      String(port)
    )
  ) as unknown;
  const resource = YAML.parse(
    await readFile(new URL('resources/items.yml', FIXTURE_DIR), 'utf8')
  ) as unknown | undefined;

  return (integrationName: string, resourceName: string) => {
    if (integrationName !== 'incremental_demo' || resourceName !== 'items' || !resource) {
      return undefined;
    }
    return { integration, resource };
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
