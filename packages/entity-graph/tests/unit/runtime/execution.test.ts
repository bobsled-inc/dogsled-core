import { describe, expect, it, vi } from 'vitest';
import { MATCH_KEY_SECRET_RUNTIME_TOKEN } from '@bobsled-inc/model-spec';

import {
  executeEntityGraphPlan,
  toEntityGraphExecutionStatements,
} from '../../../src/runtime/execution.js';

describe('Entity Graph execution helpers', () => {
  it('maps preamble and statements into dependent execution steps', () => {
    const statements = toEntityGraphExecutionStatements('company', {
      preamble: 'create schema if not exists entity_graph',
      statements: [
        { name: 'candidate_pairs', sql: 'select 1' },
        { name: 'pair_scores', sql: 'select 2' },
      ],
    });

    expect(statements).toEqual([
      {
        modelName: 'company:preamble',
        sql: 'create schema if not exists entity_graph',
        deps: undefined,
        ignoreErrorPatterns: undefined,
      },
      {
        modelName: 'company:candidate_pairs',
        sql: 'select 1',
        deps: ['company:preamble'],
        ignoreErrorPatterns: undefined,
      },
      {
        modelName: 'company:pair_scores',
        sql: 'select 2',
        deps: ['company:candidate_pairs'],
        ignoreErrorPatterns: undefined,
      },
    ]);
  });

  it('executes SQL through the typed runner interface in plan order', async () => {
    const executedSql: string[] = [];
    const runner = {
      run: vi.fn(async (sql: string) => {
        executedSql.push(sql);
        return { rowCount: executedSql.length };
      }),
    };

    const results = await executeEntityGraphPlan(
      'company',
      runner,
      {
        preamble: 'create schema if not exists entity_graph',
        statements: [
          { name: 'candidate_pairs', sql: 'select 1' },
          { name: 'pair_scores', sql: 'select 2' },
        ],
      },
      true
    );

    expect(executedSql).toEqual([
      'create schema if not exists entity_graph',
      'select 1',
      'select 2',
    ]);
    expect(results.map((result) => result.modelName)).toEqual([
      'company:preamble',
      'company:candidate_pairs',
      'company:pair_scores',
    ]);
    expect(results.map((result) => result.rowsAffected)).toEqual([1, 2, 3]);
  });

  it('materializes match-key secret placeholders only for execution', async () => {
    vi.stubEnv('BOBSLED_CORE_MATCH_KEY_SECRET', "runtime's secret");
    const executedSql: string[] = [];
    const runner = {
      run: vi.fn(async (sql: string) => {
        executedSql.push(sql);
        return {};
      }),
    };

    try {
      await executeEntityGraphPlan(
        'company',
        runner,
        {
          dialect: 'duckdb',
          statements: [{ name: 'hash', sql: `SELECT '${MATCH_KEY_SECRET_RUNTIME_TOKEN}'` }],
        },
        true
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(executedSql).toEqual(["SELECT 'runtime''s secret'"]);
  });

  it('requires a dialect before materializing match-key secret placeholders', () => {
    expect(() =>
      toEntityGraphExecutionStatements('company', {
        statements: [{ name: 'hash', sql: `SELECT '${MATCH_KEY_SECRET_RUNTIME_TOKEN}'` }],
      })
    ).toThrow(
      'Entity graph execution requires a dialect to materialize BOBSLED_CORE_MATCH_KEY_SECRET placeholders.'
    );
  });
});
