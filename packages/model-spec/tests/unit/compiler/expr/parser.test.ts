import { describe, expect, it } from 'vitest';
import { parseExprField, tryParseExpr } from '../../../../src/compiler/expr/index.js';

describe('Expression parser', () => {
  describe('literals', () => {
    it('NULL', () => {
      const expr = parseExprField('NULL');
      expect(expr.kind).toBe('literal_null');
    });

    it('TRUE', () => {
      const expr = parseExprField('TRUE');
      expect(expr).toEqual({ kind: 'literal_boolean', value: true });
    });

    it('FALSE', () => {
      const expr = parseExprField('FALSE');
      expect(expr).toEqual({ kind: 'literal_boolean', value: false });
    });

    it('integer', () => {
      const expr = parseExprField('42');
      expect(expr).toEqual({ kind: 'literal_number', value: 42, raw: '42' });
    });

    it('decimal', () => {
      const expr = parseExprField('3.14');
      expect(expr).toEqual({ kind: 'literal_number', value: 3.14, raw: '3.14' });
    });

    it('leading-dot decimal (.5)', () => {
      const expr = parseExprField('.5');
      expect(expr.kind).toBe('literal_number');
      if (expr.kind === 'literal_number') {
        expect(expr.value).toBe(0.5);
        expect(expr.raw).toBe('.5');
      }
    });

    it('string with escaped quotes', () => {
      const expr = parseExprField("'it''s a test'");
      expect(expr).toEqual({ kind: 'literal_string', value: "it's a test" });
    });

    it('star (*)', () => {
      const expr = parseExprField('*');
      expect(expr).toEqual({ kind: 'literal_star' });
    });
  });

  describe('column references', () => {
    it('simple column', () => {
      const expr = parseExprField('my_column');
      expect(expr).toEqual({ kind: 'column_ref', column: 'my_column' });
    });

    it('qualified column (table.column)', () => {
      const expr = parseExprField('orders.total');
      expect(expr).toEqual({ kind: 'column_ref', table: 'orders', column: 'total' });
    });

    it('qualified star (table.*)', () => {
      const expr = parseExprField('orders.*');
      expect(expr).toEqual({ kind: 'literal_star', table: 'orders' });
    });

    it('preserves case', () => {
      const expr = parseExprField('MyColumn');
      expect(expr).toEqual({ kind: 'column_ref', column: 'MyColumn' });
    });
  });

  describe('JSON path access', () => {
    it('parses colon-separated key access', () => {
      const expr = parseExprField('DATA:workspace:id');
      expect(expr.kind).toBe('json_path_access');
      if (expr.kind === 'json_path_access') {
        expect(expr.base).toEqual({ kind: 'column_ref', column: 'DATA' });
        expect(expr.steps).toEqual([
          { kind: 'key', name: 'workspace' },
          { kind: 'key', name: 'id' },
        ]);
      }
    });

    it('parses mixed key and array index access', () => {
      const expr = parseExprField('f.VALUE:emails[0]:address');
      expect(expr.kind).toBe('json_path_access');
      if (expr.kind === 'json_path_access') {
        expect(expr.base).toEqual({ kind: 'column_ref', table: 'f', column: 'VALUE' });
        expect(expr.steps).toEqual([
          { kind: 'key', name: 'emails' },
          { kind: 'index', n: 0 },
          { kind: 'key', name: 'address' },
        ]);
      }
    });
  });

  describe('arithmetic operators', () => {
    it.each(['+', '-', '*', '/', '%'] as const)('parses %s', (op) => {
      const expr = parseExprField(`a ${op} b`);
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe(op);
      }
    });
  });

  describe('comparison operators', () => {
    it.each(['=', '!=', '<', '>', '<=', '>='] as const)('parses %s', (op) => {
      const expr = parseExprField(`a ${op} b`);
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe(op);
      }
    });

    it('<> normalizes to !=', () => {
      const expr = parseExprField('a <> b');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('!=');
      }
    });
  });

  describe('logical operators', () => {
    it('AND', () => {
      const expr = parseExprField('a AND b');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') expect(expr.op).toBe('AND');
    });

    it('OR', () => {
      const expr = parseExprField('a OR b');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') expect(expr.op).toBe('OR');
    });

    it('NOT', () => {
      const expr = parseExprField('NOT a');
      expect(expr.kind).toBe('unary_op');
      if (expr.kind === 'unary_op') expect(expr.op).toBe('NOT');
    });
  });

  describe('string operators', () => {
    it('LIKE', () => {
      const expr = parseExprField("name LIKE '%test%'");
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') expect(expr.op).toBe('LIKE');
    });

    it('ILIKE', () => {
      const expr = parseExprField("name ILIKE '%test%'");
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') expect(expr.op).toBe('ILIKE');
    });

    it('NOT LIKE', () => {
      const expr = parseExprField("name NOT LIKE '%test%'");
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('NOT LIKE');
      }
    });

    it('NOT ILIKE', () => {
      const expr = parseExprField("name NOT ILIKE '%test%'");
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('NOT ILIKE');
      }
    });

    it('NOT LIKE with AND', () => {
      const expr = parseExprField("name NOT LIKE '%test%' AND status = 'active'");
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('AND');
        expect(expr.left.kind).toBe('binary_op');
        if (expr.left.kind === 'binary_op') {
          expect(expr.left.op).toBe('NOT LIKE');
        }
      }
    });

    it('|| concat', () => {
      const expr = parseExprField("first_name || ' ' || last_name");
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') expect(expr.op).toBe('||');
    });
  });

  describe('operator precedence', () => {
    it('* binds tighter than +', () => {
      const expr = parseExprField('a + b * c');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('+');
        expect(expr.right.kind).toBe('binary_op');
      }
    });

    it('AND binds tighter than OR', () => {
      const expr = parseExprField('a OR b AND c');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('OR');
        expect(expr.right.kind).toBe('binary_op');
      }
    });

    it('NOT binds tighter than AND', () => {
      const expr = parseExprField('NOT a AND b');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('AND');
        expect(expr.left.kind).toBe('unary_op');
      }
    });

    it('parens override precedence', () => {
      const expr = parseExprField('(a + b) * c');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('*');
        expect(expr.left.kind).toBe('parenthesized');
      }
    });

    it('left-associativity for +', () => {
      const expr = parseExprField('a + b + c');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.op).toBe('+');
        expect(expr.left.kind).toBe('binary_op');
      }
    });
  });

  describe('function calls', () => {
    it('simple function', () => {
      const expr = parseExprField('upper(name)');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.name).toBe('upper');
        expect(expr.args).toHaveLength(1);
      }
    });

    it('lowercases function name', () => {
      const expr = parseExprField('UPPER(name)');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') expect(expr.name).toBe('upper');
    });

    it('multiple args', () => {
      const expr = parseExprField('round(price, 2)');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') expect(expr.args).toHaveLength(2);
    });

    it('zero-arg function', () => {
      const expr = parseExprField('current_date()');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.name).toBe('current_date');
        expect(expr.args).toHaveLength(0);
      }
    });

    it('count(*)', () => {
      const expr = parseExprField('count(*)');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.name).toBe('count');
        expect(expr.args).toHaveLength(1);
        expect(expr.args[0]!.kind).toBe('literal_star');
      }
    });

    it('count(DISTINCT x)', () => {
      const expr = parseExprField('count(DISTINCT id)');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.name).toBe('count');
        expect(expr.distinct).toBe(true);
        expect(expr.args).toHaveLength(1);
      }
    });

    it('nested functions', () => {
      const expr = parseExprField('upper(trim(name))');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.name).toBe('upper');
        expect(expr.args[0]!.kind).toBe('function_call');
      }
    });

    it('function with expression arg', () => {
      const expr = parseExprField('round(price * 1.1, 2)');
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.args).toHaveLength(2);
        expect(expr.args[0]!.kind).toBe('binary_op');
      }
    });
  });

  describe('CASE expressions', () => {
    it('searched CASE with ELSE', () => {
      const expr = parseExprField("CASE WHEN x > 0 THEN 'positive' ELSE 'non-positive' END");
      expect(expr.kind).toBe('case');
      if (expr.kind === 'case') {
        expect(expr.operand).toBeUndefined();
        expect(expr.whens).toHaveLength(1);
        expect(expr.elseExpr).toBeDefined();
      }
    });

    it('searched CASE without ELSE', () => {
      const expr = parseExprField("CASE WHEN x > 0 THEN 'positive' END");
      expect(expr.kind).toBe('case');
      if (expr.kind === 'case') {
        expect(expr.elseExpr).toBeUndefined();
      }
    });

    it('multiple WHEN branches', () => {
      const expr = parseExprField("CASE WHEN x > 0 THEN 'a' WHEN x = 0 THEN 'b' ELSE 'c' END");
      expect(expr.kind).toBe('case');
      if (expr.kind === 'case') {
        expect(expr.whens).toHaveLength(2);
      }
    });

    it('simple CASE with operand', () => {
      const expr = parseExprField("CASE status WHEN 'active' THEN 1 WHEN 'inactive' THEN 0 END");
      expect(expr.kind).toBe('case');
      if (expr.kind === 'case') {
        expect(expr.operand).toBeDefined();
        expect(expr.whens).toHaveLength(2);
      }
    });
  });

  describe('CAST expressions', () => {
    it('simple CAST', () => {
      const expr = parseExprField('CAST(x AS INTEGER)');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('INTEGER');
      }
    });

    it('CAST with type params', () => {
      const expr = parseExprField('CAST(x AS NUMERIC(10, 2))');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('NUMERIC');
        expect(expr.targetType.params).toEqual([10, 2]);
      }
    });

    it('CAST with multi-word type (TIMESTAMP WITH TIME ZONE)', () => {
      const expr = parseExprField('CAST(x AS TIMESTAMP WITH TIME ZONE)');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('TIMESTAMP WITH TIME ZONE');
      }
    });

    it('CAST with expression inside', () => {
      const expr = parseExprField('CAST(a + b AS VARCHAR)');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.expr.kind).toBe('binary_op');
      }
    });
  });

  describe(':: cast shorthand', () => {
    it('simple type', () => {
      const expr = parseExprField('x::INTEGER');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('INTEGER');
        expect(expr.shorthand).toBe(true);
      }
    });

    it('with type params', () => {
      const expr = parseExprField('x::VARCHAR(255)');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('VARCHAR');
        expect(expr.targetType.params).toEqual([255]);
        expect(expr.shorthand).toBe(true);
      }
    });

    it('multi-word type', () => {
      const expr = parseExprField('x::TIMESTAMP WITH TIME ZONE');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('TIMESTAMP WITH TIME ZONE');
        expect(expr.shorthand).toBe(true);
      }
    });

    it('DOUBLE PRECISION type', () => {
      const expr = parseExprField('x::DOUBLE PRECISION');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('DOUBLE PRECISION');
        expect(expr.shorthand).toBe(true);
      }
    });

    it('after expression', () => {
      const expr = parseExprField('a + b::VARCHAR');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.right.kind).toBe('cast');
        if (expr.right.kind === 'cast') {
          expect(expr.right.shorthand).toBe(true);
        }
      }
    });

    it('after function call', () => {
      const expr = parseExprField('COALESCE(x, y)::STRING');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.expr.kind).toBe('function_call');
        expect(expr.shorthand).toBe(true);
      }
    });

    it('after parenthesized expression', () => {
      const expr = parseExprField('(a + b)::INTEGER');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.expr.kind).toBe('parenthesized');
        expect(expr.shorthand).toBe(true);
      }
    });

    it('on numeric literal', () => {
      const expr = parseExprField('1::INTEGER');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.shorthand).toBe(true);
      }
    });

    it('supports chained shorthand casts', () => {
      const expr = parseExprField('x::INTEGER::TEXT');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.targetType.name).toBe('TEXT');
        expect(expr.expr.kind).toBe('cast');
        if (expr.expr.kind === 'cast') {
          expect(expr.expr.targetType.name).toBe('INTEGER');
        }
      }
    });

    it('wraps json path access in shorthand casts', () => {
      const expr = parseExprField('DATA:workspace:id::STRING');
      expect(expr.kind).toBe('cast');
      if (expr.kind === 'cast') {
        expect(expr.shorthand).toBe(true);
        expect(expr.expr.kind).toBe('json_path_access');
        if (expr.expr.kind === 'json_path_access') {
          expect(expr.expr.steps).toEqual([
            { kind: 'key', name: 'workspace' },
            { kind: 'key', name: 'id' },
          ]);
        }
      }
    });
  });

  describe('predicates', () => {
    it('IS NULL', () => {
      const expr = parseExprField('x IS NULL');
      expect(expr.kind).toBe('is_null');
      if (expr.kind === 'is_null') expect(expr.negated).toBeFalsy();
    });

    it('IS NOT NULL', () => {
      const expr = parseExprField('x IS NOT NULL');
      expect(expr.kind).toBe('is_null');
      if (expr.kind === 'is_null') expect(expr.negated).toBe(true);
    });

    it('BETWEEN', () => {
      const expr = parseExprField('x BETWEEN 1 AND 10');
      expect(expr.kind).toBe('between');
      if (expr.kind === 'between') expect(expr.negated).toBeFalsy();
    });

    it('NOT BETWEEN', () => {
      const expr = parseExprField('x NOT BETWEEN 1 AND 10');
      expect(expr.kind).toBe('between');
      if (expr.kind === 'between') expect(expr.negated).toBe(true);
    });

    it('IN', () => {
      const expr = parseExprField('x IN (1, 2, 3)');
      expect(expr.kind).toBe('in_list');
      if (expr.kind === 'in_list') {
        expect(expr.negated).toBeFalsy();
        expect(expr.list).toHaveLength(3);
      }
    });

    it('NOT IN', () => {
      const expr = parseExprField('x NOT IN (1, 2)');
      expect(expr.kind).toBe('in_list');
      if (expr.kind === 'in_list') {
        expect(expr.negated).toBe(true);
        expect(expr.list).toHaveLength(2);
      }
    });

    it('IN with expressions', () => {
      const expr = parseExprField('x IN (a + 1, b * 2)');
      expect(expr.kind).toBe('in_list');
      if (expr.kind === 'in_list') {
        expect(expr.list[0]!.kind).toBe('binary_op');
      }
    });
  });

  describe('raw_sql()', () => {
    it('simple content', () => {
      const expr = parseExprField('RAW_SQL(some weird stuff)');
      expect(expr.kind).toBe('raw_sql');
      if (expr.kind === 'raw_sql') {
        expect(expr.sql).toContain('some');
      }
    });

    it('nested parens', () => {
      const expr = parseExprField('RAW_SQL(fn(inner()))');
      expect(expr.kind).toBe('raw_sql');
      if (expr.kind === 'raw_sql') {
        expect(expr.sql).toContain('fn');
        expect(expr.sql).toContain('inner');
      }
    });

    it('string literals inside', () => {
      const expr = parseExprField("RAW_SQL(x = 'hello')");
      expect(expr.kind).toBe('raw_sql');
    });
  });

  describe('fallback to raw_sql', () => {
    it('invalid tokens fall back gracefully', () => {
      const expr = parseExprField('$var_name');
      expect(expr.kind).toBe('raw_sql');
      if (expr.kind === 'raw_sql') {
        expect(expr.sql).toBe('$var_name');
      }
    });
  });

  describe('tryParseExpr', () => {
    it('returns ok for valid expressions', () => {
      const result = tryParseExpr('a + b');
      expect(result.ok).toBe(true);
    });

    it('returns error for empty string', () => {
      const result = tryParseExpr('');
      expect(result.ok).toBe(false);
    });

    it('returns error for whitespace-only', () => {
      const result = tryParseExpr('   ');
      expect(result.ok).toBe(false);
    });

    it('returns error for invalid tokens', () => {
      const result = tryParseExpr('$invalid');
      expect(result.ok).toBe(false);
    });

    it('returns error for unexpected trailing tokens', () => {
      const result = tryParseExpr('a + b c');
      expect(result.ok).toBe(false);
    });

    it('adds flatten_json hint when expression starts with LATERAL', () => {
      const result = tryParseExpr('LATERAL FLATTEN(INPUT => COL)');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('flatten_json');
      }
    });

    it('UNNEST parses as function call (valid SQL syntax but not a flatten_json usage)', () => {
      const result = tryParseExpr('UNNEST(COL)');
      expect(result.ok).toBe(true);
    });

    it('EXPLODE parses as function call (valid SQL syntax but not a flatten_json usage)', () => {
      const result = tryParseExpr('EXPLODE(COL)');
      expect(result.ok).toBe(true);
    });

    it('adds flatten_json hint when expression starts with JSON_TABLE', () => {
      const result = tryParseExpr("JSON_TABLE(COL, '$[*]' COLUMNS(value JSON PATH '$'))");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('flatten_json');
      }
    });

    it('does not add flatten_json hint for other parse errors', () => {
      const result = tryParseExpr('a + b c');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain('flatten_json');
      }
    });
  });

  describe('edge cases', () => {
    it('unary minus on number', () => {
      const expr = parseExprField('-42');
      expect(expr.kind).toBe('unary_op');
    });

    it('double negation', () => {
      const expr = parseExprField('NOT NOT x');
      expect(expr.kind).toBe('unary_op');
      if (expr.kind === 'unary_op') {
        expect(expr.operand.kind).toBe('unary_op');
      }
    });

    it('deeply nested expressions', () => {
      const expr = parseExprField('((((a + b))))');
      expect(expr.kind).toBe('parenthesized');
    });

    it('CASE inside function', () => {
      const expr = parseExprField("count(CASE WHEN status = 'active' THEN 1 END)");
      expect(expr.kind).toBe('function_call');
      if (expr.kind === 'function_call') {
        expect(expr.args[0]!.kind).toBe('case');
      }
    });

    it('comparison with function calls', () => {
      const expr = parseExprField('length(name) > 10');
      expect(expr.kind).toBe('binary_op');
      if (expr.kind === 'binary_op') {
        expect(expr.left.kind).toBe('function_call');
      }
    });

    it('BETWEEN with expressions', () => {
      const expr = parseExprField('price BETWEEN min_price AND max_price * 1.1');
      expect(expr.kind).toBe('between');
    });

    it('large integers', () => {
      const expr = parseExprField('9999999999999');
      expect(expr.kind).toBe('literal_number');
    });

    it('identifiers with underscores', () => {
      const expr = parseExprField('my_table_name.my_column_name');
      expect(expr.kind).toBe('column_ref');
      if (expr.kind === 'column_ref') {
        expect(expr.table).toBe('my_table_name');
        expect(expr.column).toBe('my_column_name');
      }
    });
  });

  describe('recursion depth limit', () => {
    it('rejects deeply nested NOT prefixes (200 levels)', () => {
      const input = 'NOT '.repeat(200) + 'TRUE';
      const result = tryParseExpr(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/depth/i);
      }
    });

    it('allows moderately nested expressions', () => {
      // 10 levels of NOT should be fine
      const input = 'NOT '.repeat(10) + 'TRUE';
      const result = tryParseExpr(input);
      expect(result.ok).toBe(true);
    });
  });
});
