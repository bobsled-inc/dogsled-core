import { describe, expect, it } from 'vitest';
import { generateSelectSql } from '../../../../src/compiler/codegen.js';
import type { ResolvedTransformSpec } from '../../../../src/compiler/parser.js';

/** Build a minimal spec with overrides. */
function makeSpec(overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec {
  return {
    name: 'test_model',
    description: 'test',
    grain: 'id',
    trustTier: 'bronze',
    materialization: 'view',
    sourceRef: 'raw_orders',
    source: { fqTableName: 'RAW.RAW_ORDERS', alias: 'o' },
    columns: [{ name: 'id', expr: 'o.id' }],
    joins: [],
    includeAllColumns: false,
    ...overrides,
  };
}

describe('generateSelectSql — new features', () => {
  describe('SELECT *', () => {
    it('emits SELECT * when includeAllColumns is true', () => {
      const sql = generateSelectSql(
        makeSpec({ includeAllColumns: true, columns: [] }),
        'snowflake'
      );
      expect(sql).toContain('SELECT *');
    });
  });

  describe('SELECT * EXCLUDE / EXCEPT', () => {
    it('snowflake: emits * EXCLUDE (...)', () => {
      const sql = generateSelectSql(
        makeSpec({ includeAllColumns: true, excludeColumns: ['internal_id'], columns: [] }),
        'snowflake'
      );
      expect(sql).toContain('* EXCLUDE');
      expect(sql).toContain('INTERNAL_ID');
    });

    it('bigquery: emits * EXCEPT (...)', () => {
      const sql = generateSelectSql(
        makeSpec({ includeAllColumns: true, excludeColumns: ['internal_id'], columns: [] }),
        'bigquery'
      );
      expect(sql).toContain('* EXCEPT');
      expect(sql).toContain('internal_id');
    });

    it('postgres: throws for SELECT * EXCEPT', () => {
      expect(() =>
        generateSelectSql(
          makeSpec({ includeAllColumns: true, excludeColumns: ['internal_id'], columns: [] }),
          'postgres'
        )
      ).toThrow(/not supported/i);
    });
  });

  describe('SELECT DISTINCT', () => {
    it('emits SELECT DISTINCT', () => {
      const sql = generateSelectSql(makeSpec({ distinct: true }), 'snowflake');
      expect(sql).toContain('SELECT DISTINCT');
    });

    it('omits DISTINCT when not set', () => {
      const sql = generateSelectSql(makeSpec(), 'snowflake');
      expect(sql).not.toContain('DISTINCT');
    });
  });

  describe('LIMIT / OFFSET', () => {
    it('emits LIMIT', () => {
      const sql = generateSelectSql(makeSpec({ limit: 100 }), 'snowflake');
      expect(sql).toContain('LIMIT 100');
    });

    it('emits LIMIT with OFFSET', () => {
      const sql = generateSelectSql(makeSpec({ limit: 100, offset: 50 }), 'snowflake');
      expect(sql).toContain('LIMIT 100');
      expect(sql).toContain('OFFSET 50');
    });

    it('omits LIMIT when not set', () => {
      const sql = generateSelectSql(makeSpec(), 'snowflake');
      expect(sql).not.toContain('LIMIT');
    });
  });

  describe('ORDER BY', () => {
    it('emits ORDER BY with direction', () => {
      const sql = generateSelectSql(
        makeSpec({ orderBy: [{ column: 'created_at', direction: 'desc' }] }),
        'snowflake'
      );
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('CREATED_AT');
      expect(sql).toContain('DESC');
    });

    it('emits ORDER BY without direction', () => {
      const sql = generateSelectSql(makeSpec({ orderBy: [{ column: 'name' }] }), 'snowflake');
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('NAME');
    });

    it('multiple ORDER BY columns', () => {
      const sql = generateSelectSql(
        makeSpec({ orderBy: [{ column: 'dept' }, { column: 'name', direction: 'asc' }] }),
        'snowflake'
      );
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('DEPT');
      expect(sql).toContain('NAME ASC');
    });
  });

  describe('WHERE clause', () => {
    it('emits WHERE', () => {
      const sql = generateSelectSql(makeSpec({ where: "status = 'active'" }), 'snowflake');
      expect(sql).toContain('WHERE');
      expect(sql).toContain("STATUS = 'active'");
    });

    it('combines WHERE with source filter', () => {
      const sql = generateSelectSql(
        makeSpec({
          source: { fqTableName: 'RAW.RAW_ORDERS', alias: 'o', filter: 'deleted = FALSE' },
          where: "status = 'active'",
        }),
        'snowflake'
      );
      expect(sql).toContain('WHERE');
      expect(sql).toContain('DELETED = FALSE');
      expect(sql).toContain("STATUS = 'active'");
      expect(sql).toContain('AND');
    });
  });

  describe('GROUP BY / HAVING', () => {
    it('emits GROUP BY', () => {
      const sql = generateSelectSql(
        makeSpec({
          columns: [
            { name: 'dept', expr: 'department' },
            { name: 'cnt', expr: 'count(*)' },
          ],
          groupBy: ['department'],
        }),
        'snowflake'
      );
      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('DEPARTMENT');
    });

    it('emits HAVING', () => {
      const sql = generateSelectSql(
        makeSpec({
          columns: [
            { name: 'dept', expr: 'department' },
            { name: 'cnt', expr: 'count(*)' },
          ],
          groupBy: ['department'],
          having: 'count(*) > 5',
        }),
        'snowflake'
      );
      expect(sql).toContain('HAVING');
      expect(sql).toContain('COUNT(*)');
    });
  });

  describe('QUALIFY', () => {
    it('snowflake: emits QUALIFY', () => {
      const sql = generateSelectSql(
        makeSpec({
          qualify: 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1',
        }),
        'snowflake'
      );
      expect(sql).toContain('QUALIFY');
    });

    it('bigquery: emits QUALIFY', () => {
      const sql = generateSelectSql(
        makeSpec({
          qualify: 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1',
        }),
        'bigquery'
      );
      expect(sql).toContain('QUALIFY');
    });

    it('postgres: emulates QUALIFY with a wrapping subquery', () => {
      const sql = generateSelectSql(
        makeSpec({
          qualify: 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1',
        }),
        'postgres'
      );
      expect(sql).not.toContain('QUALIFY');
      expect(sql).toContain('AS __bms_qualify_0');
      expect(sql).toContain('WHERE __bms_qualify_0 = 1');
    });
  });

  describe('WINDOW clause (named windows)', () => {
    it('WINDOW clause appears before QUALIFY', () => {
      const sql = generateSelectSql(
        makeSpec({
          windows: [{ name: 'w1', partitionBy: ['dept'] }],
          qualify: 'ROW_NUMBER() OVER w1 = 1',
        }),
        'bigquery'
      );
      const windowIdx = sql.indexOf('WINDOW');
      const qualifyIdx = sql.indexOf('QUALIFY');
      expect(windowIdx).toBeGreaterThanOrEqual(0);
      expect(qualifyIdx).toBeGreaterThanOrEqual(0);
      expect(windowIdx).toBeLessThan(qualifyIdx);
    });
  });
});
