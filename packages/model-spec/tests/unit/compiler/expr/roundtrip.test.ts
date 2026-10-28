import { describe, expect, it } from 'vitest';
import { emitExpr, parseExprField } from '../../../../src/compiler/expr/index.js';
import type { SupportedDialect } from '../../../../src/compiler/dialect.js';
import { TIMESTAMP_TRUNC_CASES } from './timestamp-trunc-expectations.js';

/** Parse an expression and emit it for the given dialect. */
function roundtrip(input: string, dialect: SupportedDialect): string {
  return emitExpr(parseExprField(input), dialect);
}

describe('Expression roundtrip (parse → emit)', () => {
  describe('column references', () => {
    it('snowflake uppercases', () => {
      expect(roundtrip('my_col', 'snowflake')).toBe('MY_COL');
    });

    it('bigquery lowercases', () => {
      expect(roundtrip('MY_COL', 'bigquery')).toBe('my_col');
    });

    it('qualified column', () => {
      expect(roundtrip('t.col', 'snowflake')).toBe('T.COL');
      expect(roundtrip('t.col', 'postgres')).toBe('t.col');
    });
  });

  describe('arithmetic', () => {
    it('preserves operation', () => {
      expect(roundtrip('a * b', 'snowflake')).toBe('A * B');
    });

    it('preserves precedence', () => {
      expect(roundtrip('a + b * c', 'snowflake')).toBe('A + B * C');
    });
  });

  describe('count(*)', () => {
    it('universal across dialects', () => {
      for (const d of ['snowflake', 'bigquery', 'postgres', 'databricks'] as const) {
        expect(roundtrip('count(*)', d)).toBe('COUNT(*)');
      }
    });
  });

  describe('date_trunc', () => {
    it('snowflake: standard form', () => {
      expect(roundtrip("date_trunc('day', created_at)", 'snowflake')).toBe(
        "DATE_TRUNC('day', CREATED_AT)"
      );
    });

    it('bigquery: reversed and unquoted', () => {
      expect(roundtrip("date_trunc('day', created_at)", 'bigquery')).toBe(
        'DATE_TRUNC(created_at, DAY)'
      );
    });
  });

  describe('timestamp_trunc', () => {
    for (const [dialect, expected] of TIMESTAMP_TRUNC_CASES) {
      it(`${dialect}: emits the expected truncation function`, () => {
        expect(roundtrip("timestamp_trunc('day', created_at)", dialect)).toBe(expected);
      });
    }
  });

  describe('datediff', () => {
    it('snowflake: standard', () => {
      expect(roundtrip("datediff('day', a, b)", 'snowflake')).toBe("DATEDIFF('day', A, B)");
    });

    it('bigquery: reversed and renamed', () => {
      expect(roundtrip("datediff('day', a, b)", 'bigquery')).toBe('DATE_DIFF(b, a, DAY)');
    });

    it('postgres: date math', () => {
      expect(roundtrip("datediff('day', a, b)", 'postgres')).toBe('(b::date - a::date)');
    });

    it('databricks: standard', () => {
      expect(roundtrip("datediff('day', a, b)", 'databricks')).toBe("DATEDIFF('day', a, b)");
    });
  });

  describe('coalesce', () => {
    it('universal', () => {
      expect(roundtrip('coalesce(a, b)', 'snowflake')).toBe('COALESCE(A, B)');
      expect(roundtrip('coalesce(a, b)', 'postgres')).toBe('COALESCE(a, b)');
    });
  });

  describe('iff', () => {
    it('snowflake: IFF', () => {
      expect(roundtrip("iff(x > 0, 'yes', 'no')", 'snowflake')).toBe("IFF(X > 0, 'yes', 'no')");
    });

    it('bigquery: IF', () => {
      expect(roundtrip("iff(x > 0, 'yes', 'no')", 'bigquery')).toBe("IF(x > 0, 'yes', 'no')");
    });

    it('postgres: CASE WHEN', () => {
      expect(roundtrip("iff(x > 0, 'yes', 'no')", 'postgres')).toBe(
        "CASE WHEN x > 0 THEN 'yes' ELSE 'no' END"
      );
    });
  });

  describe('CASE WHEN', () => {
    it('structure preserved', () => {
      const sql = roundtrip("CASE WHEN x > 0 THEN 'a' ELSE 'b' END", 'snowflake');
      expect(sql).toBe("CASE WHEN X > 0 THEN 'a' ELSE 'b' END");
    });
  });

  describe('CAST', () => {
    it('with type params', () => {
      expect(roundtrip('CAST(x AS NUMERIC(10, 2))', 'snowflake')).toBe('CAST(X AS NUMERIC(10, 2))');
    });
  });

  describe(':: shorthand', () => {
    it('snowflake roundtrips ::', () => {
      expect(roundtrip('x::INTEGER', 'snowflake')).toBe('X::INTEGER');
    });

    it('postgres roundtrips ::', () => {
      expect(roundtrip('x::VARCHAR(255)', 'postgres')).toBe('x::varchar(255)');
    });

    it('duckdb roundtrips ::', () => {
      expect(roundtrip('x::DOUBLE PRECISION', 'duckdb')).toBe('x::double precision');
    });

    it('bigquery emits CAST for :: shorthand', () => {
      expect(roundtrip('x::INTEGER', 'bigquery')).toBe('CAST(x AS integer)');
    });

    it('databricks emits CAST for :: shorthand', () => {
      expect(roundtrip('x::INTEGER', 'databricks')).toBe('CAST(x AS integer)');
    });

    it('mysql emits CAST for :: shorthand', () => {
      expect(roundtrip('x::INTEGER', 'mysql')).toBe('CAST(x AS integer)');
    });

    it('roundtrip: parse then emit then parse then emit', () => {
      const first = parseExprField('x::TIMESTAMP WITH TIME ZONE');
      const emitted = emitExpr(first, 'snowflake');
      const second = parseExprField(emitted);
      const reEmitted = emitExpr(second, 'snowflake');
      expect(reEmitted).toBe(emitted);
    });
  });

  describe('nested expressions', () => {
    it('count(CASE WHEN ...)', () => {
      const sql = roundtrip("count(CASE WHEN status = 'active' THEN 1 END)", 'snowflake');
      expect(sql).toContain('COUNT(');
      expect(sql).toContain('CASE WHEN');
    });

    it('upper(trim(name))', () => {
      expect(roundtrip('upper(trim(name))', 'snowflake')).toBe('UPPER(TRIM(NAME))');
    });

    it('sum(CASE WHEN ...)', () => {
      const sql = roundtrip("sum(CASE WHEN type = 'credit' THEN amount ELSE 0 END)", 'snowflake');
      expect(sql).toContain('SUM(');
      expect(sql).toContain('CASE WHEN');
    });
  });

  describe('bool_and per dialect', () => {
    it('snowflake: BOOLAND_AGG', () => {
      expect(roundtrip('bool_and(flag)', 'snowflake')).toBe('BOOLAND_AGG(FLAG)');
    });

    it('bigquery: LOGICAL_AND', () => {
      expect(roundtrip('bool_and(flag)', 'bigquery')).toBe('LOGICAL_AND(flag)');
    });

    it('postgres: BOOL_AND', () => {
      expect(roundtrip('bool_and(flag)', 'postgres')).toBe('BOOL_AND(flag)');
    });
  });

  describe('ifnull', () => {
    it('snowflake keeps IFNULL', () => {
      expect(roundtrip('ifnull(a, b)', 'snowflake')).toBe('IFNULL(A, B)');
    });

    it('postgres converts to COALESCE', () => {
      expect(roundtrip('ifnull(a, b)', 'postgres')).toBe('COALESCE(a, b)');
    });
  });

  describe('complex real-world expressions', () => {
    it('conditional aggregate', () => {
      const sql = roundtrip("sum(CASE WHEN type = 'revenue' THEN amount ELSE 0 END)", 'snowflake');
      expect(sql).toContain('SUM(');
      expect(sql).toContain("WHEN TYPE = 'revenue'");
    });

    it('string concatenation', () => {
      expect(roundtrip("first_name || ' ' || last_name", 'snowflake')).toBe(
        "FIRST_NAME || ' ' || LAST_NAME"
      );
    });

    it('CAST inside function', () => {
      const sql = roundtrip('round(CAST(amount AS NUMERIC(10, 2)), 2)', 'snowflake');
      expect(sql).toContain('ROUND(');
      expect(sql).toContain('CAST(AMOUNT AS NUMERIC(10, 2))');
    });

    it('comparison with IS NULL', () => {
      expect(roundtrip('x IS NULL', 'snowflake')).toBe('X IS NULL');
    });

    it('BETWEEN with columns', () => {
      expect(roundtrip('price BETWEEN min_val AND max_val', 'snowflake')).toBe(
        'PRICE BETWEEN MIN_VAL AND MAX_VAL'
      );
    });
  });
});
