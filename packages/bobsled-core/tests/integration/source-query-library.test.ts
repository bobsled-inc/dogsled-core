import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDuckDbRunner } from '@bobsled-inc/connections';
import {
  resolveSourceEntry,
  SourceSpecSchema,
  type SourceRegistryEntry,
} from '@bobsled-inc/model-spec';
import { describe, expect, it, vi } from 'vitest';

import {
  runQueryCommand,
  resolveModelReferences,
  detectModelReferences,
  stageWarehouseSourceIntoDuckDb,
  createRunnerDuckDbDestination,
  materializeWarehouseLeaf,
  analyzeDeployedModelProject,
  planDeployedModelExecution,
} from '../../src/source-query.js';
import type { ApiResourceEntry } from '../../src/source-query.js';

import type { DuckDbIntegration, SqlRunnerModule } from '@bobsled-inc/connections';

function makeEntry(raw: Record<string, unknown>): ApiResourceEntry {
  const parsed = SourceSpecSchema.parse(raw);
  const entry = resolveSourceEntry(parsed) as SourceRegistryEntry;
  if (entry.kind !== 'api_resource') {
    throw new Error('expected an api_resource source entry');
  }
  return entry;
}

const liveIssuesSpec = {
  spec_version: '0.2',
  name: 'issues',
  type: 'source',
  source_type: 'api_resource',
  integration: 'github',
  resource: 'issues',
  connection: 'github_prod',
  mode: 'live',
  schema: {
    columns: [{ name: 'id', type: 'INTEGER' }],
  },
};

const lazyIssuesSpec = {
  ...liveIssuesSpec,
  mode: 'lazy',
};

function duckIntegration(name: string, dbPath: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath, read_only: false },
  };
}

describe('derived-model resolution public export', () => {
  it('re-exports resolveModelReferences / detectModelReferences from the public surface', () => {
    // Host apps (e.g. a downstream cross-source-query container) import these from
    // `@bobsled-inc/bobsled-core/source-query` to support `SELECT ... FROM <model>`.
    expect(typeof resolveModelReferences).toBe('function');
    expect(typeof detectModelReferences).toBe('function');
  });

  it('detectModelReferences works through the public export', () => {
    expect(
      detectModelReferences('SELECT * FROM stg_issues JOIN sources.x', ['stg_issues'])
    ).toEqual(['stg_issues']);
  });
});

describe('deployed-definition planning public export', () => {
  it('shows how a host runs a plan for same-named live sources', async () => {
    expect(typeof analyzeDeployedModelProject).toBe('function');
    expect(typeof planDeployedModelExecution).toBe('function');

    const source = (connection: string) => ({
      ...liveIssuesSpec,
      name: 'users',
      resource: `${connection}_users`,
      connection,
    });
    const plan = planDeployedModelExecution({
      sources: [source('product_api'), source('support_api')],
      models: [
        {
          spec_version: '0.2',
          name: 'joined_users',
          type: 'model',
          description: 'Users joined across two APIs.',
          grain: 'id',
          source: { ref: 'product_api.users' },
          joins: [
            {
              ref: 'support_api.users',
              alias: 'support_users',
              type: 'inner',
              on: 'product_api.users.id = support_api.users.id',
            },
          ],
          columns: [{ name: 'id', expr: 'product_api.users.id' }],
          materialization: { type: 'view' },
        },
      ],
      model: 'joined_users',
    });

    const root = await mkdtemp(join(tmpdir(), 'sq-deployed-plan-'));
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });
    // The host executes the plan with the existing Dogsled helper. The planner
    // does not fetch rows, manage credentials, or run this query.
    const result = await runQueryCommand({
      projectRoot: root,
      sql: `SELECT COUNT(*) AS n FROM (${plan.sql}) AS planned`,
      apiResourceEntries: plan.sourceBindings.map((binding) => {
        if (binding.runtimeEntry.kind !== 'api_resource') {
          throw new Error('expected api_resource');
        }
        return binding.runtimeEntry;
      }),
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(result.rows[0]?.n).toBe(1n);
  });

  it('shows how a host runs a mixed plan with its own row limit', async () => {
    const plan = planDeployedModelExecution({
      sources: [
        {
          ...liveIssuesSpec,
          name: 'users',
          resource: 'users',
          connection: 'product_api',
        },
        {
          spec_version: '0.2',
          name: 'orders',
          type: 'source',
          source_type: 'warehouse_table',
          connection: 'warehouse',
          table: 'main.orders',
          schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
        },
      ],
      models: [
        {
          spec_version: '0.2',
          name: 'matched_orders',
          type: 'model',
          description: 'Orders that have a current API user.',
          grain: 'id',
          source: { ref: 'warehouse.orders' },
          joins: [
            {
              ref: 'product_api.users',
              alias: 'users',
              type: 'inner',
              on: 'warehouse.orders.id = product_api.users.id',
            },
          ],
          columns: [{ name: 'id', expr: 'warehouse.orders.id' }],
          materialization: { type: 'view' },
        },
      ],
      model: 'matched_orders',
    });

    expect(plan).toMatchObject({ executionMode: 'on_read', mixed: true });
    const liveBinding = plan.sourceBindings.find((binding) => binding.kind === 'api_resource');
    const warehouseBinding = plan.sourceBindings.find(
      (binding) => binding.kind === 'warehouse_table'
    );
    if (liveBinding?.runtimeEntry.kind !== 'api_resource' || !warehouseBinding) {
      throw new Error('expected live and warehouse source bindings');
    }

    const root = await mkdtemp(join(tmpdir(), 'sq-deployed-mixed-'));
    const dbPath = join(root, 'mixed.duckdb');
    const liveTable = liveBinding.internalTable.split('.')[1]!;
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }, { id: 3 }],
      limitReached: false,
    });

    // The host fetches and stages the live binding with an existing helper.
    await runQueryCommand({
      projectRoot: root,
      sql: `SELECT * FROM ${liveBinding.internalTable}`,
      apiResourceEntries: [liveBinding.runtimeEntry],
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      resolveDestinationImpl: async () => ({
        kind: 'duckdb',
        schema: 'sources',
        table: liveTable,
        fullyQualified: `sources.${liveTable}`,
        sqlRunnerKind: 'duckdb',
        config: {
          dest: 'duckdb',
          dbPath,
          targetSchema: 'sources',
          bufferSize: 100_000,
          logFormat: 'json',
          maxConcurrentLoads: 1,
        },
      }),
    });

    const engineRunner = await buildDuckDbRunner(duckIntegration('engine', dbPath));
    try {
      const warehouseTable = warehouseBinding.internalTable.split('.')[1]!;
      const warehouseEntry = warehouseBinding.entry;
      if (warehouseEntry.kind !== 'warehouse_table') {
        throw new Error('expected a warehouse source binding');
      }
      const sourceRunner: SqlRunnerModule = {
        run: vi.fn(),
        query: vi.fn().mockResolvedValue([{ id: 1n }, { id: 2n }]),
        close: vi.fn(),
      };
      // The host supplies and enforces this warehouse row limit. The plan does
      // not contain or enforce it.
      await materializeWarehouseLeaf({
        entry: warehouseEntry,
        sourceName: warehouseTable,
        schema: 'sources',
        database: createRunnerDuckDbDestination(engineRunner),
        engineRunner,
        sourceRunner,
        dialect: 'duckdb',
        tempDir: root,
        mode: 'live',
        currentFilterHash: 'mixed-plan-orders',
        nowIso: '2026-08-05T00:00:00.000Z',
        maxRows: 100,
      });

      const rows = (await engineRunner.query!(plan.sql)) as Array<{ id: bigint }>;
      expect(rows.map((row) => Number(row.id))).toEqual([1]);
      expect(queryResourceImpl).toHaveBeenCalledTimes(1);
      expect(sourceRunner.query).toHaveBeenCalledTimes(1);
    } finally {
      await engineRunner.close?.();
    }
  });
});

describe('source-query library export', () => {
  it('runs with injected apiResourceEntries and no sources/ dir on disk', async () => {
    // Empty project root: no sources/ directory exists at all.
    const root = await mkdtemp(join(tmpdir(), 'sq-entries-'));
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }, { id: 2 }],
      limitReached: false,
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    const result = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT COUNT(*) AS n FROM sources.issues',
      apiResourceEntries: [makeEntry(liveIssuesSpec)],
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(result.rows[0]?.n).toBe(2n);
    expect(result.receipts[0]).toContain('target=in_memory');
    expect(result.receipts[0]).toContain('action=live');
  });

  it('runs with injected defaultDestination and no .bobsled/config.yml', async () => {
    // No .bobsled/config.yml and no sources/ dir — both defaults are injected.
    const root = await mkdtemp(join(tmpdir(), 'sq-dest-'));
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    const first = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      apiResourceEntries: [makeEntry(lazyIssuesSpec)],
      defaultDestination: {
        dest: 'duckdb',
        dbPath: join(root, 'injected.duckdb'),
        targetSchema: 'analytics',
      },
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:00:00.000Z',
    });
    const second = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT COUNT(*) AS n FROM sources.issues',
      apiResourceEntries: [makeEntry(lazyIssuesSpec)],
      defaultDestination: {
        dest: 'duckdb',
        dbPath: join(root, 'injected.duckdb'),
        targetSchema: 'analytics',
      },
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:05:00.000Z',
    });

    // A lazy source persisted into the injected DuckDB destination is reused on
    // the second call, proving the destination was driven from defaultDestination
    // rather than a (nonexistent) .bobsled/config.yml.
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(first.receipts[0]).toContain('target=duckdb');
    expect(second.rows[0]?.n).toBe(1n);
    expect(second.receipts[0]).toContain('action=reused');
  });

  it('forwards injected secrets to the queryResourceImpl call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sq-secrets-'));
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      apiResourceEntries: [makeEntry(liveIssuesSpec)],
      secrets: { GH_TOKEN: 'injected-secret' },
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { GH_TOKEN: 'injected-secret' },
      })
    );
  });

  it('rejects injected entries with duplicate source names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sq-dupe-'));
    const queryResourceImpl = vi.fn().mockResolvedValue({ records: [], limitReached: false });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    // Two entries resolve to the same source name ("issues"); the disk loader
    // throws on duplicates, so the injected path must too rather than silently
    // letting the later entry shadow the earlier one.
    await expect(
      runQueryCommand({
        projectRoot: root,
        sql: 'SELECT * FROM sources.issues',
        apiResourceEntries: [makeEntry(liveIssuesSpec), makeEntry(lazyIssuesSpec)],
        queryResourceImpl,
        integrationSpecLoader: specLoader,
      })
    ).rejects.toThrow(/Duplicate api_resource source name "issues"/);
    expect(queryResourceImpl).not.toHaveBeenCalled();
  });

  it('does not coalesce concurrent queries that differ only by injected secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sq-dedup-'));
    // Resolve slowly so both queries overlap in flight before either completes.
    const queryResourceImpl = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ records: [{ id: 1 }], limitReached: false }), 20)
          )
      );
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    // inFlightDedup ON: same SQL + destination would coalesce without the
    // request-scoped override guard. Different secrets must stay independent.
    const common = {
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      apiResourceEntries: [makeEntry(liveIssuesSpec)],
      integrationSpecLoader: specLoader,
      queryResourceImpl,
      featureFlags: { inFlightDedup: true },
    } as const;

    await Promise.all([
      runQueryCommand({ ...common, secrets: { GH_TOKEN: 'caller-a' } }),
      runQueryCommand({ ...common, secrets: { GH_TOKEN: 'caller-b' } }),
    ]);

    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: { GH_TOKEN: 'caller-a' } })
    );
    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: { GH_TOKEN: 'caller-b' } })
    );
  });
});

describe('warehouse-leaf staging brick public export', () => {
  it('exposes stageWarehouseSourceIntoDuckDb + createRunnerDuckDbDestination from the public surface', () => {
    // Host apps (a downstream cross-source-query container) import these to stage a
    // foreign warehouse table into their DuckDB/DuckLake engine before resolving a
    // derived model that joins it with live/lazy sources.
    expect(typeof stageWarehouseSourceIntoDuckDb).toBe('function');
    expect(typeof createRunnerDuckDbDestination).toBe('function');
  });

  it('stages a host-runner warehouse leaf into a DuckDB engine, queryable as sources.<name>', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wh-stage-'));
    const engineRunner = await buildDuckDbRunner(
      duckIntegration('engine', join(dir, 'engine.duckdb'))
    );
    try {
      // The host owns the engine DuckDB (here a file).
      // Ensure the sources schema exists, then wrap
      // the engine runner as the DatabaseDestination the brick writes through.
      await engineRunner.run('CREATE SCHEMA IF NOT EXISTS sources');
      const database = createRunnerDuckDbDestination(engineRunner);

      // The host-provided warehouse runner uses a mock connection
      // returning two rows, including a BIGINT id to confirm
      // precision survives the JSONL hop.
      const sourceRunner: SqlRunnerModule = {
        run: vi.fn(),
        query: vi.fn().mockResolvedValue([
          { id: 9007199254740993n, name: 'acme' },
          { id: 2n, name: 'globex' },
        ]),
        close: vi.fn(),
      };

      const entry = {
        kind: 'warehouse_table',
        fqRef: 'main.accounts',
        connection: 'crm',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'name', type: 'string' },
        ],
      } as unknown as Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

      const result = await stageWarehouseSourceIntoDuckDb({
        entry,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        sourceRunner,
        dialect: 'duckdb',
        tempDir: dir,
      });

      expect(result).toEqual({ sourceName: 'accounts', rowsAffected: 2 });

      // Queryable as sources.accounts, with BIGINT precision intact (not narrowed
      // to 9007199254740992 by a JS number round-trip).
      const rows = (await engineRunner.query!(
        'SELECT id::VARCHAR AS id, name FROM sources.accounts ORDER BY name'
      )) as Array<{ id: string; name: string }>;
      expect(rows).toEqual([
        { id: '9007199254740993', name: 'acme' },
        { id: '2', name: 'globex' },
      ]);
    } finally {
      await engineRunner.close?.();
    }
  });
});

describe('materializeWarehouseLeaf freshness wrapper (public export)', () => {
  const warehouseEntry = {
    kind: 'warehouse_table',
    fqRef: 'main.accounts',
    connection: 'crm',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'string' },
    ],
  } as unknown as Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

  function countingSourceRunner(): SqlRunnerModule {
    return {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([
        { id: 1n, name: 'acme' },
        { id: 2n, name: 'globex' },
      ]),
      close: vi.fn(),
    };
  }

  it('lazy: stages on the first read, then reuses within max_age without re-querying the warehouse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wh-lazy-'));
    const engineRunner = await buildDuckDbRunner(duckIntegration('engine', join(dir, 'e.duckdb')));
    const sourceRunner = countingSourceRunner();
    try {
      const database = createRunnerDuckDbDestination(engineRunner);
      const common = {
        entry: warehouseEntry,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        engineRunner,
        sourceRunner,
        dialect: 'duckdb' as const,
        tempDir: dir,
        mode: 'lazy' as const,
        maxAge: '1h',
        currentFilterHash: 'fh-accounts',
      };

      const first = await materializeWarehouseLeaf({
        ...common,
        nowIso: '2026-06-19T12:00:00.000Z',
      });
      expect(first.action).toBe('materialized');
      expect(first.records).toBe(2);
      expect(sourceRunner.query).toHaveBeenCalledTimes(1);

      // 5 minutes later, still inside the 1h window → reuse the staged snapshot;
      // the warehouse runner is NOT consulted again.
      const second = await materializeWarehouseLeaf({
        ...common,
        nowIso: '2026-06-19T12:05:00.000Z',
      });
      expect(second.action).toBe('reused');
      expect(second.records).toBe(2);
      expect(sourceRunner.query).toHaveBeenCalledTimes(1);

      // Still queryable as sources.accounts.
      const rows = (await engineRunner.query!(
        'SELECT COUNT(*) AS n FROM sources.accounts'
      )) as Array<{ n: bigint }>;
      expect(Number(rows[0]?.n)).toBe(2);
    } finally {
      await engineRunner.close?.();
    }
  });

  it('lazy: re-stages once the snapshot ages past max_age', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wh-lazy-age-'));
    const engineRunner = await buildDuckDbRunner(duckIntegration('engine', join(dir, 'e.duckdb')));
    const sourceRunner = countingSourceRunner();
    try {
      const database = createRunnerDuckDbDestination(engineRunner);
      const common = {
        entry: warehouseEntry,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        engineRunner,
        sourceRunner,
        dialect: 'duckdb' as const,
        tempDir: dir,
        mode: 'lazy' as const,
        maxAge: '1h',
        currentFilterHash: 'fh-accounts',
      };

      await materializeWarehouseLeaf({ ...common, nowIso: '2026-06-19T12:00:00.000Z' });
      // 2 hours later → past the 1h window → re-read the warehouse.
      const restaged = await materializeWarehouseLeaf({
        ...common,
        nowIso: '2026-06-19T14:00:00.000Z',
      });
      expect(restaged.action).toBe('materialized');
      expect(sourceRunner.query).toHaveBeenCalledTimes(2);
    } finally {
      await engineRunner.close?.();
    }
  });

  it('live: re-reads the warehouse on every call and never reports a cache hit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wh-live-'));
    const engineRunner = await buildDuckDbRunner(duckIntegration('engine', join(dir, 'e.duckdb')));
    const sourceRunner = countingSourceRunner();
    try {
      const database = createRunnerDuckDbDestination(engineRunner);
      const common = {
        entry: warehouseEntry,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        engineRunner,
        sourceRunner,
        dialect: 'duckdb' as const,
        tempDir: dir,
        mode: 'live' as const,
        currentFilterHash: 'fh-accounts',
      };

      const first = await materializeWarehouseLeaf({
        ...common,
        nowIso: '2026-06-19T12:00:00.000Z',
      });
      const second = await materializeWarehouseLeaf({
        ...common,
        nowIso: '2026-06-19T12:00:01.000Z',
      });
      expect(first.action).toBe('live');
      expect(second.action).toBe('live');
      expect(sourceRunner.query).toHaveBeenCalledTimes(2);
    } finally {
      await engineRunner.close?.();
    }
  });

  it('enforces the maxRows ceiling on the (re)stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wh-cap-'));
    const engineRunner = await buildDuckDbRunner(duckIntegration('engine', join(dir, 'e.duckdb')));
    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([
        { id: 1n, name: 'a' },
        { id: 2n, name: 'b' },
        { id: 3n, name: 'c' },
      ]),
      close: vi.fn(),
    };
    try {
      const database = createRunnerDuckDbDestination(engineRunner);
      await expect(
        materializeWarehouseLeaf({
          entry: warehouseEntry,
          sourceName: 'accounts',
          schema: 'sources',
          database,
          engineRunner,
          sourceRunner,
          dialect: 'duckdb',
          tempDir: dir,
          mode: 'live',
          currentFilterHash: 'fh-accounts',
          nowIso: '2026-06-19T12:00:00.000Z',
          maxRows: 2,
        })
      ).rejects.toThrow(/exceeds the staging row ceiling of 2 rows/);
    } finally {
      await engineRunner.close?.();
    }
  });
});
