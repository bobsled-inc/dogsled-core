import { describe, expect, it, vi } from 'vitest';

import {
  isMissingTableError,
  maxSqlLimitLiteral,
  referencedSources,
  withMixedModeScratchTables,
} from '../../../src/commands/query.js';
import type { ResolvedDestination } from '../../../src/runtime/source-materializer/destination-resolver.js';
import type { ApiResourceEntry } from '../../../src/runtime/source-materializer/load-specs.js';

describe('query command missing-table classifier', () => {
  it('classifies only definitive missing-table probe errors as cache misses', () => {
    expect(
      isMissingTableError(new Error('Catalog Error: Table with name issues does not exist!'))
    ).toBe(true);
    expect(
      isMissingTableError(
        Object.assign(new Error('relation "issues" does not exist'), {
          sqlState: '42P01',
        })
      )
    ).toBe(true);
    expect(
      isMissingTableError(
        Object.assign(
          new Error(
            "002003 (42S02): SQL compilation error: Table 'ANALYTICS.ISSUES' does not exist or not authorized."
          ),
          { code: '002003', sqlState: '42S02' }
        )
      )
    ).toBe(true);
    expect(
      isMissingTableError(
        Object.assign(
          new Error(
            "001002 (42601): SQL compilation error: Object 'ANALYTICS.ISSUES' does not exist or not authorized."
          ),
          { sqlState: '42601' }
        )
      )
    ).toBe(true);
    expect(isMissingTableError(new Error('permission denied for table issues'))).toBe(false);
    expect(
      isMissingTableError(
        new Error('SQL compilation error: Object ISSUES does not exist or not authorized.')
      )
    ).toBe(false);
  });
});

describe('query command source reference scanner', () => {
  it('ignores sources.* mentions inside literals and comments', () => {
    expect(
      referencedSources(`
        SELECT 'sources.not_a_source' AS literal_value
        FROM sources.issues
        -- JOIN sources.comment_only ON true
        /* JOIN sources.block_comment ON true */
        WHERE note = 'literal with escaped '' sources.still_literal'
      `)
    ).toEqual(new Set(['issues']));
  });

  it('rejects user CTEs and table aliases named sources', () => {
    expect(() =>
      referencedSources(`
        WITH sources AS (SELECT 1 AS id)
        SELECT sources.id
        FROM sources
      `)
    ).toThrow('"sources" is reserved');

    expect(() =>
      referencedSources(`
        SELECT sources.id
        FROM raw_events AS sources
      `)
    ).toThrow('"sources" is reserved');
  });
});

describe('maxSqlLimitLiteral', () => {
  it('finds limits after SQL comment tokens inside string literals', () => {
    expect(maxSqlLimitLiteral("SELECT '-- not a comment' AS marker LIMIT 10001")).toBe(10001);
    expect(maxSqlLimitLiteral("SELECT '/* not a comment */' AS marker LIMIT 7")).toBe(7);
  });

  it('ignores limits inside comments and literals', () => {
    expect(
      maxSqlLimitLiteral(`
        SELECT 'LIMIT 99999' AS literal_value
        FROM sources.issues
        -- LIMIT 88888
        LIMIT 5
      `)
    ).toBe(5);
  });

  it('treats LIMIT ALL as Infinity', () => {
    expect(maxSqlLimitLiteral('SELECT * FROM sources.issues LIMIT ALL')).toBe(Infinity);
  });

  it('returns undefined when no LIMIT clause is present', () => {
    expect(maxSqlLimitLiteral('SELECT * FROM sources.issues')).toBeUndefined();
  });

  it('ignores LIMIT inside nested subqueries', () => {
    expect(
      maxSqlLimitLiteral('SELECT * FROM (SELECT * FROM sources.issues LIMIT 99999) sub LIMIT 50')
    ).toBe(50);
  });
});

describe('withMixedModeScratchTables', () => {
  it('stages live sources into scratch tables on the representative warehouse', async () => {
    const runner = {
      run: vi.fn(async () => undefined),
    };
    const entries: ApiResourceEntry[] = [
      {
        kind: 'api_resource',
        fqRef: 'sources.live_issues',
        integration: 'github',
        resource: 'issues',
        connection: 'github_prod',
        mode: 'live',
        columns: [{ name: 'id', type: 'integer' }],
      } as ApiResourceEntry,
      {
        kind: 'api_resource',
        fqRef: 'sources.persisted_pulls',
        integration: 'github',
        resource: 'pulls',
        connection: 'github_prod',
        mode: 'lazy',
        columns: [{ name: 'id', type: 'integer' }],
      } as ApiResourceEntry,
    ];
    const liveDestination: ResolvedDestination = {
      kind: 'in_memory',
      schema: 'temp',
      table: '__bobsled_live_issues',
      fullyQualified: 'temp.__bobsled_live_issues',
      sqlRunnerKind: 'duckdb',
      config: {
        dest: 'duckdb',
        dbPath: ':memory:',
        targetSchema: 'temp',
        bufferSize: 100_000,
        logFormat: 'json',
        maxConcurrentLoads: 1,
      },
    };
    const representative: ResolvedDestination = {
      kind: 'bigquery',
      schema: 'analytics',
      table: 'issues',
      fullyQualified: 'analytics.issues',
      sqlRunnerKind: 'bigquery',
      config: {
        dest: 'bigquery',
        datasetId: 'analytics',
        bufferSize: 100_000,
        logFormat: 'json',
        targetFileSizeMb: 256,
        stagingFormat: 'parquet',
        maxConcurrentLoads: 4,
        maxLoadJobs: 9000,
      },
    };

    const seen = await withMixedModeScratchTables({
      entries,
      destinations: [liveDestination, representative],
      representative,
      runner,
      body: async (destinations) => destinations,
    });

    expect(seen[0]).toEqual(
      expect.objectContaining({
        kind: 'bigquery',
        schema: 'analytics',
        sqlRunnerKind: 'bigquery',
      })
    );
    expect(seen[0]?.table).toMatch(/^__bobsled_live_issues_0_scratch_/);
    expect(seen[1]).toBe(representative);
    expect(runner.run).toHaveBeenCalledWith(
      expect.stringMatching(/CREATE TABLE `analytics`\.`__bobsled_live_issues_0_scratch_/)
    );
    expect(runner.run).toHaveBeenCalledWith(
      expect.stringMatching(/DROP TABLE IF EXISTS `analytics`\.`__bobsled_live_issues_0_scratch_/)
    );
  });
});
