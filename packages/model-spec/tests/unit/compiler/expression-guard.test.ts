import { describe, expect, it } from 'vitest';

import { generateSelectSql } from '../../../src/compiler/codegen.js';
import { transpileOrEmit } from '../../../src/compiler/codegen-expressions.js';
import { emitExpr, parseExprField } from '../../../src/compiler/expr/index.js';
import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import { parseTransformSpecFromParsed } from '../../../src/compiler/parser.js';
import { isDangerousRawSql, TransformSpecSchema } from '../../../src/compiler/schemas.js';

function modelInput(expr: string) {
  return {
    spec_version: '0.2',
    type: 'model',
    name: 'record_labels',
    description: 'Labels for synthetic records.',
    grain: 'record',
    source: { ref: 'example.records' },
    columns: [{ name: 'label', expr, type: 'VARCHAR' }],
    materialization: { type: 'view' },
  };
}

function compile(expr: string, dialect: SupportedDialect = 'snowflake'): string {
  const spec = TransformSpecSchema.parse(modelInput(expr));
  const parsed = parseTransformSpecFromParsed(
    spec,
    new Map([['example.records', 'EXAMPLE_DB.RAW.RECORDS']])
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const sql = generateSelectSql(parsed.spec, dialect);
  expect(sql).not.toMatch(/\bRAW_SQL\s*\(/i);
  return sql;
}

describe.each(['expr', 'raw_sql'] as const)('%s expression boundary', (path) => {
  const wrap = (sql: string) => (path === 'raw_sql' ? `raw_sql(${sql})` : sql);

  it.each([
    [
      "case when t0.name is null then 'Name missing; review required' else null end",
      "'Name missing; review required'",
    ],
    ["listagg(t0.company_id, '; ')", "'; '"],
    ["'It''s missing; review required'", String.raw`'It\'s missing; review required'`],
    ["'UNION SELECT'", "'UNION SELECT'"],
    ["'DROP TABLE records; -- /* text */'", "'DROP TABLE records; -- /* text */'"],
  ])('compiles quoted text in %s', (sql, literal) => {
    expect(compile(wrap(sql))).toContain(literal);
  });

  it.each([
    't0.id;',
    't0.id; DROP TABLE records',
    'DROP TABLE records',
    '/* leading comment */ DELETE FROM records',
    '-- leading comment\nCOPY records FROM external_data',
    't0.id UNION SELECT id FROM other_records',
    't0.id UNION DISTINCT SELECT id FROM other_records',
    't0.id EXCEPT ALL SELECT id FROM other_records',
    't0.id INTERSECT SELECT id FROM other_records',
    't0.id UNION/* comment */ALL/* comment */SELECT id FROM other_records',
    't0.id UNION -- comment\nSELECT id FROM other_records',
    "'unfinished",
    "'unfinished''",
    '"unfinished',
    '`unfinished',
    '$$unfinished',
    '$label$unfinished',
    't0.id /* unfinished',
    '/* outer /* nested */ DROP TABLE records */ t0.id',
    '/*! UNION SELECT id FROM other_records */ t0.id',
  ])('rejects %s during schema validation', (sql) => {
    expect(TransformSpecSchema.safeParse(modelInput(wrap(sql))).success).toBe(false);
  });
});

describe('shared SQL lexical boundary', () => {
  it.each([
    'DROP TABLE records',
    'ALTER TABLE records ADD COLUMN extra VARCHAR',
    'CREATE TABLE records (id VARCHAR)',
    'TRUNCATE TABLE records',
    "INSERT INTO records VALUES ('id')",
    "UPDATE records SET id = 'changed'",
    'DELETE FROM records',
    "REPLACE INTO records VALUES ('id')",
    'MERGE INTO records USING other_records ON records.id = other_records.id',
    'GRANT SELECT ON records TO reader',
    'REVOKE SELECT ON records FROM reader',
    'EXEC procedure_name',
    'EXECUTE procedure_name',
    'CALL procedure_name()',
    'DECLARE id VARCHAR',
    'PRAGMA table_info(records)',
    'COPY records FROM external_data',
    'LOAD DATA INTO records',
    'UNLOAD records',
  ])('preserves command rejection in expr and raw_sql: %s', (sql) => {
    for (const expr of [sql, `raw_sql(${sql})`]) {
      expect(TransformSpecSchema.safeParse(modelInput(expr)).success).toBe(false);
      expect(() => transpileOrEmit(expr, 'snowflake', 'snowflake')).toThrow();
    }
  });

  it.each<[string, SupportedDialect]>([
    ["'It''s valid; UNION SELECT'", 'snowflake'],
    [String.raw`'It\'s valid; UNION SELECT'`, 'snowflake'],
    [String.raw`E'It\'s valid; UNION SELECT'`, 'postgres'],
    ["$$It's valid; UNION SELECT$$", 'snowflake'],
    ["$label$It's valid; UNION SELECT$label$", 'postgres'],
    ["'''It's valid; UNION SELECT'''", 'bigquery'],
    ['"""A "label"; UNION SELECT"""', 'bigquery'],
    [String.raw`r'''A \'label'; UNION SELECT'''`, 'bigquery'],
    ['"column; UNION SELECT"', 'snowflake'],
    ['`column; UNION SELECT`', 'bigquery'],
    ['t0.id /* ; DROP TABLE records */ + 1', 'snowflake'],
  ])('allows quoted or commented contents: %s (%s)', (sql, dialect) => {
    expect(TransformSpecSchema.safeParse(modelInput(sql)).success).toBe(true);
    expect(isDangerousRawSql(sql)).toBe(false);
    expect(isDangerousRawSql(sql, dialect)).toBe(false);
    expect(emitExpr({ kind: 'raw_sql', sql }, dialect)).toBe(sql);
  });

  it.each(['expr', 'raw_sql'])('compiles BigQuery native escapes through %s', (path) => {
    const sql = String.raw`'It\'s missing; review required'`;
    const compiled = compile(path === 'raw_sql' ? `raw_sql(${sql})` : sql, 'bigquery');
    expect(compiled).toContain('missing; review required');
    expect(compiled).toContain('It');
  });

  it.each<[string, SupportedDialect]>([
    ['$$label; UNION SELECT$$', 'mysql'],
    ['$label$label; UNION SELECT$label$', 'snowflake'],
    ['`label; UNION SELECT`', 'postgres'],
    [String.raw`'unfinished\'`, 'snowflake'],
    [String.raw`r'unfinished\'`, 'bigquery'],
  ])('rejects unsupported or malformed quoting at codegen: %s (%s)', (sql, dialect) => {
    expect(isDangerousRawSql(sql, dialect)).toBe(true);
    expect(() => transpileOrEmit(sql, dialect, dialect)).toThrow();
    expect(() => emitExpr({ kind: 'raw_sql', sql }, dialect)).toThrow();
  });

  it('preserves native SQL contents in an explicit raw_sql field', () => {
    const sql = "concat(`label`, r'''It's valid; UNION SELECT''') /* comment */";
    expect(parseExprField(`raw_sql(${sql})`)).toEqual({ kind: 'raw_sql', sql, explicit: true });
    expect(parseExprField('raw_sql(id) + coalesce(other_id, 0)').kind).toBe('binary_op');
  });

  it.each([
    '1 --x; 2',
    'id UNION -- comment\nSELECT id FROM other_records',
    'id UNION -- comment\nALL SELECT id FROM other_records',
  ])('keeps MySQL arithmetic dashes separate from comments: %s', (sql) => {
    for (const expr of [sql, `raw_sql(${sql})`]) {
      expect(TransformSpecSchema.safeParse(modelInput(expr)).success).toBe(false);
      expect(() => transpileOrEmit(expr, 'mysql', 'mysql')).toThrow();
    }
    expect(() => emitExpr({ kind: 'raw_sql', sql }, 'mysql')).toThrow();
  });

  it('allows a terminated MySQL line comment followed by an ordinary expression', () => {
    expect(isDangerousRawSql('id -- comment\n+ 1', 'mysql')).toBe(false);
  });

  it.each(['postgres', 'mysql', 'bigquery', 'snowflake'] as const)(
    'keeps aliases and source relations outside raw_sql line comments (%s)',
    (dialect) => {
      const sql = compile('raw_sql(1 -- label comment\n)', dialect);
      expect(sql.replace('/* label comment */', '')).toMatch(/SELECT 1 AS label\s+FROM/i);
      expect(sql.toUpperCase()).toContain('EXAMPLE_DB.RAW.RECORDS');
      expect(emitExpr({ kind: 'raw_sql', sql: '1 -- comment' }, dialect)).toBe('1 -- comment\n');
    }
  );

  it.each(['# comment', '#! comment', '// comment'])(
    'recognizes ClickHouse comments: %s',
    (comment) => {
      expect(isDangerousRawSql(`${comment}\nDROP TABLE records`, 'clickhouse')).toBe(true);
      expect(isDangerousRawSql(`id ${comment}\n+ 1`, 'clickhouse')).toBe(false);
    }
  );

  it.each([
    "'abc\\' ; SELECT 1 --'",
    "'safe'; 'more text'",
    '/* leading */ DROP TABLE records',
    'raw_sql(/* leading */ CALL procedure_name())',
    "coalesce(raw_sql(DROP TABLE records), 'label;')",
    "'label' UNION/* comment */SELECT 'other'",
    "'unfinished",
  ])('rejects direct codegen passthrough: %s', (sql) => {
    expect(isDangerousRawSql(sql)).toBe(true);
    expect(() => transpileOrEmit(sql, 'postgres', 'postgres')).toThrow();
    expect(() => emitExpr({ kind: 'raw_sql', sql }, 'postgres')).toThrow();
  });
});
