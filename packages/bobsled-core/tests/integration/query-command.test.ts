import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runQueryCommand } from '../../src/commands/query.js';
import { runVqCommand } from '../../src/commands/vq.js';
import { createSqlRunnerFor } from '../../src/runtime/source-materializer/sql-runner-bridge.js';

async function seed(root: string, file: string, body: string): Promise<void> {
  await mkdir(join(root, 'sources'), { recursive: true });
  await writeFile(join(root, 'sources', file), body, 'utf8');
}

async function seedVq(root: string, file: string, body: string): Promise<void> {
  await mkdir(join(root, 'vqs'), { recursive: true });
  await writeFile(join(root, 'vqs', file), body, 'utf8');
}

describe('dogsled query', () => {
  it('mode: live always extracts and runs through in-memory DuckDB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    let calls = 0;
    const queryResourceImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      return { records: [{ id: 1 }], limitReached: false };
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });
    const second = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT COUNT(*) AS n FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(calls).toBe(2);
    expect(second.rows[0]?.n).toBe(1n);
    expect(second.receipts[0]).toContain('target=in_memory');
    expect(second.receipts[0]).toContain('action=live');
  });

  it('reuses metadata on a configured DuckDB destination and rewrites logical source refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'cache.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
max_age: 15m
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    let calls = 0;
    const queryResourceImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      return { records: [{ id: 1 }], limitReached: false };
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:00:00.000Z',
    });
    const second = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT COUNT(*) AS n FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:05:00.000Z',
    });

    expect(calls).toBe(1);
    expect(second.rows[0]?.n).toBe(1n);
    expect(second.receipts[0]).toContain('action=reused');
  });

  it('keeps lazy materializations indefinitely when max_age is omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'lazy.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: lazy
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:00:00.000Z',
    });
    const second = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT COUNT(*) AS n FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2030-04-22T12:00:00.000Z',
    });

    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(second.rows[0]?.n).toBe(1n);
    expect(second.receipts[0]).toContain('action=reused');
  });

  it('does not rewrite logical source refs inside SQL literals or comments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'literal-rewrite.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    const result = await runQueryCommand({
      projectRoot: root,
      sql: `
        SELECT 'sources.issues' AS literal_value, id
        FROM sources.issues
        -- sources.comment_only should not be detected or rewritten
      `,
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(result.rows[0]?.literal_value).toBe('sources.issues');
    expect(result.rows[0]?.id).toBe(1n);
  });

  it('reuses partial lazy slices from SQL LIMIT without replacing the canonical cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'limit-cache.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: lazy
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    const queryResourceImpl = vi.fn().mockImplementation(async ({ limit }: { limit?: number }) => ({
      records: [{ id: 1 }, { id: 2 }].slice(0, limit ?? 2),
      limitReached: (limit ?? 2) < 2,
      requestCount: 1,
    }));
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    const limitedFirst = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues LIMIT 1',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      featureFlags: { partialMaterialization: true },
    });
    const limitedSecond = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues LIMIT 1',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      featureFlags: { partialMaterialization: true },
    });
    const count = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT COUNT(*) AS n FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      featureFlags: { partialMaterialization: true },
    });

    expect(queryResourceImpl).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 1 }));
    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(limitedFirst.rows).toHaveLength(1);
    expect(limitedFirst.receipts[0]).toContain('refresh_reason=partial_rebuild');
    expect(limitedSecond.rows).toHaveLength(1);
    expect(limitedSecond.receipts[0]).toContain('refresh_reason=partial_reuse');
    expect(count.rows).toEqual([{ n: 2n }]);
    expect(count.receipts[0]).toContain('refresh_reason=first_load');
  });

  it('with partialMaterialization off, SQL LIMIT uses the canonical cache (no per-limit table)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'limit-off-cache.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: lazy
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    const queryResourceImpl = vi.fn().mockImplementation(async ({ limit }: { limit?: number }) => ({
      records: [{ id: 1 }, { id: 2 }].slice(0, limit ?? 2),
      limitReached: false,
      requestCount: 1,
    }));
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    // First eligible LIMIT query: with the flag off it must materialize the FULL
    // fetch into the canonical `issues` table (no `__limit_1` slice).
    const first = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues LIMIT 1',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      featureFlags: { partialMaterialization: false },
    });
    // A DIFFERENT limit against the same source must reuse that canonical table —
    // pre-fix this created a separate `issues__limit_5` table and re-fetched.
    const second = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues LIMIT 5',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      featureFlags: { partialMaterialization: false },
    });

    // One canonical table, reused across both limits → a single full fetch.
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
    expect(queryResourceImpl).toHaveBeenCalledWith(expect.not.objectContaining({ limit: 1 }));
    // Never the partial path.
    expect(first.receipts[0]).toContain('refresh_reason=first_load');
    expect(first.receipts[0]).not.toContain('partial');
    expect(second.receipts[0]).not.toContain('partial');
    // LIMIT is applied at read time, not baked into the cache.
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(2);
  });

  it('refreshes lazy max_age slices after the ceiling and then reuses the fresh load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'lazy-max-age.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: lazy
max_age: 1h
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    let nextId = 1;
    const queryResourceImpl = vi.fn().mockImplementation(async () => ({
      records: [{ id: nextId++ }],
      limitReached: false,
    }));
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:00:00.000Z',
    });
    const afterCeiling = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT id FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T13:01:00.000Z',
    });
    const afterRefresh = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT id FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T13:02:00.000Z',
    });

    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(afterCeiling.rows[0]?.id).toBe(2n);
    expect(afterCeiling.receipts[0]).toContain('refresh_reason=refresh_due');
    expect(afterRefresh.rows[0]?.id).toBe(2n);
    expect(afterRefresh.receipts[0]).toContain('action=reused');
  });

  it('keeps relative-date filters stable within a bucket and refreshes at the boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'relative-date.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: lazy
filter:
  updated_at:
    gte: "-1d"
    lte: "@now"
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    let nextId = 1;
    const queryResourceImpl = vi.fn().mockImplementation(async () => ({
      records: [{ id: nextId++ }],
      limitReached: false,
    }));
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    const first = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT id FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:05:00.000Z',
    });
    const sameBucket = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT id FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:59:59.999Z',
    });
    const nextBucket = await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT id FROM sources.issues',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T13:00:00.000Z',
    });

    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(first.rows[0]?.id).toBe(1n);
    expect(sameBucket.rows[0]?.id).toBe(1n);
    expect(sameBucket.receipts[0]).toContain('action=reused');
    expect(nextBucket.rows[0]?.id).toBe(2n);
    expect(nextBucket.receipts[0]).toContain('refresh_reason=first_load');
  });

  it('pushes simple SQL WHERE predicates into the API source filter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [
        { id: 1, state: 'open' },
        { id: 2, state: 'closed' },
      ],
      limitReached: false,
    });
    const specLoader = () => ({
      integration: {} as never,
      resource: {
        name: 'issues',
        query: {
          filters: {
            id: { operators: ['in'] },
            state: { operators: ['eq'] },
          },
        },
      } as never,
    });

    const result = await runQueryCommand({
      projectRoot: root,
      sql: "SELECT id FROM sources.issues AS i WHERE i.state = 'open' AND i.id IN (1, 2)",
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          id: { in: [1, 2] },
          state: { eq: 'open' },
        },
      })
    );
    expect(result.rows).toEqual([{ id: 1n }]);
  });

  it('does not push predicates from source self-joins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: pair_id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    const allRecords = [
      { id: 1, pair_id: 2, state: 'open' },
      { id: 2, pair_id: 1, state: 'closed' },
    ];
    const queryResourceImpl = vi
      .fn()
      .mockImplementation(async ({ filter }: { filter?: Record<string, unknown> }) => {
        let records = allRecords;
        const stateFilter = filter?.state;
        if (stateFilter && typeof stateFilter === 'object' && 'eq' in stateFilter) {
          records = allRecords.filter(
            (record) => record.state === (stateFilter as { eq: string }).eq
          );
        }
        return { records, limitReached: false };
      });
    const specLoader = () => ({
      integration: {} as never,
      resource: {
        name: 'issues',
        query: {
          filters: {
            state: { operators: ['eq'] },
          },
        },
      } as never,
    });

    const result = await runQueryCommand({
      projectRoot: root,
      sql: `
        SELECT left_issue.id AS open_id, right_issue.id AS closed_id
        FROM sources.issues AS left_issue
        JOIN sources.issues AS right_issue ON left_issue.pair_id = right_issue.id
        WHERE left_issue.state = 'open' AND right_issue.state = 'closed'
      `,
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(queryResourceImpl.mock.calls[0]?.[0].filter).toBeUndefined();
    expect(result.rows).toEqual([{ open_id: 1n, closed_id: 2n }]);
  });

  it('does not push predicates from unrelated CTE scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1, state: 'open' }],
      limitReached: false,
    });
    const specLoader = () => ({
      integration: {} as never,
      resource: {
        name: 'issues',
        query: {
          filters: {
            id: { operators: ['eq'] },
            state: { operators: ['eq'] },
          },
        },
      } as never,
    });

    const result = await runQueryCommand({
      projectRoot: root,
      sql: `
        WITH x AS (
          SELECT * FROM (VALUES ('closed')) AS t(state) WHERE state = 'closed'
        )
        SELECT id FROM sources.issues WHERE id = 1
      `,
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          id: { eq: 1 },
        },
      })
    );
    expect(result.rows).toEqual([{ id: 1n }]);
  });

  it('does not let SQL pushdown override a declared scalar source filter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
filter:
  state: closed
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1, state: 'closed' }],
      limitReached: false,
    });
    const specLoader = () => ({
      integration: {} as never,
      resource: {
        name: 'issues',
        query: {
          filters: {
            state: { operators: ['eq'] },
          },
        },
      } as never,
    });

    const result = await runQueryCommand({
      projectRoot: root,
      sql: "SELECT id FROM sources.issues WHERE state = 'open'",
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          state: 'closed',
        },
      })
    );
    expect(result.rows).toEqual([]);
  });

  it('uses distinct physical tables for different pushed filter slices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${join(root, 'filter-slices.duckdb')}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    const queryResourceImpl = vi
      .fn()
      .mockImplementation(async ({ filter }: { filter?: Record<string, unknown> }) => {
        const stateFilter = filter?.state;
        const state =
          stateFilter && typeof stateFilter === 'object' && 'eq' in stateFilter
            ? String((stateFilter as { eq: unknown }).eq)
            : 'unknown';
        return {
          records: [{ id: state === 'open' ? 1 : 2, state }],
          limitReached: false,
        };
      });
    const specLoader = () => ({
      integration: {} as never,
      resource: {
        name: 'issues',
        query: {
          filters: {
            state: { operators: ['eq'] },
          },
        },
      } as never,
    });

    const open = await runQueryCommand({
      projectRoot: root,
      sql: "SELECT id FROM sources.issues WHERE state = 'open'",
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });
    const closed = await runQueryCommand({
      projectRoot: root,
      sql: "SELECT id FROM sources.issues WHERE state = 'closed'",
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });
    const openAgain = await runQueryCommand({
      projectRoot: root,
      sql: "SELECT id FROM sources.issues WHERE state = 'open'",
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    const openTable = open.receipts[0]?.match(/\btable=([^ ]+)/)?.[1];
    const closedTable = closed.receipts[0]?.match(/\btable=([^ ]+)/)?.[1];
    expect(open.rows).toEqual([{ id: 1n }]);
    expect(closed.rows).toEqual([{ id: 2n }]);
    expect(openAgain.rows).toEqual([{ id: 1n }]);
    expect(openAgain.receipts[0]).toContain('action=reused');
    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(openTable).toMatch(/^analytics\.issues__[a-f0-9]{32}$/);
    expect(closedTable).toMatch(/^analytics\.issues__[a-f0-9]{32}$/);
    expect(openTable).not.toBe(closedTable);
  });

  it('runs parameterized VQs through runtime source filters and SQL pushdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
filter:
  state: "\${{ params.status }}"
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    await seedVq(
      root,
      'open_issues.yml',
      `spec_version: '0.2'
type: vq
name: open_issues
nlq: Which issues match the requested status?
sql: SELECT id FROM {github.issues} WHERE state = {status}
parameters:
  - name: status
    type: string
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1, state: 'open' }],
      limitReached: false,
    });
    const specLoader = () => ({
      integration: {} as never,
      resource: {
        name: 'issues',
        query: {
          filters: {
            state: { operators: ['eq'] },
          },
        },
      } as never,
    });

    const result = await runVqCommand({
      projectRoot: root,
      name: 'open_issues',
      params: { status: 'open' },
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    expect(result.sql).toBe("SELECT id FROM sources.issues WHERE state = 'open'");
    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { state: 'open' },
      })
    );
    expect(result.rows).toEqual([{ id: 1n }]);
  });

  it('passes repeatable VQ session values into source.filter templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
filter:
  tenant: "\${{ session.tenant }}"
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: tenant, type: STRING }
`
    );
    await seedVq(
      root,
      'tenant_issues.yml',
      `spec_version: '0.2'
type: vq
name: tenant_issues
nlq: Which tenant issues should I see?
sql: SELECT id FROM {github.issues}
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1, tenant: 'acme' }],
      limitReached: false,
    });

    const result = await runVqCommand({
      projectRoot: root,
      name: 'tenant_issues',
      session: { tenant: 'acme' },
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(queryResourceImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { tenant: 'acme' },
      })
    );
    expect(result.rows).toEqual([{ id: 1n }]);
  });

  it('renders VQ tokens only in executable SQL positions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: state, type: STRING }
`
    );
    await seedVq(
      root,
      'open_issues.yml',
      `spec_version: '0.2'
type: vq
name: open_issues
nlq: Which issues match the requested status?
sql: SELECT '{status}' AS literal_text, id FROM {github.issues} WHERE state = {status} /* {status} {github.issues} */
parameters:
  - name: status
    type: string
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1, state: 'open' }],
      limitReached: false,
    });

    const result = await runVqCommand({
      projectRoot: root,
      name: 'open_issues',
      params: { status: 'open' },
      queryResourceImpl,
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(result.sql).toBe(
      "SELECT '{status}' AS literal_text, id FROM sources.issues WHERE state = 'open' /* {status} {github.issues} */"
    );
    expect(result.rows).toEqual([{ literal_text: '{status}', id: 1n }]);
  });

  it('rejects empty numeric VQ parameters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    await seedVq(
      root,
      'limit_check.yml',
      `spec_version: '0.2'
type: vq
name: limit_check
nlq: Which issues fit the count?
sql: SELECT id FROM {github.issues} LIMIT {count}
parameters:
  - name: count
    type: integer
`
    );

    await expect(
      runVqCommand({
        projectRoot: root,
        name: 'limit_check',
        params: { count: '' },
        queryResourceImpl: vi.fn(),
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow('VQ parameter "count" must be an integer');
  });

  it('rejects VQ source tokens whose qualifier does not match the source integration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    await seedVq(
      root,
      'wrong_source.yml',
      `spec_version: '0.2'
type: vq
name: wrong_source
nlq: Which issues?
sql: SELECT id FROM {stripe.issues}
`
    );

    await expect(
      runVqCommand({
        projectRoot: root,
        name: 'wrong_source',
        queryResourceImpl: vi.fn(),
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow('source token {stripe.issues} targets sources.issues');
  });

  it('validates and canonicalizes VQ date and timestamp parameters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    await seedVq(
      root,
      'recent_activity.yml',
      `spec_version: '0.2'
type: vq
name: recent_activity
nlq: Which activity is in range?
sql: SELECT {created_after} AS created_after, {created_on} AS created_on, id FROM {github.issues}
parameters:
  - name: created_after
    type: timestamp
  - name: created_on
    type: date
`
    );

    const result = await runVqCommand({
      projectRoot: root,
      name: 'recent_activity',
      params: {
        created_after: '2024-01-02T03:04:05Z',
        created_on: '2024-01-02',
      },
      queryResourceImpl: vi.fn().mockResolvedValue({
        records: [{ id: 1 }],
        limitReached: false,
      }),
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
    });

    expect(result.sql).toBe(
      "SELECT '2024-01-02T03:04:05.000Z' AS created_after, '2024-01-02' AS created_on, id FROM sources.issues"
    );
    await expect(
      runVqCommand({
        projectRoot: root,
        name: 'recent_activity',
        params: {
          created_after: '2024-01-02T03:04:05Z',
          created_on: '2024-02-31',
        },
        queryResourceImpl: vi.fn().mockResolvedValue({
          records: [{ id: 1 }],
          limitReached: false,
        }),
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow('VQ parameter "created_on" must be a valid calendar date');
  });

  it('honors declared modes when live and persisted sources are joined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    const dbPath = join(root, 'mixed.duckdb');
    await mkdir(join(root, '.bobsled'), { recursive: true });
    await writeFile(
      join(root, '.bobsled', 'config.yml'),
      `default_destination:
  dest: duckdb
  dbPath: ${dbPath}
  targetSchema: analytics
`,
      'utf8'
    );
    await seed(
      root,
      'contacts.yml',
      `spec_version: '0.2'
name: contacts
type: source
source_type: api_resource
integration: hubspot
resource: contacts
connection: hubspot_prod
mode: lazy
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: company_id, type: INTEGER }
`
    );
    await seed(
      root,
      'customers.yml',
      `spec_version: '0.2'
name: customers
type: source
source_type: api_resource
integration: stripe
resource: customers
connection: stripe_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: company_id, type: INTEGER }
`
    );
    const calls: string[] = [];
    const queryResourceImpl = vi.fn().mockImplementation(async (request) => {
      const resourceName = (request.resource as { name: string }).name;
      calls.push(resourceName);
      if (resourceName === 'contacts') {
        return { records: [{ id: 11, company_id: 42 }], limitReached: false };
      }
      return { records: [{ id: 7, company_id: 42 }], limitReached: false };
    });
    const specLoader = (_integration: string, resource: string) => ({
      integration: {} as never,
      resource: { name: resource } as never,
    });

    await runQueryCommand({
      projectRoot: root,
      sql: 'SELECT * FROM sources.contacts',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:00:00.000Z',
    });
    const mixed = await runQueryCommand({
      projectRoot: root,
      sql:
        'SELECT customers.id AS customer_id, contacts.id AS contact_id ' +
        'FROM sources.customers AS customers ' +
        'JOIN sources.contacts AS contacts ON customers.company_id = contacts.company_id',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
      nowIso: '2026-04-22T12:05:00.000Z',
    });

    expect(calls).toEqual(['contacts', 'customers']);
    expect(mixed.rows).toEqual([{ customer_id: 7n, contact_id: 11n }]);
    expect(mixed.receipts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/source=customers .*target=in_memory .*table=temp\.__bobsled_live_/),
        expect.stringMatching(/source=contacts .*target=duckdb .*action=reused/),
      ])
    );

    const runner = await createSqlRunnerFor({
      destination: {
        kind: 'duckdb',
        schema: 'analytics',
        table: 'contacts',
        fullyQualified: 'analytics.contacts',
        sqlRunnerKind: 'duckdb',
        config: {
          dest: 'duckdb',
          dbPath,
          targetSchema: 'analytics',
          bufferSize: 100_000,
          logFormat: 'json',
          maxConcurrentLoads: 1,
        },
      },
    });
    try {
      const metadata = await runner.query?.(
        'SELECT source_name FROM analytics._bobsled_source_metadata ORDER BY source_name'
      );
      const liveTables = await runner.query?.(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name = 'customers'"
      );
      expect(metadata).toEqual([{ source_name: 'contacts' }]);
      expect(liveTables?.[0]?.n).toBe(0n);
    } finally {
      await runner.close?.();
    }
  });

  it('materializes multiple referenced sources concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'left_issues.yml',
      `spec_version: '0.2'
name: left_issues
type: source
source_type: api_resource
integration: github
resource: left_issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    await seed(
      root,
      'right_issues.yml',
      `spec_version: '0.2'
name: right_issues
type: source
source_type: api_resource
integration: github
resource: right_issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );

    const started: string[] = [];
    const pending: Array<() => void> = [];
    let releaseImmediately = false;
    const releaseAll = () => {
      releaseImmediately = true;
      for (const release of pending.splice(0)) release();
    };
    const queryResourceImpl = vi.fn().mockImplementation(async (request) => {
      const resourceName = (request.resource as { name: string }).name;
      started.push(resourceName);
      await new Promise<void>((resolve) => {
        if (releaseImmediately) {
          resolve();
          return;
        }
        pending.push(resolve);
      });
      return {
        records: [{ id: resourceName === 'left_issues' ? 1 : 2 }],
        limitReached: false,
      };
    });
    const specLoader = (_integration: string, resource: string) => ({
      integration: {} as never,
      resource: { name: resource } as never,
    });

    const run = runQueryCommand({
      projectRoot: root,
      sql:
        'SELECT COUNT(*) AS n FROM sources.left_issues AS l ' +
        'JOIN sources.right_issues AS r ON l.id <> r.id',
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });

    let waitError: unknown;
    try {
      await vi.waitFor(() => {
        expect(new Set(started)).toEqual(new Set(['left_issues', 'right_issues']));
      });
    } catch (error) {
      waitError = error;
    } finally {
      releaseAll();
    }

    const result = await run;
    if (waitError) throw waitError;

    expect(queryResourceImpl).toHaveBeenCalledTimes(2);
    expect(result.rows[0]?.n).toBe(1n);
    expect(result.receipts).toHaveLength(2);
  });

  it('rejects SQL LIMIT values above the lazy API materialization ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });

    await expect(
      runQueryCommand({
        projectRoot: root,
        sql: 'SELECT * FROM sources.issues LIMIT 10001',
        queryResourceImpl,
        integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      })
    ).rejects.toThrow(/LIMIT 10001 exceeds/i);
    expect(queryResourceImpl).not.toHaveBeenCalled();
  });

  it('errors on unknown or absent sources and ignores comments during source detection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'q-'));
    await seed(
      root,
      'issues.yml',
      `spec_version: '0.2'
name: issues
type: source
source_type: api_resource
integration: github
resource: issues
connection: github_prod
mode: live
schema:
  columns:
    - { name: id, type: INTEGER }
`
    );
    const queryResourceImpl = vi.fn().mockResolvedValue({
      records: [{ id: 1 }],
      limitReached: false,
    });
    const specLoader = () => ({ integration: {} as never, resource: {} as never });

    await expect(
      runQueryCommand({
        projectRoot: root,
        sql: 'SELECT * FROM sources.ghosts',
        queryResourceImpl,
        integrationSpecLoader: specLoader,
      })
    ).rejects.toThrow(/unknown source "ghosts"/i);
    await expect(
      runQueryCommand({
        projectRoot: root,
        sql: 'SELECT 1',
        queryResourceImpl,
        integrationSpecLoader: specLoader,
      })
    ).rejects.toThrow(/references no sources/i);

    await runQueryCommand({
      projectRoot: root,
      sql: `-- sources.deprecated
SELECT /* sources.skipped */ * FROM sources.issues`,
      queryResourceImpl,
      integrationSpecLoader: specLoader,
    });
    expect(queryResourceImpl).toHaveBeenCalledTimes(1);
  });
});
