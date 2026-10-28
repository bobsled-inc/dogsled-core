import { describe, expect, it } from 'vitest';

import {
  filterKeepRecordIdsForCluster,
  validateKeepRecordIdsForCluster,
} from '../../../src/commands/review-unmerge.js';

describe('filterKeepRecordIdsForCluster', () => {
  it('keeps only requested record ids that belong to the target cluster', async () => {
    const queries: string[] = [];
    const result = await filterKeepRecordIdsForCluster(
      async (sql) => {
        queries.push(sql);
        return [{ RECORD_ID: 'r2' }, { record_id: 'r1' }];
      },
      'company',
      'ENTITY_GRAPH',
      'cluster-1',
      ['r1', 'r3'],
      'snowflake'
    );

    expect(result).toEqual(['r1']);
    expect(queries[0]).toContain('"ENTITY_GRAPH"."COMPANY__CLUSTERS"');
    expect(queries[0]).toContain('"CLUSTER_ID" = \'cluster-1\'');
    expect(queries[0]).toContain("\"RECORD_ID\" IN ('r1', 'r3')");
  });

  it('returns an empty list when every requested keep id misses the cluster', async () => {
    const result = await filterKeepRecordIdsForCluster(
      async () => [],
      'company',
      'ENTITY_GRAPH',
      'cluster-1',
      ['typo'],
      'duckdb'
    );

    expect(result).toEqual([]);
  });

  it('reports partial misses and no-op keep sets for runner validation', async () => {
    const queries: string[] = [];
    const partial = await validateKeepRecordIdsForCluster(
      async (sql) => {
        queries.push(sql);
        return [{ record_id: 'r1' }, { record_id: 'r2' }];
      },
      'company',
      'ENTITY_GRAPH',
      'cluster-1',
      ['r1', 'typo'],
      'duckdb'
    );
    const noOp = await validateKeepRecordIdsForCluster(
      async () => [{ record_id: 'r1' }, { record_id: 'r2' }],
      'company',
      'ENTITY_GRAPH',
      'cluster-1',
      ['r1', 'r2'],
      'duckdb'
    );

    expect(partial.keepRecordIds).toEqual(['r1']);
    expect(partial.missingRecordIds).toEqual(['typo']);
    expect(partial.keepsEntireCluster).toBe(false);
    expect(noOp.keepsEntireCluster).toBe(true);
    expect(queries[0]).toContain('"entity_graph"."company__clusters"');
    expect(queries[0]).not.toContain('IN (');
  });
});
