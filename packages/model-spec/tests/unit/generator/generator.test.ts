import { describe, expect, it } from 'vitest';

import {
  generateModelSpecFromSql,
  ModelSpecGenerationError,
  type ModelSpecGenerationOptions,
  type SourceSpec,
} from '../../../src/compiler/index.js';

const usersSource: SourceSpec = {
  spec_version: '0.2',
  name: 'raw_users',
  type: 'source',
  source_type: 'warehouse_table',
  connection: 'ecom',
  table: 'RAW.PUBLIC.USERS',
  schema: { columns: [{ name: 'ID', type: 'NUMBER', primary_key: true }] },
  trust_tier: 'bronze',
};

const ordersSource: SourceSpec = {
  spec_version: '0.2',
  name: 'raw_orders',
  type: 'source',
  source_type: 'warehouse_table',
  connection: 'ecom',
  table: 'RAW.PUBLIC.ORDERS',
  schema: { columns: [{ name: 'ID', type: 'NUMBER', primary_key: true }] },
  trust_tier: 'bronze',
};

const eventsSource: SourceSpec = {
  spec_version: '0.2',
  name: 'raw_events',
  type: 'source',
  source_type: 'warehouse_table',
  connection: 'ecom',
  table: 'RAW.PUBLIC.EVENTS',
  schema: { columns: [{ name: 'ID', type: 'NUMBER', primary_key: true }] },
  trust_tier: 'bronze',
};

function snowflake(sources: SourceSpec[]): ModelSpecGenerationOptions {
  return { dialect: 'snowflake', sources };
}

describe('generateModelSpecFromSql — simple SELECT', () => {
  it('produces a single view model with column expressions', () => {
    const sql = `SELECT id AS user_id, name FROM users`;
    const { models } = generateModelSpecFromSql(sql, {
      ...snowflake([usersSource]),
      modelName: 'users_view',
    });
    expect(models).toHaveLength(1);
    const model = models[0]!;
    expect(model.name).toBe('users_view');
    expect(model.materialization).toEqual({ type: 'view' });
    expect(model.source.ref).toBe('ecom.raw_users');
    expect(model.columns).toEqual([
      { name: 'user_id', expr: 'id' },
      { name: 'name', expr: 'name' },
    ]);
  });
});

describe('generateModelSpecFromSql — JOIN', () => {
  it('rewrites SQL aliases to source-name qualifiers', () => {
    const sql = `
      SELECT u.id AS user_id, o.id AS order_id
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource, ordersSource]));
    const model = models[0]!;
    expect(model.source.ref).toBe('ecom.raw_users');
    expect(model.joins).toHaveLength(1);
    expect(model.joins![0]).toMatchObject({
      ref: 'ecom.raw_orders',
      type: 'left',
      on: '(raw_orders.user_id = raw_users.id)',
    });
    expect(model.columns[0]!.expr).toBe('raw_users.id');
    expect(model.columns[1]!.expr).toBe('raw_orders.id');
  });

  it('maps INNER JOIN and CROSS JOIN', () => {
    const sql = `
      SELECT u.id AS x
      FROM users u
      INNER JOIN orders o ON o.user_id = u.id
      CROSS JOIN events e
    `;
    const { models } = generateModelSpecFromSql(
      sql,
      snowflake([usersSource, ordersSource, eventsSource])
    );
    const joins = models[0]!.joins!;
    expect(joins[0]!.type).toBe('inner');
    expect(joins[1]!.type).toBe('cross');
  });
});

describe('generateModelSpecFromSql — GROUP BY / HAVING / DISTINCT', () => {
  it('emits group_by, having, and aggregations', () => {
    const sql = `
      SELECT customer_id AS cid, SUM(amount) AS total, COUNT(*) AS n
      FROM orders
      WHERE order_date >= '2024-01-01'
      GROUP BY customer_id
      HAVING SUM(amount) > 1000
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([ordersSource]));
    const m = models[0]!;
    expect(m.group_by).toEqual(['customer_id']);
    expect(m.where).toContain("'2024-01-01'");
    expect(m.having).toContain('1000');
    expect(m.columns.find((c) => c.name === 'total')?.expr).toBe('SUM(amount)');
    expect(m.columns.find((c) => c.name === 'n')?.expr).toBe('COUNT(*)');
  });

  it('emits distinct: true', () => {
    const sql = `SELECT DISTINCT customer_id AS cid FROM orders`;
    const { models } = generateModelSpecFromSql(sql, snowflake([ordersSource]));
    expect(models[0]!.distinct).toBe(true);
  });
});

describe('generateModelSpecFromSql — window functions and QUALIFY', () => {
  it('emits OVER (PARTITION BY ... ORDER BY ...)', () => {
    const sql = `
      SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
      FROM orders
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([ordersSource]));
    const m = models[0]!;
    const rn = m.columns.find((c) => c.name === 'rn');
    expect(rn?.expr).toContain('ROW_NUMBER()');
    expect(rn?.expr).toContain('PARTITION BY customer_id');
    expect(rn?.expr).toContain('ORDER BY order_date DESC');
  });

  it('preserves a QUALIFY clause', () => {
    const sql = `
      SELECT id
      FROM orders
      QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date) = 1
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([ordersSource]));
    expect(models[0]!.qualify).toContain('ROW_NUMBER()');
  });
});

describe('generateModelSpecFromSql — JSON path access', () => {
  it('preserves Snowflake colon-path access through preprocessing', () => {
    const sql = `
      SELECT
        DATA:user:id::STRING AS user_id,
        DATA:items[0]:price::NUMBER AS first_price
      FROM events
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([eventsSource]));
    const cols = models[0]!.columns;
    expect(cols[0]!.expr).toContain('DATA:user:id');
    expect(cols[0]!.expr).toContain('::STRING');
    expect(cols[1]!.expr).toContain('DATA:items[0]:price');
  });

  it('handles doubled-quote escapes inside quoted JSON-path keys', () => {
    const sql = `SELECT PAYLOAD:"a""b"::STRING AS odd_key FROM events`;
    const { models } = generateModelSpecFromSql(sql, snowflake([eventsSource]));
    expect(models[0]!.columns[0]!.expr).toContain('PAYLOAD:"a""b"');
    expect(models[0]!.columns[0]!.expr).toContain('::STRING');
  });
});

describe('generateModelSpecFromSql — CTEs', () => {
  it('lifts each CTE into an ephemeral model and references it from the head', () => {
    const sql = `
      WITH active_users AS (
        SELECT id AS user_id FROM users WHERE active = TRUE
      )
      SELECT user_id FROM active_users
    `;
    const { models } = generateModelSpecFromSql(sql, {
      ...snowflake([usersSource]),
      modelName: 'top_users',
    });
    expect(models).toHaveLength(2);
    expect(models[0]!.name).toBe('top_users__active_users');
    expect(models[0]!.materialization.type).toBe('ephemeral');
    expect(models[1]!.name).toBe('top_users');
    expect(models[1]!.source.ref).toBe('top_users__active_users');
  });
});

describe('generateModelSpecFromSql — LATERAL FLATTEN', () => {
  it('produces a flatten_json field', () => {
    const sql = `
      SELECT t.id AS event_id, f.value:name AS item_name
      FROM events t,
        LATERAL FLATTEN(INPUT => t.payload) f
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([eventsSource]));
    const m = models[0]!;
    expect(m.flatten_json).toBeDefined();
    expect(m.flatten_json).toMatchObject({ alias: 'f', input: 'raw_events.payload' });
  });

  it('captures FLATTEN PATH and OUTER parameters when present', () => {
    const sql = `
      SELECT t.id AS event_id
      FROM events t,
        LATERAL FLATTEN(INPUT => t.payload, PATH => 'items', OUTER => TRUE) f
    `;
    const { models } = generateModelSpecFromSql(sql, snowflake([eventsSource]));
    expect(models[0]!.flatten_json).toMatchObject({
      alias: 'f',
      input: 'raw_events.payload',
      path: 'items',
      outer: true,
    });
  });
});

describe('generateModelSpecFromSql — Snowflake double-quoted identifiers', () => {
  it('treats a single quoted identifier as a column ref', () => {
    const sql = `SELECT "COUNTRY" FROM users`;
    const usersSourceWithCols: SourceSpec = {
      ...usersSource,
      schema: {
        columns: [
          { name: 'ID', type: 'NUMBER', primary_key: true },
          { name: 'COUNTRY', type: 'STRING', primary_key: false },
        ],
      },
    };
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSourceWithCols]));
    expect(models).toHaveLength(1);
    expect(models[0]!.columns).toEqual([{ name: 'COUNTRY', expr: 'COUNTRY' }]);
  });

  it('normalises uppercase quoted ids and preserves quoting on lowercase ones', () => {
    const sql = `SELECT "COUNTRY", "_sh_loaded_at" FROM users`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
    const cols = models[0]!.columns;
    // Uppercase form is Snowflake-equivalent to bare COUNTRY — emit unquoted.
    expect(cols[0]).toEqual({ name: 'COUNTRY', expr: 'COUNTRY' });
    // Lowercase quoted id refers to a different physical column — keep quoted.
    expect(cols[1]).toEqual({ name: '_sh_loaded_at', expr: '"_sh_loaded_at"' });
  });

  it.each(['FROM', 'OUTER'])(
    'preserves quoting around reserved word %s used as a column identifier',
    (kw) => {
      const sql = `SELECT "${kw}" FROM users`;
      const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
      expect(models[0]!.columns).toEqual([{ name: kw, expr: `"${kw}"` }]);
    }
  );

  it('compiles the resolve-dependencies fixture with all-uppercase quoted ids', () => {
    const exampleSource: SourceSpec = {
      spec_version: '0.2',
      name: 'sh_view',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'sh',
      table: 'EXAMPLE.EXAMPLE.__0123456789ABCDEF0123456789ABCDEF',
      schema: {
        columns: [
          { name: 'country', type: 'STRING', primary_key: false },
          { name: 'population', type: 'INTEGER', primary_key: false },
          { name: 'description', type: 'STRING', primary_key: false },
          { name: '_sh_loaded_at', type: 'TIMESTAMP', primary_key: false },
        ],
      },
      trust_tier: 'bronze',
    };
    const sql =
      'SELECT "COUNTRY", "POPULATION", "DESCRIPTION", "_SH_LOADED_AT" ' +
      'FROM EXAMPLE.EXAMPLE.__0123456789ABCDEF0123456789ABCDEF';
    const { models } = generateModelSpecFromSql(sql, snowflake([exampleSource]));
    expect(models).toHaveLength(1);
    const m = models[0]!;
    expect(m.source.ref).toBe('sh.sh_view');
    expect(m.columns.map((c) => c.name)).toEqual([
      'COUNTRY',
      'POPULATION',
      'DESCRIPTION',
      '_SH_LOADED_AT',
    ]);
    // All four match the unquoted-identifier alphabet → emitted bare.
    expect(m.columns.every((c) => /^[A-Z_][A-Z0-9_$]*$/.test(c.expr ?? ''))).toBe(true);
  });
});

describe('generateModelSpecFromSql — defaultConnection tie-break', () => {
  it('breaks AMBIGUOUS_SOURCE ties with defaultConnection', () => {
    const ecomUsers: SourceSpec = {
      ...usersSource,
      connection: 'ecom',
      table: 'PUBLIC.USERS',
    };
    const crmUsers: SourceSpec = {
      ...usersSource,
      name: 'crm_users',
      connection: 'crm',
      table: 'PUBLIC.USERS',
    };
    const sql = `SELECT id AS x FROM users`;
    // Without defaultConnection: ambiguous.
    expect(() =>
      generateModelSpecFromSql(sql, { dialect: 'snowflake', sources: [ecomUsers, crmUsers] })
    ).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_SOURCE' }));
    // With defaultConnection: resolves to the matching source.
    const { models } = generateModelSpecFromSql(sql, {
      dialect: 'snowflake',
      sources: [ecomUsers, crmUsers],
      defaultConnection: 'crm',
    });
    expect(models[0]!.source.ref).toBe('crm.crm_users');
  });
});

describe('generateModelSpecFromSql — SELECT * expansion', () => {
  it('maps bare SELECT * to include_all_columns', () => {
    const sql = `SELECT * FROM users`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
    const model = models[0]!;
    expect((model as { include_all_columns?: boolean }).include_all_columns).toBe(true);
    expect(model.columns).toEqual([]);
    expect((model as { exclude_columns?: string[] }).exclude_columns).toBeUndefined();
  });

  it('maps SELECT t.* to include_all_columns when t is the only FROM table', () => {
    const sql = `SELECT u.* FROM users u`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
    const model = models[0]!;
    expect((model as { include_all_columns?: boolean }).include_all_columns).toBe(true);
    expect(model.columns).toEqual([]);
  });

  it('maps SELECT * with EXCLUDE to include_all_columns + exclude_columns', () => {
    const sql = `SELECT * EXCLUDE (id) FROM users`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
    const model = models[0]!;
    expect((model as { include_all_columns?: boolean }).include_all_columns).toBe(true);
    expect((model as { exclude_columns?: string[] }).exclude_columns).toEqual(['id']);
  });

  it('aggregates multiple EXCLUDE columns', () => {
    const sql = `SELECT * EXCLUDE (id, created_at) FROM users`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
    expect((models[0] as { exclude_columns?: string[] }).exclude_columns).toEqual([
      'id',
      'created_at',
    ]);
  });

  it('maps a JOIN with bare * to include_all_columns covering every table', () => {
    const sql = `SELECT * FROM users u JOIN orders o ON o.user_id = u.id`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource, ordersSource]));
    const model = models[0]!;
    expect((model as { include_all_columns?: boolean }).include_all_columns).toBe(true);
    expect(model.joins).toHaveLength(1);
  });

  it('accepts u.*, o.* covering every FROM/JOIN alias', () => {
    const sql = `SELECT u.*, o.* FROM users u JOIN orders o ON o.user_id = u.id`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource, ordersSource]));
    expect((models[0] as { include_all_columns?: boolean }).include_all_columns).toBe(true);
  });

  it('rejects partial-qualified `alias.*` projections across joins', () => {
    const sql = `SELECT u.* FROM users u JOIN orders o ON o.user_id = u.id`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource, ordersSource]))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' })
    );
  });

  it('rejects mixing `*` with explicit projections', () => {
    const sql = `SELECT *, id AS user_id FROM users`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' })
    );
  });

  it('rejects bare `*` combined with qualified `alias.*`', () => {
    const sql = `SELECT *, u.* FROM users u`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' })
    );
  });

  it('rejects repeated `alias.*` projections', () => {
    const sql = `SELECT u.*, u.* FROM users u`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' })
    );
  });

  it('rejects qualified `alias.* EXCLUDE (...)` across multi-table FROM/JOIN', () => {
    const sql = `SELECT u.* EXCLUDE (id), o.* FROM users u JOIN orders o ON o.user_id = u.id`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource, ordersSource]))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' })
    );
  });

  it('accepts qualified `t.* EXCLUDE (...)` in a single-table FROM', () => {
    const sql = `SELECT u.* EXCLUDE (id) FROM users u`;
    const { models } = generateModelSpecFromSql(sql, snowflake([usersSource]));
    expect((models[0] as { exclude_columns?: string[] }).exclude_columns).toEqual(['id']);
  });

  it('rejects `mystery.*` for unknown table aliases', () => {
    const sql = `SELECT mystery.* FROM users u`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNRESOLVED_TABLE_ALIAS' })
    );
  });
});

describe('generateModelSpecFromSql — error cases', () => {
  it('rejects an unaliased computed column', () => {
    const sql = `SELECT id + 1 FROM users`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNNAMED_COLUMN' })
    );
  });

  it('rejects an unknown source table', () => {
    const sql = `SELECT id AS x FROM mystery`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNRESOLVED_SOURCE' })
    );
  });

  it('rejects FROM-clause subqueries', () => {
    const sql = `
      SELECT t.id AS x
      FROM (SELECT id FROM users) t
    `;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      ModelSpecGenerationError
    );
  });

  it('reports parse errors with PARSE_ERROR code', () => {
    const sql = `SELECT FROM WHERE`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'PARSE_ERROR' })
    );
  });

  it('rejects NULLS FIRST / NULLS LAST in ORDER BY', () => {
    const sql = `
      SELECT id AS x
      FROM users
      ORDER BY id DESC NULLS LAST
    `;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_CONSTRUCT',
        message: expect.stringContaining('NULLS FIRST / NULLS LAST'),
      })
    );
  });

  it('rejects NULLS FIRST/LAST inside window function ORDER BY', () => {
    const sql = `
      SELECT
        ROW_NUMBER() OVER (PARTITION BY plan ORDER BY id NULLS FIRST) AS rn
      FROM users
    `;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' })
    );
  });

  it('does not flag NULLS FIRST that appears inside a string literal', () => {
    const sql = `SELECT id AS x, 'NULLS FIRST is fine here' AS note FROM users`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).not.toThrow();
  });

  it('does not flag NULLS LAST in a SQL comment', () => {
    const sql = `
      -- ORDER BY id DESC NULLS LAST is illegal here
      SELECT id AS x FROM users
    `;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).not.toThrow();
  });

  it('does not flag NULLS FIRST inside a /* block comment */', () => {
    const sql = `SELECT id AS x /* NULLS FIRST */ FROM users`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).not.toThrow();
  });

  it('rejects column refs using an unbound table alias', () => {
    const sql = `SELECT mystery.id AS x FROM users`;
    expect(() => generateModelSpecFromSql(sql, snowflake([usersSource]))).toThrow(
      expect.objectContaining({ code: 'UNRESOLVED_TABLE_ALIAS' })
    );
  });

  it('rejects unsupported dialects with UNSUPPORTED_DIALECT', () => {
    const sql = `SELECT id AS x FROM users`;
    expect(() =>
      generateModelSpecFromSql(sql, { dialect: 'bigquery' as 'snowflake', sources: [usersSource] })
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_DIALECT' }));
  });
});
