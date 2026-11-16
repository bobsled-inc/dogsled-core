import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildDuckDbRunner } from '@bobsled-inc/connections';
import {
  resolveSourceEntry,
  SourceSpecSchema,
  type SourceRegistryEntry,
} from '@bobsled-inc/model-spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LazyQueryEngine } from '../../src/runtime/lazy-query-engine.js';
import { detectModelReferences, resolveModelReferences } from '../../src/runtime/model-query.js';

import type { DuckDbIntegration } from '@bobsled-inc/connections';
import type { ApiResourceEntry } from '../../src/runtime/source-materializer/load-specs.js';

let tmpDir = '';

function duckIntegration(name: string, dbPath: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath, read_only: true },
  };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function queryDuckDb(dbPath: string, sql: string): Promise<Record<string, unknown>[]> {
  const runner = await buildDuckDbRunner(duckIntegration('q', dbPath));
  try {
    return await runner.query!(sql);
  } finally {
    await runner.close?.();
  }
}

function makeEntry(raw: Record<string, unknown>): ApiResourceEntry {
  const parsed = SourceSpecSchema.parse(raw);
  const entry = resolveSourceEntry(parsed) as SourceRegistryEntry;
  if (entry.kind !== 'api_resource') throw new Error('expected an api_resource source entry');
  return entry as ApiResourceEntry;
}

/**
 * Write a single-integration Model Spec project on disk so `loadProject` /
 * `compileProject` resolve the derived models. The DuckDB integration `lake`
 * is the model build target; the engine is driven separately with injected
 * `apiResourceEntries` + `defaultDestination`, so the integration auth path is
 * never opened by the model-query front-end (it only compiles SQL).
 */
async function writeProject(
  projectDir: string,
  dbPath: string,
  opts: { mode: 'live' | 'lazy' } = { mode: 'live' }
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
  // stg_issues: a view over sources.issues.
  await writeFile(
    path.join(projectDir, 'models', 'stg_issues.yml'),
    `spec_version: '0.2'
name: stg_issues
type: model
description: Derived view over the issues source.
grain: issue_id
source: { ref: lake.issues }
columns:
  - { name: issue_id, expr: id, primary_key: true }
  - { name: title, expr: title }
materialization: { type: view }
`
  );
  // mrt_issues: a model-on-model (nested) over stg_issues.
  await writeFile(
    path.join(projectDir, 'models', 'mrt_issues.yml'),
    `spec_version: '0.2'
name: mrt_issues
type: model
description: Aggregated mart over stg_issues.
grain: total
source: { ref: stg_issues }
columns:
  - { name: total, expr: count(*), primary_key: true }
materialization: { type: view }
`
  );
}

const issuesSpec = (mode: 'live' | 'lazy'): Record<string, unknown> => ({
  spec_version: '0.2',
  name: 'issues',
  type: 'source',
  source_type: 'api_resource',
  integration: 'github',
  resource: 'issues',
  connection: 'github_prod',
  mode,
  schema: {
    columns: [
      { name: 'id', type: 'INTEGER' },
      { name: 'title', type: 'STRING' },
    ],
  },
});

function fetchStub(rows: Array<Record<string, unknown>>) {
  return vi.fn().mockResolvedValue({ records: rows, limitReached: false });
}

const specLoader = () => ({ integration: {} as never, resource: {} as never });

describe('detectModelReferences (pure)', () => {
  const models = ['stg_issues', 'mrt_issues'];

  it('detects a bare model name in FROM', () => {
    expect(detectModelReferences('SELECT * FROM stg_issues', models)).toEqual(['stg_issues']);
  });

  it('is case-insensitive', () => {
    expect(detectModelReferences('SELECT * FROM STG_Issues', models)).toEqual(['stg_issues']);
  });

  it('detects models in JOIN as well as FROM', () => {
    expect(
      detectModelReferences('SELECT * FROM stg_issues JOIN mrt_issues ON 1=1', models).sort()
    ).toEqual(['mrt_issues', 'stg_issues']);
  });

  it('ignores qualified sources.X references', () => {
    expect(detectModelReferences('SELECT * FROM sources.issues', models)).toEqual([]);
  });

  it('ignores names inside string literals and comments', () => {
    expect(
      detectModelReferences(
        "SELECT 'from stg_issues' AS x -- FROM mrt_issues\nFROM sources.issues",
        models
      )
    ).toEqual([]);
  });

  it('excludes a model shadowed by a user WITH CTE of the same name', () => {
    expect(
      detectModelReferences('WITH stg_issues AS (SELECT 1) SELECT * FROM stg_issues', models)
    ).toEqual([]);
  });

  it('excludes a model shadowed by a user CTE with an explicit column list', () => {
    expect(
      detectModelReferences(
        'WITH stg_issues(a, b) AS (SELECT 1, 2) SELECT * FROM stg_issues',
        models
      )
    ).toEqual([]);
  });

  it('leaves unknown bare identifiers untouched', () => {
    expect(detectModelReferences('SELECT * FROM some_other_table', models)).toEqual([]);
  });
});

describe('resolveModelReferences (front-end + real engine)', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-model-query-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  function engineFor(
    dbPath: string,
    queryResourceImpl: ReturnType<typeof fetchStub>,
    mode: 'live' | 'lazy'
  ) {
    return new LazyQueryEngine({
      projectRoot: tmpDir,
      apiResourceEntries: [makeEntry(issuesSpec(mode))],
      defaultDestination: { dest: 'duckdb', dbPath, targetSchema: 'sources' },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: specLoader as never,
    });
  }

  it('returns SQL unchanged when no models are referenced (no-op)', async () => {
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, path.join(tmpDir, 'data.duckdb'));
    const sql = 'SELECT COUNT(*) AS n FROM sources.issues';
    await expect(resolveModelReferences(sql, projectDir)).resolves.toBe(sql);
  });

  it('runs a SELECT over a derived view model on a live source and refetches on a second call', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ]);
    const engine = engineFor(dbPath, queryResourceImpl, 'live');

    const resolved = await resolveModelReferences(
      'SELECT issue_id, title FROM stg_issues ORDER BY issue_id',
      projectDir
    );
    expect(resolved).toMatch(/^WITH stg_issues AS/i);
    // The compiler's `"sources"."issues"` is normalized to the engine's logical
    // `sources."issues"` token so `referencedSources` hydrates it.
    expect(resolved).toContain('sources."issues"');

    const first = await engine.runQuery(resolved);
    expect(first.rows).toEqual([
      { issue_id: 1n, title: 'first' },
      { issue_id: 2n, title: 'second' },
    ]);
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);

    // A live source refetches on every read.
    await engine.runQuery(resolved);
    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
  });

  it('serves a lazy source from cache on the second call', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'lazy' });

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);
    const engine = new LazyQueryEngine({
      projectRoot: tmpDir,
      apiResourceEntries: [makeEntry(issuesSpec('lazy'))],
      defaultDestination: { dest: 'duckdb', dbPath, targetSchema: 'sources' },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: specLoader as never,
      nowIso: '2026-06-15T00:00:00.000Z',
    });

    const resolved = await resolveModelReferences('SELECT * FROM stg_issues', projectDir);
    await engine.runQuery(resolved, { nowIso: '2026-06-15T00:00:00.000Z' });
    await engine.runQuery(resolved, { nowIso: '2026-06-15T00:01:00.000Z' });
    // The lazy snapshot is still fresh; no second fetch.
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
  });

  it('joins a derived model and a direct sources.X reference', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ]);
    const engine = engineFor(dbPath, queryResourceImpl, 'live');

    const resolved = await resolveModelReferences(
      'SELECT m.issue_id, s.title FROM stg_issues m JOIN sources.issues s ON m.issue_id = s.id ORDER BY m.issue_id',
      projectDir
    );
    const result = await engine.runQuery(resolved);
    expect(result.rows).toEqual([
      { issue_id: 1n, title: 'first' },
      { issue_id: 2n, title: 'second' },
    ]);
  });

  it('resolves a nested model-on-model query with one spliced CTE', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
      { id: 3, title: 'third' },
    ]);
    const engine = engineFor(dbPath, queryResourceImpl, 'live');

    const resolved = await resolveModelReferences('SELECT total FROM mrt_issues', projectDir);
    // inlineDeps folds stg_issues into mrt_issues — exactly one model CTE.
    expect(resolved.match(/\bAS\s*\(/gi)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(resolved).toMatch(/^WITH mrt_issues AS/i);

    const result = await engine.runQuery(resolved);
    expect(result.rows).toEqual([{ total: 3n }]);
  });

  it('merges a pre-existing user WITH clause, injecting the model CTE first', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, dbPath, { mode: 'live' });

    const queryResourceImpl = fetchStub([
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ]);
    const engine = engineFor(dbPath, queryResourceImpl, 'live');

    const userSql =
      'WITH titled AS (SELECT title FROM stg_issues) SELECT COUNT(*) AS n FROM titled';
    const resolved = await resolveModelReferences(userSql, projectDir);
    // Model CTE must precede the user CTE so `titled` can reference it.
    expect(resolved.toLowerCase().indexOf('stg_issues as')).toBeLessThan(
      resolved.toLowerCase().indexOf('titled as')
    );

    const result = await engine.runQuery(resolved);
    expect(result.rows).toEqual([{ n: 2n }]);
  });

  it('persists nothing — a fresh connection shows no model tables/views', async () => {
    const dbPath = path.join(tmpDir, 'data.duckdb');
    const projectDir = path.join(tmpDir, 'project');
    // Use a lazy source so the engine writes the cache into the file-based
    // DuckDB (a single pure-live source resolves to :memory: and never touches
    // disk). This proves the spliced model CTE itself leaves no table/view
    // behind even when the underlying source IS persisted.
    await writeProject(projectDir, dbPath, { mode: 'lazy' });

    const queryResourceImpl = fetchStub([{ id: 1, title: 'first' }]);
    const engine = new LazyQueryEngine({
      projectRoot: tmpDir,
      apiResourceEntries: [makeEntry(issuesSpec('lazy'))],
      defaultDestination: { dest: 'duckdb', dbPath, targetSchema: 'sources' },
      queryResourceImpl: queryResourceImpl as never,
      integrationSpecLoader: specLoader as never,
    });

    const resolved = await resolveModelReferences('SELECT * FROM stg_issues', projectDir);
    await engine.runQuery(resolved);

    const tables = await queryDuckDb(
      dbPath,
      "SELECT table_name FROM information_schema.tables WHERE lower(table_name) IN ('stg_issues','mrt_issues')"
    );
    expect(tables).toEqual([]);
  });

  it('errors when a model CTE name collides with a user table alias', async () => {
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, path.join(tmpDir, 'data.duckdb'), { mode: 'live' });

    await expect(
      resolveModelReferences(
        'SELECT * FROM sources.issues AS stg_issues JOIN stg_issues ON 1=1',
        projectDir
      )
    ).rejects.toThrow(/collides with a table\/CTE alias/i);
  });

  it('errors on a bare (no-AS) alias that collides with a model name', async () => {
    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, path.join(tmpDir, 'data.duckdb'), { mode: 'live' });

    await expect(
      resolveModelReferences(
        'SELECT * FROM sources.issues stg_issues JOIN stg_issues ON 1=1',
        projectDir
      )
    ).rejects.toThrow(/collides with a table\/CTE alias/i);
  });
});
