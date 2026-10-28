import { describe, expect, it } from 'vitest';
import { emitExpr, parseExprField } from '../../../../src/compiler/expr/index.js';
import { TIMESTAMP_TRUNC_CASES } from './timestamp-trunc-expectations.js';
import type { DogsledExpr } from '../../../../src/compiler/expr/types.js';
import type { SupportedDialect } from '../../../../src/compiler/dialect.js';

const ALL_DIALECTS: SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'postgres',
  'databricks',
  'mysql',
  'duckdb',
];

describe('Expression emitter', () => {
  describe('column references', () => {
    it('snowflake: uppercases column names', () => {
      const expr: DogsledExpr = { kind: 'column_ref', column: 'my_col' };
      expect(emitExpr(expr, 'snowflake')).toBe('MY_COL');
    });

    it('bigquery: lowercases column names', () => {
      const expr: DogsledExpr = { kind: 'column_ref', column: 'MY_COL' };
      expect(emitExpr(expr, 'bigquery')).toBe('my_col');
    });

    it('postgres: lowercases column names', () => {
      const expr: DogsledExpr = { kind: 'column_ref', column: 'MY_COL' };
      expect(emitExpr(expr, 'postgres')).toBe('my_col');
    });

    it('qualified columns include table', () => {
      const expr: DogsledExpr = { kind: 'column_ref', table: 'orders', column: 'id' };
      expect(emitExpr(expr, 'snowflake')).toBe('ORDERS.ID');
      expect(emitExpr(expr, 'bigquery')).toBe('orders.id');
    });

    it('qualified star', () => {
      const expr: DogsledExpr = { kind: 'literal_star', table: 'orders' };
      expect(emitExpr(expr, 'snowflake')).toBe('ORDERS.*');
      expect(emitExpr(expr, 'bigquery')).toBe('orders.*');
    });
  });

  describe('leaf nodes', () => {
    it('string escapes single quotes', () => {
      const expr: DogsledExpr = { kind: 'literal_string', value: "it's" };
      expect(emitExpr(expr, 'snowflake')).toBe("'it''s'");
    });

    it('number integer', () => {
      const expr: DogsledExpr = { kind: 'literal_number', value: 42, raw: '42' };
      expect(emitExpr(expr, 'snowflake')).toBe('42');
    });

    it('number decimal preserves raw', () => {
      const expr: DogsledExpr = { kind: 'literal_number', value: 100.0, raw: '100.0' };
      expect(emitExpr(expr, 'snowflake')).toBe('100.0');
    });

    it('boolean', () => {
      expect(emitExpr({ kind: 'literal_boolean', value: true }, 'snowflake')).toBe('TRUE');
      expect(emitExpr({ kind: 'literal_boolean', value: false }, 'snowflake')).toBe('FALSE');
    });

    it('null', () => {
      expect(emitExpr({ kind: 'literal_null' }, 'snowflake')).toBe('NULL');
    });

    it('star', () => {
      expect(emitExpr({ kind: 'literal_star' }, 'snowflake')).toBe('*');
    });
  });

  describe('operators', () => {
    it('binary op', () => {
      const expr = parseExprField('a + b');
      expect(emitExpr(expr, 'snowflake')).toBe('A + B');
    });

    it('NOT LIKE', () => {
      const expr = parseExprField("name NOT LIKE '%test%'");
      expect(emitExpr(expr, 'snowflake')).toBe("NAME NOT LIKE '%test%'");
      expect(emitExpr(expr, 'bigquery')).toBe("name NOT LIKE '%test%'");
    });

    it('NOT ILIKE', () => {
      const expr = parseExprField("name NOT ILIKE '%test%'");
      expect(emitExpr(expr, 'snowflake')).toBe("NAME NOT ILIKE '%test%'");
    });

    it('unary NOT', () => {
      const expr = parseExprField('NOT x');
      expect(emitExpr(expr, 'snowflake')).toBe('NOT X');
    });

    it('unary minus', () => {
      const expr = parseExprField('-x');
      expect(emitExpr(expr, 'snowflake')).toBe('-X');
    });
  });

  describe('verbatim functions', () => {
    it('count(*) is universal', () => {
      const expr = parseExprField('count(*)');
      for (const d of ALL_DIALECTS) {
        expect(emitExpr(expr, d)).toContain('COUNT(*)');
      }
    });

    it('sum is universal', () => {
      const expr = parseExprField('sum(amount)');
      expect(emitExpr(expr, 'snowflake')).toBe('SUM(AMOUNT)');
      expect(emitExpr(expr, 'bigquery')).toBe('SUM(amount)');
    });

    it('coalesce is universal', () => {
      const expr = parseExprField('coalesce(a, b, c)');
      expect(emitExpr(expr, 'snowflake')).toBe('COALESCE(A, B, C)');
    });
  });

  describe('renamed functions', () => {
    it('bool_and: snowflake=BOOLAND_AGG, bigquery=LOGICAL_AND', () => {
      const expr = parseExprField('bool_and(flag)');
      expect(emitExpr(expr, 'snowflake')).toBe('BOOLAND_AGG(FLAG)');
      expect(emitExpr(expr, 'bigquery')).toBe('LOGICAL_AND(flag)');
      expect(emitExpr(expr, 'postgres')).toBe('BOOL_AND(flag)');
    });

    it('bool_or: snowflake=BOOLOR_AGG, bigquery=LOGICAL_OR', () => {
      const expr = parseExprField('bool_or(flag)');
      expect(emitExpr(expr, 'snowflake')).toBe('BOOLOR_AGG(FLAG)');
      expect(emitExpr(expr, 'bigquery')).toBe('LOGICAL_OR(flag)');
    });

    it('ifnull: postgres=COALESCE', () => {
      const expr = parseExprField('ifnull(a, b)');
      expect(emitExpr(expr, 'snowflake')).toBe('IFNULL(A, B)');
      expect(emitExpr(expr, 'postgres')).toBe('COALESCE(a, b)');
    });

    it('substring: snowflake/bigquery=SUBSTR', () => {
      const expr = parseExprField('substring(name, 1, 3)');
      expect(emitExpr(expr, 'snowflake')).toBe('SUBSTR(NAME, 1, 3)');
      expect(emitExpr(expr, 'bigquery')).toBe('SUBSTR(name, 1, 3)');
    });

    it('split_part: maps to native string splitting by dialect', () => {
      const expr = parseExprField("split_part(email, '@', 2)");
      expect(emitExpr(expr, 'bigquery')).toBe("SPLIT(email, '@')[SAFE_OFFSET(2 - 1)]");
      expect(emitExpr(expr, 'mysql')).toBe(
        "SUBSTRING_INDEX(SUBSTRING_INDEX(email, '@', 2), '@', -1)"
      );
      expect(emitExpr(expr, 'postgres')).toBe("split_part(email, '@', 2)");
    });

    it('power: bigquery=POW', () => {
      const expr = parseExprField('power(x, 2)');
      expect(emitExpr(expr, 'bigquery')).toBe('POW(x, 2)');
      expect(emitExpr(expr, 'snowflake')).toBe('POWER(X, 2)');
    });
  });

  describe('custom emitters', () => {
    it('date_trunc: bigquery reverses args and unquotes', () => {
      const expr = parseExprField("date_trunc('day', created_at)");
      expect(emitExpr(expr, 'snowflake')).toBe("DATE_TRUNC('day', CREATED_AT)");
      expect(emitExpr(expr, 'bigquery')).toBe('DATE_TRUNC(created_at, DAY)');
      expect(emitExpr(parseExprField("date_trunc('week', created_at)"), 'bigquery')).toBe(
        'DATE_TRUNC(created_at, WEEK(MONDAY))'
      );
    });

    it('timestamp_trunc: emits dialect-specific truncation functions', () => {
      const expr = parseExprField("timestamp_trunc('day', created_at)");
      for (const [dialect, expected] of TIMESTAMP_TRUNC_CASES) {
        expect(emitExpr(expr, dialect)).toBe(expected);
      }
    });

    it('date_trunc: mysql emulates with DATE/DATE_FORMAT', () => {
      expect(emitExpr(parseExprField("date_trunc('day', created_at)"), 'mysql')).toBe(
        'DATE(created_at)'
      );
      expect(emitExpr(parseExprField("date_trunc('month', created_at)"), 'mysql')).toBe(
        "CAST(DATE_FORMAT(created_at, '%Y-%m-01') AS DATE)"
      );
      expect(emitExpr(parseExprField("date_trunc('year', created_at)"), 'mysql')).toBe(
        "CAST(DATE_FORMAT(created_at, '%Y-01-01') AS DATE)"
      );
      expect(emitExpr(parseExprField("date_trunc('week', created_at)"), 'mysql')).toBe(
        'DATE(DATE_SUB(created_at, INTERVAL WEEKDAY(created_at) DAY))'
      );
      expect(emitExpr(parseExprField("date_trunc('quarter', created_at)"), 'mysql')).toBe(
        'MAKEDATE(YEAR(created_at), 1) + INTERVAL (QUARTER(created_at) - 1) QUARTER'
      );
    });

    it('datediff: snowflake standard, bigquery reversed', () => {
      const expr = parseExprField("datediff('day', start_date, end_date)");
      expect(emitExpr(expr, 'snowflake')).toBe("DATEDIFF('day', START_DATE, END_DATE)");
      expect(emitExpr(expr, 'bigquery')).toBe('DATE_DIFF(end_date, start_date, DAY)');
    });

    it('datediff: postgres uses date math', () => {
      const expr = parseExprField("datediff('day', start_date, end_date)");
      expect(emitExpr(expr, 'postgres')).toBe('(end_date::date - start_date::date)');
    });

    it('iff: snowflake=IFF, bigquery=IF, postgres=CASE WHEN', () => {
      const expr = parseExprField("iff(x > 0, 'yes', 'no')");
      expect(emitExpr(expr, 'snowflake')).toBe("IFF(X > 0, 'yes', 'no')");
      expect(emitExpr(expr, 'bigquery')).toBe("IF(x > 0, 'yes', 'no')");
      expect(emitExpr(expr, 'postgres')).toBe("CASE WHEN x > 0 THEN 'yes' ELSE 'no' END");
    });

    it('div0: snowflake=DIV0, bigquery=IFNULL(SAFE_DIVIDE), postgres=CASE', () => {
      const expr = parseExprField('div0(a, b)');
      expect(emitExpr(expr, 'snowflake')).toBe('DIV0(A, B)');
      expect(emitExpr(expr, 'bigquery')).toBe('IFNULL(SAFE_DIVIDE(a, b), 0)');
      expect(emitExpr(expr, 'postgres')).toBe('CASE WHEN b = 0 THEN 0 ELSE a / b END');
    });

    it('zeroifnull per dialect', () => {
      const expr = parseExprField('zeroifnull(col)');
      expect(emitExpr(expr, 'snowflake')).toBe('ZEROIFNULL(COL)');
      expect(emitExpr(expr, 'bigquery')).toBe('IFNULL(col, 0)');
      expect(emitExpr(expr, 'postgres')).toBe('COALESCE(col, 0)');
    });

    it('split_part: bigquery=SPLIT[OFFSET]', () => {
      const expr = parseExprField("split_part(email, '@', 1)");
      expect(emitExpr(expr, 'bigquery')).toContain('SPLIT');
      expect(emitExpr(expr, 'bigquery')).toContain('OFFSET');
    });

    it('json_value per dialect', () => {
      const expr = parseExprField("json_value(data, 'key')");
      expect(emitExpr(expr, 'snowflake')).toBe('DATA:key');
      expect(emitExpr(expr, 'bigquery')).toBe("JSON_VALUE(data, '$.key')");
      expect(emitExpr(expr, 'postgres')).toBe("data->>'key'");
    });

    it('json_value supports dotted paths', () => {
      const expr = parseExprField("json_value(data, 'workspace.id')");
      expect(emitExpr(expr, 'snowflake')).toBe('DATA:workspace:id');
      expect(emitExpr(expr, 'bigquery')).toBe("JSON_VALUE(data, '$.workspace.id')");
      expect(emitExpr(expr, 'postgres')).toBe("data->'workspace'->>'id'");
    });
  });

  describe('fixed function bugs', () => {
    it('mode bigquery extracts scalar from APPROX_TOP_COUNT', () => {
      const expr = parseExprField('mode(category)');
      const sql = emitExpr(expr, 'bigquery');
      expect(sql).toBe('APPROX_TOP_COUNT(category, 1)[OFFSET(0)].value');
    });

    it('mode postgres uses WITHIN GROUP', () => {
      const expr = parseExprField('mode(category)');
      expect(emitExpr(expr, 'postgres')).toBe('MODE() WITHIN GROUP (ORDER BY category)');
    });

    it('to_date bigquery 1-arg uses DATE()', () => {
      const expr = parseExprField('to_date(col)');
      expect(emitExpr(expr, 'bigquery')).toBe('DATE(col)');
    });

    it('to_date bigquery 2-arg uses PARSE_DATE with reversed args', () => {
      const expr = parseExprField("to_date(col, '%Y-%m-%d')");
      expect(emitExpr(expr, 'bigquery')).toBe("PARSE_DATE('%Y-%m-%d', col)");
    });

    it('to_timestamp bigquery 1-arg uses TIMESTAMP()', () => {
      const expr = parseExprField('to_timestamp(col)');
      expect(emitExpr(expr, 'bigquery')).toBe('TIMESTAMP(col)');
    });

    it('to_timestamp bigquery 2-arg uses PARSE_TIMESTAMP', () => {
      const expr = parseExprField("to_timestamp(col, '%Y-%m-%d')");
      expect(emitExpr(expr, 'bigquery')).toBe("PARSE_TIMESTAMP('%Y-%m-%d', col)");
    });

    it('count_distinct all dialects emit COUNT(DISTINCT ...)', () => {
      const expr = parseExprField('count_distinct(user_id)');
      for (const d of ALL_DIALECTS) {
        const sql = emitExpr(expr, d);
        expect(sql).toMatch(/COUNT\(DISTINCT/i);
      }
    });
  });

  describe('CAST', () => {
    it('simple type', () => {
      const expr = parseExprField('CAST(x AS INTEGER)');
      expect(emitExpr(expr, 'snowflake')).toBe('CAST(X AS INTEGER)');
    });

    it('type with params', () => {
      const expr = parseExprField('CAST(x AS NUMERIC(10, 2))');
      expect(emitExpr(expr, 'snowflake')).toBe('CAST(X AS NUMERIC(10, 2))');
    });

    it('multi-word type', () => {
      const expr = parseExprField('CAST(x AS TIMESTAMP WITH TIME ZONE)');
      expect(emitExpr(expr, 'snowflake')).toBe('CAST(X AS TIMESTAMP WITH TIME ZONE)');
    });
  });

  describe(':: cast shorthand', () => {
    it('snowflake emits :: shorthand', () => {
      const expr = parseExprField('x::INTEGER');
      expect(emitExpr(expr, 'snowflake')).toBe('X::INTEGER');
    });

    it('postgres emits :: shorthand', () => {
      const expr = parseExprField('x::VARCHAR(255)');
      expect(emitExpr(expr, 'postgres')).toBe('x::varchar(255)');
    });

    it('duckdb emits :: shorthand', () => {
      const expr = parseExprField('x::TIMESTAMP WITH TIME ZONE');
      expect(emitExpr(expr, 'duckdb')).toBe('x::timestamp with time zone');
    });

    it('bigquery emits CAST', () => {
      const expr = parseExprField('x::INTEGER');
      expect(emitExpr(expr, 'bigquery')).toBe('CAST(x AS integer)');
    });

    it('databricks emits CAST', () => {
      const expr = parseExprField('x::INTEGER');
      expect(emitExpr(expr, 'databricks')).toBe('CAST(x AS integer)');
    });

    it('mysql emits CAST', () => {
      const expr = parseExprField('x::INTEGER');
      expect(emitExpr(expr, 'mysql')).toBe('CAST(x AS integer)');
    });

    it('preserves expression in shorthand', () => {
      const expr = parseExprField('COALESCE(x, y)::STRING');
      expect(emitExpr(expr, 'snowflake')).toBe('COALESCE(X, Y)::STRING');
    });

    it('wraps binary lhs when emitting shorthand', () => {
      const expr = parseExprField('(x + y)::STRING');
      expect(emitExpr(expr, 'snowflake')).toBe('(X + Y)::STRING');
    });

    it('emits json path shorthand casts per dialect', () => {
      const expr = parseExprField('f.VALUE:emails[0]:address::STRING');
      expect(emitExpr(expr, 'snowflake')).toBe('F.VALUE:emails[0]:address::STRING');
      expect(emitExpr(expr, 'bigquery')).toBe(
        "CAST(JSON_VALUE(f.value, '$.emails[0].address') AS string)"
      );
      expect(emitExpr(expr, 'postgres')).toBe("(f.value->'emails'->0->>'address')::string");
      expect(emitExpr(expr, 'mysql')).toBe(
        "CAST(JSON_UNQUOTE(JSON_EXTRACT(f.value, '$.emails[0].address')) AS string)"
      );
    });
  });

  describe('JSON path access', () => {
    it('emits bare json path access per dialect', () => {
      const expr = parseExprField('DATA:workspace:id');
      expect(emitExpr(expr, 'snowflake')).toBe('DATA:workspace:id');
      expect(emitExpr(expr, 'bigquery')).toBe("JSON_QUERY(data, '$.workspace.id')");
      expect(emitExpr(expr, 'postgres')).toBe("data->'workspace'->'id'");
      expect(emitExpr(expr, 'duckdb')).toBe("data->'workspace'->'id'");
    });

    it('databricks emits dot-access for json_path_access AST', () => {
      const expr = parseExprField('DATA:workspace:id');
      expect(emitExpr(expr, 'databricks')).toBe('data.workspace.id');
    });

    it('escapes single-quote in key names for postgres/duckdb', () => {
      const expr: DogsledExpr = {
        kind: 'json_path_access',
        base: { kind: 'column_ref', column: 'data' },
        steps: [{ kind: 'key', name: "evil'injection" }],
      };
      // Bare (non-cast) json_path_access uses -> (not ->>) at the tail
      expect(emitExpr(expr, 'postgres')).toBe("data->'evil''injection'");
      expect(emitExpr(expr, 'duckdb')).toBe("data->'evil''injection'");
    });

    it('escapes single-quote in bigquery/mysql json path literal', () => {
      const expr: DogsledExpr = {
        kind: 'json_path_access',
        base: { kind: 'column_ref', column: 'data' },
        steps: [{ kind: 'key', name: "evil'key" }],
      };
      expect(emitExpr(expr, 'bigquery')).toBe("JSON_QUERY(data, '$.evil\\'key')");
      expect(emitExpr(expr, 'mysql')).toBe("JSON_EXTRACT(data, '$.evil''key')");
    });

    it('quotes non-identifier key names on snowflake', () => {
      const expr: DogsledExpr = {
        kind: 'json_path_access',
        base: { kind: 'column_ref', column: 'DATA' },
        steps: [{ kind: 'key', name: 'weird key' }],
      };
      expect(emitExpr(expr, 'snowflake')).toBe('DATA:"weird key"');
    });

    it('backtick-quotes non-identifier key names on databricks', () => {
      const expr: DogsledExpr = {
        kind: 'json_path_access',
        base: { kind: 'column_ref', column: 'data' },
        steps: [{ kind: 'key', name: 'weird-key' }],
      };
      expect(emitExpr(expr, 'databricks')).toBe('data.`weird-key`');
    });

    it('rejects key names with newlines', () => {
      const expr: DogsledExpr = {
        kind: 'json_path_access',
        base: { kind: 'column_ref', column: 'DATA' },
        steps: [{ kind: 'key', name: 'a\nb' }],
      };
      expect(() => emitExpr(expr, 'snowflake')).toThrow(/unsafe character/);
      expect(() => emitExpr(expr, 'bigquery')).toThrow(/unsafe character/);
      expect(() => emitExpr(expr, 'postgres')).toThrow(/unsafe character/);
    });
  });

  describe('CASE', () => {
    it('searched CASE', () => {
      const expr = parseExprField("CASE WHEN x > 0 THEN 'pos' ELSE 'neg' END");
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toBe("CASE WHEN X > 0 THEN 'pos' ELSE 'neg' END");
    });

    it('simple CASE with operand', () => {
      const expr = parseExprField("CASE status WHEN 'A' THEN 1 WHEN 'B' THEN 2 END");
      const sql = emitExpr(expr, 'snowflake');
      expect(sql).toContain('CASE STATUS');
      expect(sql).toContain("WHEN 'A' THEN 1");
    });
  });

  describe('predicates', () => {
    it('BETWEEN', () => {
      const expr = parseExprField('x BETWEEN 1 AND 10');
      expect(emitExpr(expr, 'snowflake')).toBe('X BETWEEN 1 AND 10');
    });

    it('NOT BETWEEN', () => {
      const expr = parseExprField('x NOT BETWEEN 1 AND 10');
      expect(emitExpr(expr, 'snowflake')).toBe('X NOT BETWEEN 1 AND 10');
    });

    it('IN', () => {
      const expr = parseExprField('x IN (1, 2, 3)');
      expect(emitExpr(expr, 'snowflake')).toBe('X IN (1, 2, 3)');
    });

    it('NOT IN', () => {
      const expr = parseExprField('x NOT IN (1, 2)');
      expect(emitExpr(expr, 'snowflake')).toBe('X NOT IN (1, 2)');
    });

    it('IS NULL', () => {
      const expr = parseExprField('x IS NULL');
      expect(emitExpr(expr, 'snowflake')).toBe('X IS NULL');
    });

    it('IS NOT NULL', () => {
      const expr = parseExprField('x IS NOT NULL');
      expect(emitExpr(expr, 'snowflake')).toBe('X IS NOT NULL');
    });
  });

  describe('DISTINCT', () => {
    it('count(DISTINCT id)', () => {
      const expr = parseExprField('count(DISTINCT id)');
      expect(emitExpr(expr, 'snowflake')).toBe('COUNT(DISTINCT ID)');
    });
  });

  describe('parenthesized', () => {
    it('wraps in parens', () => {
      const expr = parseExprField('(a + b)');
      expect(emitExpr(expr, 'snowflake')).toBe('(A + B)');
    });
  });

  describe('precedence-aware parenthesization', () => {
    it('wraps lower-precedence children: (a + b) * c', () => {
      const expr: DogsledExpr = {
        kind: 'binary_op',
        op: '*',
        left: {
          kind: 'binary_op',
          op: '+',
          left: { kind: 'column_ref', column: 'a' },
          right: { kind: 'column_ref', column: 'b' },
        },
        right: { kind: 'column_ref', column: 'c' },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('(A + B) * C');
    });

    it('does not wrap same-or-higher precedence left child: a * b + c', () => {
      const expr: DogsledExpr = {
        kind: 'binary_op',
        op: '+',
        left: {
          kind: 'binary_op',
          op: '*',
          left: { kind: 'column_ref', column: 'a' },
          right: { kind: 'column_ref', column: 'b' },
        },
        right: { kind: 'column_ref', column: 'c' },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('A * B + C');
    });

    it('wraps right child at same precedence for non-commutative ops: a - (b - c)', () => {
      const expr: DogsledExpr = {
        kind: 'binary_op',
        op: '-',
        left: { kind: 'column_ref', column: 'a' },
        right: {
          kind: 'binary_op',
          op: '-',
          left: { kind: 'column_ref', column: 'b' },
          right: { kind: 'column_ref', column: 'c' },
        },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('A - (B - C)');
    });

    it('does not wrap left child at same precedence: a - b + c', () => {
      const expr: DogsledExpr = {
        kind: 'binary_op',
        op: '+',
        left: {
          kind: 'binary_op',
          op: '-',
          left: { kind: 'column_ref', column: 'a' },
          right: { kind: 'column_ref', column: 'b' },
        },
        right: { kind: 'column_ref', column: 'c' },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('A - B + C');
    });

    it('wraps OR inside AND: a AND (b OR c)', () => {
      const expr: DogsledExpr = {
        kind: 'binary_op',
        op: 'AND',
        left: { kind: 'column_ref', column: 'a' },
        right: {
          kind: 'binary_op',
          op: 'OR',
          left: { kind: 'column_ref', column: 'b' },
          right: { kind: 'column_ref', column: 'c' },
        },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('A AND (B OR C)');
    });

    it('NOT wraps binary operand: NOT (a AND b)', () => {
      const expr: DogsledExpr = {
        kind: 'unary_op',
        op: 'NOT',
        operand: {
          kind: 'binary_op',
          op: 'AND',
          left: { kind: 'column_ref', column: 'a' },
          right: { kind: 'column_ref', column: 'b' },
        },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('NOT (A AND B)');
    });

    it('NOT does not wrap column ref: NOT x', () => {
      const expr: DogsledExpr = {
        kind: 'unary_op',
        op: 'NOT',
        operand: { kind: 'column_ref', column: 'x' },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('NOT X');
    });

    it('nested: (a + b) * (c - d)', () => {
      const expr: DogsledExpr = {
        kind: 'binary_op',
        op: '*',
        left: {
          kind: 'binary_op',
          op: '+',
          left: { kind: 'column_ref', column: 'a' },
          right: { kind: 'column_ref', column: 'b' },
        },
        right: {
          kind: 'binary_op',
          op: '-',
          left: { kind: 'column_ref', column: 'c' },
          right: { kind: 'column_ref', column: 'd' },
        },
      };
      expect(emitExpr(expr, 'snowflake')).toBe('(A + B) * (C - D)');
    });
  });

  describe('countif function', () => {
    it('snowflake: COUNT_IF', () => {
      const expr = parseExprField("countif(status = 'active')");
      expect(emitExpr(expr, 'snowflake')).toBe("COUNT_IF(STATUS = 'active')");
    });

    it('bigquery: COUNTIF', () => {
      const expr = parseExprField("countif(level = 'ERROR')");
      expect(emitExpr(expr, 'bigquery')).toBe("COUNTIF(level = 'ERROR')");
    });

    it('postgres: COUNT(*) FILTER (WHERE ...)', () => {
      const expr = parseExprField("countif(level = 'ERROR')");
      expect(emitExpr(expr, 'postgres')).toBe("COUNT(*) FILTER (WHERE level = 'ERROR')");
    });

    it('databricks: COUNT_IF', () => {
      const expr = parseExprField('countif(x > 0)');
      expect(emitExpr(expr, 'databricks')).toBe('COUNT_IF(x > 0)');
    });

    it('duckdb: COUNT_IF', () => {
      const expr = parseExprField('countif(x > 0)');
      expect(emitExpr(expr, 'duckdb')).toBe('COUNT_IF(x > 0)');
    });
  });

  describe('timestamp_diff function', () => {
    it('bigquery: TIMESTAMP_DIFF with reversed args and unquoted unit', () => {
      const expr = parseExprField("timestamp_diff('second', start_ts, end_ts)");
      expect(emitExpr(expr, 'bigquery')).toBe('TIMESTAMP_DIFF(end_ts, start_ts, SECOND)');
    });

    it('snowflake: TIMESTAMPDIFF with unquoted unit', () => {
      const expr = parseExprField("timestamp_diff('second', start_ts, end_ts)");
      expect(emitExpr(expr, 'snowflake')).toBe('TIMESTAMPDIFF(SECOND, START_TS, END_TS)');
    });

    it('postgres: EXTRACT(EPOCH FROM ...)', () => {
      const expr = parseExprField("timestamp_diff('second', start_ts, end_ts)");
      expect(emitExpr(expr, 'postgres')).toBe(
        'EXTRACT(EPOCH FROM (end_ts::timestamp - start_ts::timestamp))'
      );
    });

    it('postgres: minute unit divides by 60', () => {
      const expr = parseExprField("timestamp_diff('minute', start_ts, end_ts)");
      expect(emitExpr(expr, 'postgres')).toBe(
        'EXTRACT(EPOCH FROM (end_ts::timestamp - start_ts::timestamp)) / 60'
      );
    });

    it('duckdb: TIMESTAMPDIFF with unit and arg order', () => {
      const expr = parseExprField("timestamp_diff('second', start_ts, end_ts)");
      expect(emitExpr(expr, 'duckdb')).toBe('TIMESTAMPDIFF(SECOND, start_ts, end_ts)');
    });
  });

  describe('reserved word quoting in column refs', () => {
    it('bigquery: quotes reserved word trigger', () => {
      const expr = parseExprField("trigger = 'Manual'");
      expect(emitExpr(expr, 'bigquery')).toBe("`trigger` = 'Manual'");
    });

    it('snowflake: quotes reserved word trigger', () => {
      const expr = parseExprField("trigger = 'Manual'");
      expect(emitExpr(expr, 'snowflake')).toBe('"TRIGGER" = \'Manual\'');
    });

    it('does not quote non-reserved words', () => {
      const expr = parseExprField("status = 'active'");
      expect(emitExpr(expr, 'bigquery')).toBe("status = 'active'");
    });

    it('does not quote qualified column refs (table.col)', () => {
      // Qualified refs are always safe — the table prefix disambiguates
      const expr: DogsledExpr = { kind: 'column_ref', table: 'events', column: 'trigger' };
      expect(emitExpr(expr, 'bigquery')).toBe('events.trigger');
    });
  });

  describe('raw_sql security checks', () => {
    it('rejects dangerous raw_sql in top-level expressions', () => {
      const expr: DogsledExpr = { kind: 'raw_sql', sql: 'DROP TABLE users' };
      expect(() => emitExpr(expr, 'snowflake')).toThrow(/dangerous SQL/);
    });

    it('rejects semicolons in raw_sql expressions', () => {
      const expr: DogsledExpr = { kind: 'raw_sql', sql: 'col; DROP TABLE users' };
      expect(() => emitExpr(expr, 'snowflake')).toThrow(/dangerous SQL/);
    });

    it('allows safe raw_sql expressions', () => {
      const expr: DogsledExpr = { kind: 'raw_sql', sql: 'LATERAL FLATTEN(INPUT => PAYLOAD)' };
      expect(emitExpr(expr, 'snowflake')).toBe('LATERAL FLATTEN(INPUT => PAYLOAD)');
    });

    it('rejects dangerous raw_sql in window frame expressions', () => {
      const expr: DogsledExpr = {
        kind: 'window',
        fn: { kind: 'function_call', name: 'ROW_NUMBER', args: [] },
        orderBy: [{ expr: { kind: 'column_ref', column: 'id' }, direction: 'ASC' }],
        frame: { kind: 'raw_sql', sql: 'DROP TABLE users' },
      };
      expect(() => emitExpr(expr, 'snowflake')).toThrow(/window frame contains dangerous SQL/);
    });

    it('rejects semicolons in window frame raw_sql', () => {
      const expr: DogsledExpr = {
        kind: 'window',
        fn: { kind: 'function_call', name: 'SUM', args: [{ kind: 'column_ref', column: 'amt' }] },
        orderBy: [{ expr: { kind: 'column_ref', column: 'id' }, direction: 'ASC' }],
        frame: { kind: 'raw_sql', sql: 'ROWS UNBOUNDED PRECEDING; DELETE FROM orders' },
      };
      expect(() => emitExpr(expr, 'snowflake')).toThrow(/window frame contains dangerous SQL/);
    });

    it('allows safe window frame raw_sql', () => {
      const expr: DogsledExpr = {
        kind: 'window',
        fn: { kind: 'function_call', name: 'SUM', args: [{ kind: 'column_ref', column: 'amt' }] },
        orderBy: [{ expr: { kind: 'column_ref', column: 'id' }, direction: 'ASC' }],
        frame: { kind: 'raw_sql', sql: 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW' },
      };
      const result = emitExpr(expr, 'snowflake');
      expect(result).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
    });
  });

  describe('unknown functions use dialect casing', () => {
    it('snowflake: uppercases unknown function', () => {
      const expr = parseExprField('my_custom_udf(x, y)');
      expect(emitExpr(expr, 'snowflake')).toBe('MY_CUSTOM_UDF(X, Y)');
    });

    it('bigquery: lowercases unknown function', () => {
      const expr = parseExprField('my_custom_udf(x, y)');
      expect(emitExpr(expr, 'bigquery')).toBe('my_custom_udf(x, y)');
    });
  });

  describe('pgvector/redshift inherit canonical dialect emitters', () => {
    it('pgvector: countif uses postgres COUNT(*) FILTER emitter', () => {
      const expr = parseExprField("countif(level = 'ERROR')");
      expect(emitExpr(expr, 'pgvector')).toBe("COUNT(*) FILTER (WHERE level = 'ERROR')");
    });

    it('redshift: countif uses postgres COUNT(*) FILTER emitter', () => {
      const expr = parseExprField("countif(level = 'ERROR')");
      expect(emitExpr(expr, 'redshift')).toBe("COUNT(*) FILTER (WHERE level = 'ERROR')");
    });

    it('pgvector: ifnull uses postgres COALESCE emitter', () => {
      const expr = parseExprField('ifnull(a, b)');
      expect(emitExpr(expr, 'pgvector')).toBe('COALESCE(a, b)');
    });

    it('redshift: ifnull uses postgres COALESCE emitter', () => {
      const expr = parseExprField('ifnull(a, b)');
      expect(emitExpr(expr, 'redshift')).toBe('COALESCE(a, b)');
    });

    it('pgvector: bool_and uses postgres emitter', () => {
      const expr = parseExprField('bool_and(flag)');
      expect(emitExpr(expr, 'pgvector')).toBe('BOOL_AND(flag)');
    });

    it('redshift: bool_and uses postgres emitter', () => {
      const expr = parseExprField('bool_and(flag)');
      expect(emitExpr(expr, 'redshift')).toBe('BOOL_AND(flag)');
    });
  });
});
