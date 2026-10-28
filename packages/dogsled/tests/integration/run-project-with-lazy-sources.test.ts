import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildDuckDbRunner, CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProjectWithLazySources } from '../../src/runtime/source-materializer/run-project-with-lazy-sources.js';

import type { DuckDbIntegration } from '@bobsled-inc/connections';
import type { QueryResourceResult } from '@bobsled-inc/extractor';
import type { ApiResourceEntry } from '../../src/runtime/source-materializer/load-specs.js';

let tmpDir = '';

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

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/** Row shape for the API-stub records fed into the live/lazy source. */
interface IssueRecord {
  id: number;
  title: string;
}

async function queryDuckDb<TRow>(dbPath: string, sql: string): Promise<TRow[]> {
  const runner = await buildDuckDbRunner(duckIntegration('q', dbPath));
  try {
    return (await runner.query!(sql)) as TRow[];
  } finally {
    await runner.close?.();
  }
}

/**
 * Write a single-integration Model Spec project whose `lake` integration is a
 * file-based DuckDB. The api_resource source `issues` is connected to that
 * same `lake` handle, and a derived `view` model selects from it.
 */
async function writeProject(
  projectDir: string,
  dbPath: string,
  opts: { mode: 'live' | 'lazy'; materialization?: string } = { mode: 'live' }
): Promise<void> {
  await writeFile(
    path.join(projectDir, 'model-spec.yml'),
    `sources_dir: sources
models_dir: models
integrations_dir: integrations
`
  );
  await writeFile(
    path.join(projectDir, 'integrations', 'lake.yml'),
    `spec_version: '1'
type: integration
name: lake
source_type: duckdb
connection:
  schema: sources
auth:
  type: file
  path: ${JSON.stringify(dbPath)}
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'issues.yml'),
    `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: lake
mode: ${opts.mode}
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: title, type: STRING }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'stg_issues.yml'),
    `spec_version: '0.2'
name: stg_issues
type: model
description: Derived view over the live issues source.
grain: issue_id
source: { ref: lake.issues }
columns:
  - { name: issue_id, expr: id, primary_key: true }
  - { name: title, expr: title }
materialization: { type: ${opts.materialization ?? 'view'} }
`
  );
}

function liveIssuesEntry(mode: 'live' | 'lazy'): ApiResourceEntry {
  return {
    kind: 'api_resource',
    fqRef: 'sources.issues',
    integration: 'github',
    resource: 'issues',
    connection: 'lake',
    mode,
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'title', type: 'string' },
    ],
  } as ApiResourceEntry;
}

/** A `queryResource` stub that returns fixed rows and counts its invocations. */
function fetchStub(rows: IssueRecord[]) {
  return vi.fn(
    async (): Promise<QueryResourceResult<IssueRecord>> => ({
      records: rows,
      requestCount: 1,
      notModified: false,
      limitReached: false,
    })
  );
}

describe('runProjectWithLazySources', () => {
  it('does not hydrate a live API source used only by an agent tool', async () => {
    const projectDir = path.join(tmpDir, 'agent-tools');
    await writeProject(projectDir, path.join(tmpDir, 'agent.duckdb'));
    await fs.rm(path.join(projectDir, 'models', 'stg_issues.yml'));
    await writeFile(
      path.join(projectDir, 'sources', 'prepared.yml'),
      `spec_version: '0.2'
type: source
name: prepared
source_type: warehouse_table
connection: lake
table: main.prepared
schema:
  columns:
    - { name: id, type: integer, primary_key: true }
`
    );
    await writeFile(
      path.join(projectDir, 'models', 'assessment.yml'),
      `spec_version: '0.2'
type: model
model_kind: agentic
name: assessment
description: Read a scoped API source during an assessment.
grain: [id]
sources:
  prepared: { ref: lake.prepared }
  issues: { ref: lake.issues }
llm: { profile: review }
limits: { tokens: 1000, timeout_seconds: 60 }
plan:
  steps:
    - id: assess
      source: { ref: prepared }
      map: { over: prepared, group_by: [id] }
      execution: { mode: agent_loop }
      sources: [issues]
      instructions: Read the issue source if needed.
      columns:
        - { name: id, type: integer, nullable: false }
output: { from: assess }
materialization: { type: table, strategy: replace_processed_keys, keys: [id] }
`
    );
    const queryResourceImpl = fetchStub([{ id: 1, title: 'must not fetch' }]);
    const runProjectImpl = vi.fn(async () => ({ ok: true }) as never);
    const resolveDestinationImpl = vi.fn();
    const result = await runProjectWithLazySources({
      projectRoot: projectDir,
      queryResourceImpl: queryResourceImpl as never,
      resolveDestinationImpl,
      runProjectImpl: runProjectImpl as never,
    });
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(resolveDestinationImpl).not.toHaveBeenCalled();
    expect(runProjectImpl).toHaveBeenCalledOnce();
    expect(result.hydration).toEqual([]);
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-lazy-derived-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('hydrates a live api_resource leaf and builds a derived view that returns the fetched rows', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ]);

    const result = await runProjectWithLazySources({
      projectRoot: projectDir,
      integration: 'lake',
      apiResourceEntries: [liveIssuesEntry('live')],
      defaultDestination: { dest: 'duckdb', dbPath },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: (() => ({
        integration: {} as never,
        resource: { query: {} } as never,
      })) as never,
    });

    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(result.hydration).toHaveLength(1);
    // A live leaf reports `action: 'live'` (refetched every run, never reused).
    expect(result.hydration[0]?.action).toBe('live');
    expect(result.run.ok).toBe(true);

    // The derived model build sees the hydrated sources.issues table in the
    // same DuckDB file and the view returns the fetched rows.
    await expect(
      queryDuckDb(dbPath, 'SELECT issue_id, title FROM sources.stg_issues ORDER BY issue_id')
    ).resolves.toEqual([
      { issue_id: 1n, title: 'first' },
      { issue_id: 2n, title: 'second' },
    ]);
    // The leaf table itself was hydrated into sources.issues.
    await expect(queryDuckDb(dbPath, 'SELECT COUNT(*) AS c FROM sources.issues')).resolves.toEqual([
      { c: 2n },
    ]);
  });

  it('rejects a table materialization rooted on a live source (live-as-view guard)', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live', materialization: 'table' });

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);

    await expect(
      runProjectWithLazySources({
        projectRoot: projectDir,
        integration: 'lake',
        apiResourceEntries: [liveIssuesEntry('live')],
        defaultDestination: { dest: 'duckdb', dbPath },
        queryResourceImpl: queryResourceImpl as never,
        integrationSpecLoader: (() => ({
          integration: {} as never,
          resource: { query: {} } as never,
        })) as never,
      })
    ).rejects.toThrow(/view-only|live source/i);

    // The guard fires before any API fetch — no rows were materialized.
    expect(queryResourceImpl).not.toHaveBeenCalled();
  });

  it('rejects a transitive table materialization rooted on a live source', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });
    await writeFile(
      path.join(projectDir, 'models', 'issues_table.yml'),
      `spec_version: '0.2'
name: issues_table
type: model
description: Persisted model over an intermediate live view.
grain: issue_id
source: { ref: stg_issues }
columns:
  - { name: issue_id, expr: issue_id, primary_key: true }
materialization: { type: table }
`
    );
    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);

    await expect(
      runProjectWithLazySources({
        projectRoot: projectDir,
        integration: 'lake',
        apiResourceEntries: [liveIssuesEntry('live')],
        defaultDestination: { dest: 'duckdb', dbPath },
        queryResourceImpl: queryResourceImpl as never,
        integrationSpecLoader: (() => ({
          integration: {} as never,
          resource: { query: {} } as never,
        })) as never,
      })
    ).rejects.toThrow(/issues_table.*view-only|live source/i);

    expect(queryResourceImpl).not.toHaveBeenCalled();
  });

  it('errors clearly when the source cache and model integration target different DuckDB files', async () => {
    const sourceDbPath = path.join(tmpDir, 'source.duckdb');
    const modelDbPath = path.join(tmpDir, 'model.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    // The model integration points at model.duckdb …
    await writeProject(projectDir, modelDbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);

    await expect(
      runProjectWithLazySources({
        projectRoot: projectDir,
        integration: 'lake',
        apiResourceEntries: [liveIssuesEntry('live')],
        // … but the source cache resolves to a different file.
        defaultDestination: { dest: 'duckdb', dbPath: sourceDbPath },
        queryResourceImpl: queryResourceImpl as never,
        integrationSpecLoader: (() => ({
          integration: {} as never,
          resource: { query: {} } as never,
        })) as never,
      })
    ).rejects.toThrow(/does not match the model integration/i);
  });

  it('serves a lazy leaf from cache on the second run without re-fetching', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'lazy' });

    const rows = [
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ];
    const queryResourceImpl = fetchStub(rows);
    const sharedArgs = {
      projectRoot: projectDir,
      integration: 'lake',
      apiResourceEntries: [liveIssuesEntry('lazy')],
      defaultDestination: { dest: 'duckdb', dbPath },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: (() => ({
        integration: {} as never,
        resource: { query: {} } as never,
      })) as never,
      // Pin nowIso so the lazy max-age window does not drift between runs.
      nowIso: '2026-06-15T00:00:00.000Z',
    };

    const first = await runProjectWithLazySources(sharedArgs);
    expect(first.run.ok).toBe(true);
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);

    const second = await runProjectWithLazySources(sharedArgs);
    expect(second.run.ok).toBe(true);
    // The cached lazy snapshot is still fresh, so no second API fetch happens.
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(second.hydration[0]?.action).toBe('reused');

    await expect(
      queryDuckDb(dbPath, 'SELECT issue_id, title FROM sources.stg_issues ORDER BY issue_id')
    ).resolves.toEqual([
      { issue_id: 1n, title: 'first' },
      { issue_id: 2n, title: 'second' },
    ]);
  });

  it('stages a foreign warehouse leaf into the engine for a live mixed view model', async () => {
    const dbPath = path.join(tmpDir, 'lake.duckdb');
    const crmPath = path.join(tmpDir, 'crm.duckdb');
    // Seed the "warehouse" (a separate DuckDB) with the accounts rows.
    const crmRunner = await buildDuckDbRunner(duckIntegration('crm', crmPath));
    try {
      await crmRunner.run('CREATE TABLE accounts (issue_id INTEGER, owner VARCHAR)');
      await crmRunner.run("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");
    } finally {
      await crmRunner.close?.();
    }

    const projectDir = path.join(tmpDir, 'project');
    await writeFile(
      path.join(projectDir, 'model-spec.yml'),
      'sources_dir: sources\nmodels_dir: models\nintegrations_dir: integrations\n'
    );
    await writeFile(
      path.join(projectDir, 'integrations', 'lake.yml'),
      `spec_version: '1'\ntype: integration\nname: lake\nsource_type: duckdb\nconnection:\n  schema: sources\nauth:\n  type: file\n  path: ${JSON.stringify(dbPath)}\n`
    );
    await writeFile(
      path.join(projectDir, 'integrations', 'crm.yml'),
      `spec_version: '1'\ntype: integration\nname: crm\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(crmPath)}\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'issues.yml'),
      `spec_version: '0.2'\nname: issues\ntype: source\nsource_type: api_resource\nintegration: github\nresource: issues\nconnection: lake\nmode: live\nschema:\n  columns:\n    - { name: id, type: INTEGER }\n    - { name: title, type: STRING }\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'accounts.yml'),
      `spec_version: '0.2'\nname: accounts\ntype: source\nsource_type: warehouse_table\nconnection: crm\ntable: main.accounts\nschema:\n  columns:\n    - { name: issue_id, type: integer, primary_key: true }\n    - { name: owner, type: string }\n`
    );
    await writeFile(
      path.join(projectDir, 'models', 'stg_mixed.yml'),
      `spec_version: '0.2'\nname: stg_mixed\ntype: model\ndescription: Live view joining API issues with warehouse accounts.\ngrain: issue_id\nexecution:\n  engine: lake\nsource: { ref: lake.issues }\njoins:\n  - ref: CRM.Accounts\n    type: inner\n    on: lake.issues.id = CRM.Accounts.issue_id\ncolumns:\n  - { name: issue_id, expr: lake.issues.id, primary_key: true }\n  - { name: title, expr: lake.issues.title }\n  - { name: owner, expr: CRM.Accounts.owner }\nmaterialization: { type: view }\n`
    );

    const queryResourceImpl = fetchStub([
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ]);
    const tokenProvider = vi.fn(async () => ({
      accessToken: 'managed-token',
      expiresAt: 3_600,
    }));
    const runnerContexts: Array<{ name: string; tokenProvider?: unknown }> = [];
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async (integration, context) => {
      runnerContexts.push({ name: integration.name, tokenProvider: context.tokenProvider });
      return buildDuckDbRunner(integration);
    });

    const result = await runProjectWithLazySources({
      projectRoot: projectDir,
      integration: 'lake',
      apiResourceEntries: [liveIssuesEntry('live')],
      defaultDestination: { dest: 'duckdb', dbPath },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: (() => ({
        integration: {} as never,
        resource: { query: {} } as never,
      })) as never,
      runProjectOptions: { customRunners, tokenProvider },
    });

    expect(result.run.ok).toBe(true);
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(runnerContexts.find((context) => context.name === 'crm')?.tokenProvider).toBe(
      tokenProvider
    );
    await expect(
      queryDuckDb(dbPath, 'SELECT issue_id, title, owner FROM sources.stg_mixed ORDER BY issue_id')
    ).resolves.toEqual([
      { issue_id: 1n, title: 'first', owner: 'alice' },
      { issue_id: 2n, title: 'second', owner: 'bob' },
    ]);
  });

  it('delegates a published mixed model (separate engine) to runProject without hydrating or staging', async () => {
    // A `table` + `execution.engine: mart` model is PUBLISHED: the cross-warehouse
    // publisher (inside runProject) stages its leaves into the target warehouse
    // itself. The orchestrator must NOT hydrate the live/lazy leaf or stage/rewrite
    // the foreign warehouse leaf — doing so double-handles the leaf. Here we assert
    // it skips all that and delegates straight to runProject.
    const lakePath = path.join(tmpDir, 'lake.duckdb');
    const martPath = path.join(tmpDir, 'mart.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeFile(
      path.join(projectDir, 'model-spec.yml'),
      'sources_dir: sources\nmodels_dir: models\nintegrations_dir: integrations\n'
    );
    await writeFile(
      path.join(projectDir, 'integrations', 'lake.yml'),
      `spec_version: '1'\ntype: integration\nname: lake\nsource_type: duckdb\nconnection:\n  schema: sources\nauth:\n  type: file\n  path: ${JSON.stringify(lakePath)}\n`
    );
    await writeFile(
      path.join(projectDir, 'integrations', 'mart.yml'),
      `spec_version: '1'\ntype: integration\nname: mart\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(martPath)}\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'issues.yml'),
      `spec_version: '0.2'\nname: issues\ntype: source\nsource_type: api_resource\nintegration: github\nresource: issues\nconnection: lake\nmode: lazy\nschema:\n  columns:\n    - { name: id, type: INTEGER }\n    - { name: title, type: STRING }\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'accounts.yml'),
      `spec_version: '0.2'\nname: accounts\ntype: source\nsource_type: warehouse_table\nconnection: crm\ntable: main.accounts\nschema:\n  columns:\n    - { name: issue_id, type: integer, primary_key: true }\n    - { name: owner, type: string }\n`
    );
    await writeFile(
      path.join(projectDir, 'integrations', 'crm.yml'),
      `spec_version: '1'\ntype: integration\nname: crm\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(path.join(tmpDir, 'crm.duckdb'))}\n`
    );
    await writeFile(
      path.join(projectDir, 'models', 'facts.yml'),
      `spec_version: '0.2'\nname: facts\ntype: model\ndescription: Materialized mixed model published into the mart warehouse.\ngrain: issue_id\nexecution:\n  engine: mart\nsource: { ref: lake.issues }\njoins:\n  - ref: crm.accounts\n    type: left\n    on: lake.issues.id = crm.accounts.issue_id\ncolumns:\n  - { name: issue_id, expr: lake.issues.id, primary_key: true }\n  - { name: title, expr: lake.issues.title }\n  - { name: owner, expr: crm.accounts.owner }\nmaterialization: { type: table }\n`
    );

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);
    const runProjectImpl = vi.fn(async () => ({ ok: true }) as never);

    const result = await runProjectWithLazySources({
      projectRoot: projectDir,
      integration: 'mart',
      apiResourceEntries: [liveIssuesEntry('lazy')],
      defaultDestination: { dest: 'duckdb', dbPath: lakePath },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: (() => ({
        integration: {} as never,
        resource: { query: {} } as never,
      })) as never,
      runProjectImpl: runProjectImpl as never,
    });

    // The orchestrator did NOT hydrate the lazy leaf (the publisher will), and
    // delegated to runProject with the mart engine and the project UNREWRITTEN.
    expect(queryResourceImpl).not.toHaveBeenCalled();
    expect(result.hydration).toHaveLength(0);
    expect(runProjectImpl).toHaveBeenCalledTimes(1);
    const [, runOpts] = runProjectImpl.mock.calls[0] as [
      string,
      { integration?: string; project: { sourceEntries: Map<string, { fqRef: string }> } },
    ];
    expect(runOpts.integration).toBe('mart');
    // crm.accounts keeps its physical warehouse ref — the publisher reads it from
    // its own connection, not a staged sources.* table.
    expect(runOpts.project.sourceEntries.get('crm.accounts')?.fqRef).toBe('main.accounts');
  });

  it('rejects a published model that targets the live source cache file (same-file guard)', async () => {
    // execution.engine == the live cache DuckDB. Publishing into the cache file
    // corrupts it (orchestrator + publisher open it as two handles), so the
    // orchestrator rejects it up-front before any fetch.
    const dbPath = path.join(tmpDir, 'lake.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'lazy' });
    // Replace the view model with a published table targeting `lake` (== cache).
    await writeFile(
      path.join(projectDir, 'models', 'stg_issues.yml'),
      `spec_version: '0.2'\nname: stg_issues\ntype: model\ndescription: Published table targeting the cache file.\ngrain: issue_id\nexecution:\n  engine: lake\nsource: { ref: lake.issues }\ncolumns:\n  - { name: issue_id, expr: id, primary_key: true }\n  - { name: title, expr: title }\nmaterialization: { type: table }\n`
    );

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);

    await expect(
      runProjectWithLazySources({
        projectRoot: projectDir,
        integration: 'lake',
        apiResourceEntries: [liveIssuesEntry('lazy')],
        defaultDestination: { dest: 'duckdb', dbPath },
        queryResourceImpl: queryResourceImpl as never,
        integrationSpecLoader: (() => ({
          integration: {} as never,
          resource: { query: {} } as never,
        })) as never,
      })
    ).rejects.toThrow(/also the live source cache|corrupts it/i);

    // The guard fires before any API fetch.
    expect(queryResourceImpl).not.toHaveBeenCalled();
  });

  it('auto-selects the only integration when none is passed', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([{ id: 7, title: 'solo' }]);

    const result = await runProjectWithLazySources({
      projectRoot: projectDir,
      // no `integration` passed — resolves to the sole "lake" integration.
      apiResourceEntries: [liveIssuesEntry('live')],
      defaultDestination: { dest: 'duckdb', dbPath },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: (() => ({
        integration: {} as never,
        resource: { query: {} } as never,
      })) as never,
    });

    expect(result.run.ok).toBe(true);
    await expect(
      queryDuckDb(dbPath, 'SELECT issue_id, title FROM sources.stg_issues')
    ).resolves.toEqual([{ issue_id: 7n, title: 'solo' }]);
  });

  it('errors when the project has multiple integrations and none is passed', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });
    // A second integration makes auto-select ambiguous.
    await writeFile(
      path.join(projectDir, 'integrations', 'warehouse.yml'),
      `spec_version: '1'
type: integration
name: warehouse
source_type: duckdb
connection:
  schema: sources
auth:
  type: file
  path: ${JSON.stringify(dbPath)}
`
    );

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);

    await expect(
      runProjectWithLazySources({
        projectRoot: projectDir,
        apiResourceEntries: [liveIssuesEntry('live')],
        defaultDestination: { dest: 'duckdb', dbPath },
        queryResourceImpl: queryResourceImpl as never,
        integrationSpecLoader: (() => ({
          integration: {} as never,
          resource: { query: {} } as never,
        })) as never,
      })
    ).rejects.toThrow(/multiple integrations|pass --integration/i);

    // Ambiguity is caught before any API fetch.
    expect(queryResourceImpl).not.toHaveBeenCalled();
  });
});
