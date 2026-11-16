import { describe, expect, it } from 'vitest';

import {
  applySqlWherePushdown,
  isPartialMaterializationEligible,
} from '../../../src/runtime/source-materializer/sql-pushdown.js';
import type { ApiResourceEntry } from '../../../src/runtime/source-materializer/load-specs.js';

function entry(name: string, filter?: Record<string, unknown>): ApiResourceEntry {
  return {
    kind: 'api_resource',
    fqRef: `sources.${name}`,
    integration: 'github',
    resource: name,
    connection: 'github_prod',
    columns: [{ name: 'id', type: 'integer' }],
    ...(filter !== undefined ? { filter } : {}),
  } as ApiResourceEntry;
}

const loader = (_integration: string, resource: string) => ({
  integration: {} as never,
  resource: {
    name: resource,
    query: {
      filters: {
        id: { operators: ['in', 'ne'] },
        state: { operators: ['eq'] },
        status: { operators: ['eq'] },
        segment: { operators: ['eq'] },
        created_at: { operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
      },
    },
  } as never,
});

describe('applySqlWherePushdown', () => {
  it('skips pushdown for self-joins because one source backs multiple aliases', () => {
    const entries = [entry('issues')];

    const pushed = applySqlWherePushdown({
      sql: `
        SELECT left_issue.id
        FROM sources.issues AS left_issue
        JOIN sources.issues AS right_issue ON left_issue.pair_id = right_issue.id
        WHERE left_issue.state = 'open' AND right_issue.state = 'closed'
      `,
      entries,
      integrationSpecLoader: loader,
    });

    expect(pushed).toEqual(entries);
  });

  it('skips pushdown when an explicit alias collides with another source name', () => {
    const entries = [entry('orders'), entry('customers')];

    const pushed = applySqlWherePushdown({
      sql: `
        SELECT customers.id
        FROM sources.orders AS customers
        JOIN sources.customers ON customers.customer_id = sources.customers.id
        WHERE customers.status = 'open' AND sources.customers.segment = 'enterprise'
      `,
      entries,
      integrationSpecLoader: loader,
    });

    expect(pushed).toEqual(entries);
  });

  it('keeps the stricter duplicate lower bound', () => {
    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE created_at >= '2024-01-01' AND created_at >= '2024-02-01'
      `,
      entries: [entry('issues')],
      integrationSpecLoader: loader,
    });

    expect(pushed[0]?.filter).toEqual({
      created_at: { gte: '2024-02-01' },
    });
  });

  it('keeps strict lower bounds when duplicate values mix gt and gte', () => {
    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE created_at >= '2024-02-01' AND created_at > '2024-02-01'
      `,
      entries: [entry('issues')],
      integrationSpecLoader: loader,
    });

    expect(pushed[0]?.filter).toEqual({
      created_at: { gt: '2024-02-01' },
    });
  });

  it('keeps the stricter duplicate upper bound', () => {
    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE created_at <= '2024-12-31' AND created_at < '2024-11-01'
      `,
      entries: [entry('issues')],
      integrationSpecLoader: loader,
    });

    expect(pushed[0]?.filter).toEqual({
      created_at: { lt: '2024-11-01' },
    });
  });

  it('normalizes dollar-prefixed operator filters before merging pushed predicates', () => {
    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE created_at < '2024-11-01'
      `,
      entries: [entry('issues', { created_at: { $gte: '2024-01-01' } })],
      integrationSpecLoader: loader,
    });

    expect(pushed[0]?.filter).toEqual({
      created_at: {
        gte: '2024-01-01',
        lt: '2024-11-01',
      },
    });
  });

  it('skips equality pushdown for a field with conflicting equality predicates', () => {
    const entries = [entry('issues')];

    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE state = 'open' AND state = 'closed'
      `,
      entries,
      integrationSpecLoader: loader,
    });

    expect(pushed).toEqual(entries);
  });

  it('preserves existing filters when a pushed equality conflicts', () => {
    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE state = 'closed' AND status = 'done'
      `,
      entries: [entry('issues', { state: 'open' })],
      integrationSpecLoader: loader,
    });

    expect(pushed[0]?.filter).toEqual({
      state: 'open',
      status: { eq: 'done' },
    });
  });

  it('skips pushdown for duplicate non-bound operators with different values', () => {
    const entries = [entry('issues')];

    const pushed = applySqlWherePushdown({
      sql: `
        SELECT id
        FROM sources.issues
        WHERE id IN (1, 2) AND id IN (2, 3)
      `,
      entries,
      integrationSpecLoader: loader,
    });

    expect(pushed).toEqual(entries);
  });
});

describe('isPartialMaterializationEligible', () => {
  it('accepts a single-source select with a LIMIT', () => {
    expect(
      isPartialMaterializationEligible({
        sql: 'SELECT id FROM sources.issues LIMIT 10',
        entries: [entry('issues')],
        integrationSpecLoader: loader,
      })
    ).toEqual({
      eligible: true,
      limit: 10,
      sourceName: 'issues',
    });
  });

  it('rejects joins', () => {
    expect(
      isPartialMaterializationEligible({
        sql: 'SELECT * FROM sources.issues JOIN sources.pulls ON issues.id = pulls.id LIMIT 10',
        entries: [entry('issues'), entry('pulls')],
        integrationSpecLoader: loader,
      }).eligible
    ).toBe(false);
  });

  it('rejects residual WHERE predicates that cannot be fully pushed down', () => {
    expect(
      isPartialMaterializationEligible({
        sql: "SELECT * FROM sources.issues WHERE title = 'open me' LIMIT 10",
        entries: [entry('issues')],
        integrationSpecLoader: loader,
      })
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: 'residual_filter',
      })
    );
  });

  it('rejects duplicate same-operator predicates that cannot be represented exactly', () => {
    expect(
      isPartialMaterializationEligible({
        sql: 'SELECT * FROM sources.issues WHERE id IN (1, 2) AND id IN (2, 3) LIMIT 1',
        entries: [entry('issues')],
        integrationSpecLoader: loader,
      })
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: 'residual_filter',
      })
    );
  });

  it('rejects queries without LIMIT', () => {
    expect(
      isPartialMaterializationEligible({
        sql: 'SELECT * FROM sources.issues',
        entries: [entry('issues')],
        integrationSpecLoader: loader,
      })
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: 'no_limit',
      })
    );
  });

  it('rejects distinct, group by, order by, union, cte, and window queries', () => {
    for (const sql of [
      'SELECT DISTINCT id FROM sources.issues LIMIT 10',
      'SELECT COUNT(*) FROM sources.issues GROUP BY id LIMIT 10',
      'SELECT id FROM sources.issues ORDER BY id LIMIT 10',
      'SELECT id FROM sources.issues UNION SELECT id FROM sources.pulls LIMIT 10',
      'WITH cte AS (SELECT * FROM sources.issues) SELECT * FROM cte LIMIT 10',
      'SELECT row_number() OVER (ORDER BY id) FROM sources.issues LIMIT 10',
    ]) {
      expect(
        isPartialMaterializationEligible({
          sql,
          entries: [entry('issues'), entry('pulls')],
          integrationSpecLoader: loader,
        }).eligible
      ).toBe(false);
    }
  });

  it('rejects aggregate and offset queries because partial snapshots are row-preserving only', () => {
    expect(
      isPartialMaterializationEligible({
        sql: 'SELECT COUNT(*) FROM sources.issues LIMIT 1',
        entries: [entry('issues')],
        integrationSpecLoader: loader,
      })
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: 'aggregate',
      })
    );

    expect(
      isPartialMaterializationEligible({
        sql: 'SELECT id FROM sources.issues LIMIT 10 OFFSET 100',
        entries: [entry('issues')],
        integrationSpecLoader: loader,
      })
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: 'result_shape',
      })
    );
  });
});
