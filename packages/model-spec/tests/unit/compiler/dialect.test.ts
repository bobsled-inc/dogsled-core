import { Dialect } from '@polyglot-sql/sdk';
import { describe, expect, it } from 'vitest';

import {
  buildFqNameWithDatabase,
  createSchemaIfNotExistsStatement,
  caseName,
  escapeSqlString,
  formatTableRef,
  getCanonicalDialect,
  isReservedWord,
  resolveDialectProfile,
  quoteColumnAlias,
  quoteIdentifier,
  safeIdentifier,
  supportsDialectCapability,
  supportsFuzzyAlgorithm,
  toPolyglotDialect,
} from '../../../src/compiler/dialect.js';

describe('toPolyglotDialect', () => {
  it('maps snowflake to Dialect.Snowflake', () => {
    expect(toPolyglotDialect('snowflake')).toBe(Dialect.Snowflake);
  });

  it('maps bigquery to Dialect.BigQuery', () => {
    expect(toPolyglotDialect('bigquery')).toBe(Dialect.BigQuery);
  });

  it('maps postgres to Dialect.PostgreSQL', () => {
    expect(toPolyglotDialect('postgres')).toBe(Dialect.PostgreSQL);
  });

  it('maps databricks to Dialect.Databricks', () => {
    expect(toPolyglotDialect('databricks')).toBe(Dialect.Databricks);
  });

  it('maps mysql to Dialect.MySQL', () => {
    expect(toPolyglotDialect('mysql')).toBe(Dialect.MySQL);
  });

  it('maps duckdb to Dialect.DuckDB', () => {
    expect(toPolyglotDialect('duckdb')).toBe(Dialect.DuckDB);
  });

  it('maps pgvector to Dialect.PostgreSQL', () => {
    expect(toPolyglotDialect('pgvector')).toBe(Dialect.PostgreSQL);
  });

  it('maps redshift to Dialect.PostgreSQL', () => {
    expect(toPolyglotDialect('redshift')).toBe(Dialect.PostgreSQL);
  });
});

describe('resolveDialectProfile', () => {
  it('treats pgvector as a postgres profile', () => {
    const profile = resolveDialectProfile('pgvector');
    expect(profile.canonicalDialect).toBe('postgres');
    expect(profile.identifierStyle).toBe('double_quote_lower');
    expect(profile.fqnStyle).toBe('schema_table');
  });

  it('treats redshift as a postgres-family profile with conservative capability overrides', () => {
    const profile = resolveDialectProfile('redshift');
    expect(profile.canonicalDialect).toBe('postgres');
    expect(profile.capabilities.qualify).toBe(true);
    expect(profile.capabilities.flattenJson).toBe(false);
    expect(profile.capabilities.dynamicTable).toBe(false);
  });
});

describe('getCanonicalDialect', () => {
  it('returns postgres for pgvector and redshift', () => {
    expect(getCanonicalDialect('pgvector')).toBe('postgres');
    expect(getCanonicalDialect('redshift')).toBe('postgres');
  });
});

describe('supportsDialectCapability', () => {
  it('reports profile-level overrides', () => {
    expect(supportsDialectCapability('pgvector', 'flattenJson')).toBe(true);
    expect(supportsDialectCapability('redshift', 'flattenJson')).toBe(false);
    expect(supportsDialectCapability('redshift', 'qualify')).toBe(true);
  });
});

describe('supportsFuzzyAlgorithm', () => {
  it('reports conservative fuzzy function support by dialect', () => {
    expect(supportsFuzzyAlgorithm('postgres', 'metaphone')).toBe(true);
    expect(supportsFuzzyAlgorithm('pgvector', 'metaphone')).toBe(true);
    expect(supportsFuzzyAlgorithm('duckdb', 'metaphone')).toBe(false);
    expect(supportsFuzzyAlgorithm('mysql', 'jaro_winkler')).toBe(false);
    expect(supportsFuzzyAlgorithm('mysql', 'soundex')).toBe(true);
    expect(supportsFuzzyAlgorithm('mysql', 'token_cosine')).toBe(false);
    expect(supportsFuzzyAlgorithm('redshift', 'edit_distance')).toBe(false);
    expect(supportsFuzzyAlgorithm('redshift', 'token_cosine')).toBe(true);
  });
});

describe('quoteIdentifier', () => {
  it('snowflake: uppercases and double-quotes', () => {
    expect(quoteIdentifier('my_table', 'snowflake')).toBe('"MY_TABLE"');
  });

  it('snowflake: escapes embedded double-quotes', () => {
    expect(quoteIdentifier('my"table', 'snowflake')).toBe('"MY""TABLE"');
  });

  it('bigquery: lowercases and backtick-quotes', () => {
    expect(quoteIdentifier('MY_TABLE', 'bigquery')).toBe('`my_table`');
  });

  it('bigquery: rejects embedded backticks, which BigQuery cannot escape by doubling', () => {
    expect(() => quoteIdentifier('my`table', 'bigquery')).toThrow('cannot contain backticks');
  });

  it('postgres: lowercases and double-quotes', () => {
    expect(quoteIdentifier('MY_TABLE', 'postgres')).toBe('"my_table"');
  });

  it('pgvector: matches postgres quoting', () => {
    expect(quoteIdentifier('MY_TABLE', 'pgvector')).toBe('"my_table"');
  });

  it('redshift: matches postgres quoting', () => {
    expect(quoteIdentifier('MY_TABLE', 'redshift')).toBe('"my_table"');
  });

  it('postgres: escapes embedded double-quotes', () => {
    expect(quoteIdentifier('my"table', 'postgres')).toBe('"my""table"');
  });

  it('databricks: lowercases and backtick-quotes', () => {
    expect(quoteIdentifier('MY_TABLE', 'databricks')).toBe('`my_table`');
  });

  it('databricks: escapes embedded backticks', () => {
    expect(quoteIdentifier('my`table', 'databricks')).toBe('`my``table`');
  });

  it('duckdb: lowercases and double-quotes', () => {
    expect(quoteIdentifier('MY_TABLE', 'duckdb')).toBe('"my_table"');
  });

  it('duckdb: escapes embedded double-quotes', () => {
    expect(quoteIdentifier('my"table', 'duckdb')).toBe('"my""table"');
  });
});

describe('caseName', () => {
  it('snowflake: uppercases', () => {
    expect(caseName('stg_orders', 'snowflake')).toBe('STG_ORDERS');
  });

  it('bigquery: lowercases', () => {
    expect(caseName('STG_ORDERS', 'bigquery')).toBe('stg_orders');
  });

  it('postgres: lowercases', () => {
    expect(caseName('STG_ORDERS', 'postgres')).toBe('stg_orders');
  });

  it('pgvector: lowercases', () => {
    expect(caseName('STG_ORDERS', 'pgvector')).toBe('stg_orders');
  });

  it('redshift: lowercases', () => {
    expect(caseName('STG_ORDERS', 'redshift')).toBe('stg_orders');
  });

  it('databricks: lowercases', () => {
    expect(caseName('STG_ORDERS', 'databricks')).toBe('stg_orders');
  });

  it('duckdb: lowercases', () => {
    expect(caseName('STG_ORDERS', 'duckdb')).toBe('stg_orders');
  });
});

describe('formatTableRef', () => {
  it('snowflake: uppercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'o', 'snowflake')).toBe('RAW.RAW_ORDERS AS O');
  });

  it('bigquery: lowercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'bigquery')).toBe('raw.raw_orders AS o');
  });

  it('postgres: lowercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'postgres')).toBe('raw.raw_orders AS o');
  });

  it('pgvector: lowercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'pgvector')).toBe('raw.raw_orders AS o');
  });

  it('redshift: lowercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'redshift')).toBe('raw.raw_orders AS o');
  });

  it('databricks: lowercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'databricks')).toBe('raw.raw_orders AS o');
  });

  it('duckdb: lowercases table name and alias', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'duckdb')).toBe('raw.raw_orders AS o');
  });

  it('returns case-folded table name without alias when alias is undefined', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', undefined, 'snowflake')).toBe('RAW.RAW_ORDERS');
    expect(formatTableRef('RAW.RAW_ORDERS', undefined, 'bigquery')).toBe('raw.raw_orders');
  });
});

describe('buildFqNameWithDatabase', () => {
  it('snowflake: 3-part name with database', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'snowflake', 'my_db')).toBe(
      '"MY_DB"."MY_SCHEMA"."MY_TABLE"'
    );
  });

  it('bigquery: 3-part name with project', () => {
    expect(buildFqNameWithDatabase('my_dataset', 'my_table', 'bigquery', 'my_project')).toBe(
      '`my_project`.`my_dataset`.`my_table`'
    );
  });

  it('databricks: 3-part name with catalog', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'databricks', 'my_catalog')).toBe(
      '`my_catalog`.`my_schema`.`my_table`'
    );
  });

  it('postgres: ignores database (single-db architecture)', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'postgres', 'my_db')).toBe(
      '"my_schema"."my_table"'
    );
  });

  it('pgvector: ignores database like postgres', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'pgvector', 'my_db')).toBe(
      '"my_schema"."my_table"'
    );
  });

  it('redshift: ignores database in v1 profile mode', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'redshift', 'my_db')).toBe(
      '"my_schema"."my_table"'
    );
  });

  it('mysql: uses database.table (no schema level)', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'mysql', 'my_db')).toBe(
      '`my_db`.`my_table`'
    );
  });

  it('duckdb: 3-part name with database', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'duckdb', 'my_db')).toBe(
      '"my_db"."my_schema"."my_table"'
    );
  });

  it('falls back to 2-part name when database is undefined', () => {
    expect(buildFqNameWithDatabase('my_schema', 'my_table', 'snowflake')).toBe(
      '"MY_SCHEMA"."MY_TABLE"'
    );
  });
});

describe('createSchemaIfNotExistsStatement', () => {
  it('snowflake: qualifies with database when present', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'snowflake', 'my_db')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "MY_DB"."MY_SCHEMA"'
    );
  });

  it('snowflake: bare schema when database is undefined', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'snowflake')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "MY_SCHEMA"'
    );
  });

  it('bigquery: qualifies the dataset with the project', () => {
    expect(createSchemaIfNotExistsStatement('my_dataset', 'bigquery', 'my_project')).toBe(
      'CREATE SCHEMA IF NOT EXISTS `my_project`.`my_dataset`'
    );
  });

  it('bigquery: bare dataset when project is undefined', () => {
    expect(createSchemaIfNotExistsStatement('my_dataset', 'bigquery')).toBe(
      'CREATE SCHEMA IF NOT EXISTS `my_dataset`'
    );
  });

  it('databricks: qualifies the schema with the catalog', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'databricks', 'my_catalog')).toBe(
      'CREATE SCHEMA IF NOT EXISTS `my_catalog`.`my_schema`'
    );
  });

  it('duckdb: qualifies the schema with the catalog', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'duckdb', 'my_db')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "my_db"."my_schema"'
    );
  });

  it('postgres: ignores database (single-db architecture)', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'postgres', 'my_db')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "my_schema"'
    );
  });

  it('redshift: ignores database like postgres', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'redshift', 'my_db')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "my_schema"'
    );
  });

  it('mysql: creates database ?? schema (CREATE SCHEMA is a CREATE DATABASE synonym)', () => {
    expect(createSchemaIfNotExistsStatement('my_schema', 'mysql', 'my_db')).toBe(
      'CREATE SCHEMA IF NOT EXISTS `my_db`'
    );
    expect(createSchemaIfNotExistsStatement('my_schema', 'mysql')).toBe(
      'CREATE SCHEMA IF NOT EXISTS `my_schema`'
    );
  });
});

describe('escapeSqlString', () => {
  it('escapes single quotes for all dialects', () => {
    expect(escapeSqlString("it's")).toBe("it''s");
  });

  it('does not double-escape backslashes for ANSI-style dialects', () => {
    expect(escapeSqlString('back\\slash', 'postgres')).toBe('back\\slash');
    expect(escapeSqlString('back\\slash', 'pgvector')).toBe('back\\slash');
    expect(escapeSqlString('back\\slash', 'duckdb')).toBe('back\\slash');
  });

  it('double-escapes backslashes when dialect is omitted', () => {
    expect(escapeSqlString('back\\slash')).toBe('back\\\\slash');
  });

  it('double-escapes backslashes for MySQL and standard-sql backslash dialects', () => {
    expect(escapeSqlString('back\\slash', 'mysql')).toBe('back\\\\slash');
    expect(escapeSqlString('back\\slash', 'bigquery')).toBe('back\\\\slash');
    expect(escapeSqlString('back\\slash', 'databricks')).toBe('back\\\\slash');
    expect(escapeSqlString('back\\slash', 'snowflake')).toBe('back\\\\slash');
  });

  it('escapes Snowflake backslashes so paths and trailing slashes survive', () => {
    // Snowflake treats backslash as an escape character in single-quoted
    // literals (the classic `'C:\temp'` -> `C:<TAB>emp` corruption), so a
    // Windows path must be doubled and a value ending in `\` must not escape the
    // closing quote. Quotes stay '' (Snowflake accepts the doubled form).
    expect(escapeSqlString('C:\\temp', 'snowflake')).toBe('C:\\\\temp');
    expect(escapeSqlString('foo\\', 'snowflake')).toBe('foo\\\\');
    expect(escapeSqlString("a'b\\", 'snowflake')).toBe("a''b\\\\");
  });

  it('handles both single quotes and backslashes in MySQL', () => {
    expect(escapeSqlString("it's a back\\slash", 'mysql')).toBe("it''s a back\\\\slash");
  });

  it('escapes raw control characters for backslash dialects', () => {
    for (const dialect of ['bigquery', 'mysql', 'databricks', 'snowflake', undefined] as const) {
      expect(escapeSqlString('\n', dialect)).toBe('\\n');
      expect(escapeSqlString('\r', dialect)).toBe('\\r');
      expect(escapeSqlString('\t', dialect)).toBe('\\t');
      expect(escapeSqlString('\b', dialect)).toBe('\\b');
      expect(escapeSqlString('\f', dialect)).toBe('\\f');
    }
  });

  it('leaves raw control characters untouched for ANSI-style dialects', () => {
    for (const dialect of ['postgres', 'pgvector', 'duckdb'] as const) {
      expect(escapeSqlString('\n', dialect)).toBe('\n');
    }
  });

  it('escapes control characters alongside backslash doubling', () => {
    expect(escapeSqlString('hello\nworld', 'bigquery')).toBe('hello\\nworld');
  });

  it('backslash-escapes single quotes for BigQuery instead of doubling them', () => {
    // BigQuery rejects '' adjacency ("concatenated string literals must be
    // separated by whitespace or comments"); the apostrophe must be \'.
    expect(escapeSqlString("it's", 'bigquery')).toBe("it\\'s");
  });

  it('combines backslash, control-char, and quote escaping for BigQuery', () => {
    expect(escapeSqlString("a'b\nc", 'bigquery')).toBe("a\\'b\\nc");
  });

  it('keeps standard single-quote doubling for non-BigQuery dialects', () => {
    expect(escapeSqlString("it's", 'mysql')).toBe("it''s");
    expect(escapeSqlString("it's", 'snowflake')).toBe("it''s");
    expect(escapeSqlString("it's")).toBe("it''s");
  });
});

describe('isReservedWord', () => {
  it('detects TRIGGER as reserved in bigquery', () => {
    expect(isReservedWord('trigger', 'bigquery')).toBe(true);
    expect(isReservedWord('TRIGGER', 'bigquery')).toBe(true);
  });

  it('detects SELECT as reserved in all dialects', () => {
    expect(isReservedWord('select', 'snowflake')).toBe(true);
    expect(isReservedWord('select', 'bigquery')).toBe(true);
    expect(isReservedWord('select', 'postgres')).toBe(true);
  });

  it('returns false for non-reserved words', () => {
    expect(isReservedWord('my_column', 'bigquery')).toBe(false);
    expect(isReservedWord('status', 'bigquery')).toBe(false);
  });
});

describe('safeIdentifier', () => {
  it('quotes reserved words for bigquery', () => {
    expect(safeIdentifier('trigger', 'bigquery')).toBe('`trigger`');
  });

  it('quotes reserved words for snowflake', () => {
    expect(safeIdentifier('trigger', 'snowflake')).toBe('"TRIGGER"');
  });

  it('quotes reserved words for postgres', () => {
    expect(safeIdentifier('trigger', 'postgres')).toBe('"trigger"');
  });

  it('returns caseName for non-reserved words', () => {
    expect(safeIdentifier('my_col', 'bigquery')).toBe('my_col');
    expect(safeIdentifier('my_col', 'snowflake')).toBe('MY_COL');
  });
});

describe('quoteColumnAlias', () => {
  it('preserves camelCase for bigquery with backticks', () => {
    expect(quoteColumnAlias('logId', 'bigquery')).toBe('`logId`');
    expect(quoteColumnAlias('eventName', 'bigquery')).toBe('`eventName`');
    expect(quoteColumnAlias('authorEmail', 'bigquery')).toBe('`authorEmail`');
  });

  it('lowercases all-lowercase names for bigquery (no quotes needed)', () => {
    expect(quoteColumnAlias('transfer_id', 'bigquery')).toBe('transfer_id');
    expect(quoteColumnAlias('error_count', 'bigquery')).toBe('error_count');
  });

  it('preserves camelCase for postgres with double-quotes', () => {
    expect(quoteColumnAlias('logId', 'postgres')).toBe('"logId"');
  });

  it('preserves camelCase for snowflake with double-quotes', () => {
    expect(quoteColumnAlias('logId', 'snowflake')).toBe('"logId"');
  });

  it('uppercases all-uppercase/lowercase names for snowflake (no quotes needed)', () => {
    expect(quoteColumnAlias('TRANSFER_ID', 'snowflake')).toBe('TRANSFER_ID');
    expect(quoteColumnAlias('transfer_id', 'snowflake')).toBe('TRANSFER_ID');
  });

  it('preserves camelCase for databricks with backticks', () => {
    expect(quoteColumnAlias('logId', 'databricks')).toBe('`logId`');
  });

  it('quotes reserved words even when all-lowercase for bigquery', () => {
    expect(quoteColumnAlias('trigger', 'bigquery')).toBe('`trigger`');
  });

  it('quotes reserved words even when all-lowercase for snowflake', () => {
    expect(quoteColumnAlias('trigger', 'snowflake')).toBe('"TRIGGER"');
  });

  it('quotes reserved words even when all-lowercase for postgres', () => {
    expect(quoteColumnAlias('trigger', 'postgres')).toBe('"trigger"');
  });

  it('preserves camelCase for duckdb with double-quotes', () => {
    expect(quoteColumnAlias('logId', 'duckdb')).toBe('"logId"');
  });

  it('lowercases all-lowercase names for duckdb (no quotes needed)', () => {
    expect(quoteColumnAlias('transfer_id', 'duckdb')).toBe('transfer_id');
  });
});

describe('clickhouse dialect', () => {
  it('maps to the polyglot ClickHouse dialect', () => {
    expect(toPolyglotDialect('clickhouse')).toBe(Dialect.ClickHouse);
  });

  it('addresses tables as database.table, with no schema level', () => {
    expect(resolveDialectProfile('clickhouse').fqnStyle).toBe('database_table');
  });

  // ClickHouse is case-SENSITIVE. Folding an identifier the way MySQL and
  // BigQuery do would address a table or column that does not exist, so these
  // four assertions are the load-bearing ones for this dialect.
  it('preserves identifier case when quoting', () => {
    expect(quoteIdentifier('Orders', 'clickhouse')).toBe('`Orders`');
    expect(quoteIdentifier('ORDERS', 'clickhouse')).toBe('`ORDERS`');
  });

  it('escapes embedded backticks', () => {
    expect(quoteIdentifier('we`ird', 'clickhouse')).toBe('`we``ird`');
  });

  it('preserves case in caseName', () => {
    expect(caseName('OrderId', 'clickhouse')).toBe('OrderId');
  });

  it('preserves case in table references', () => {
    expect(formatTableRef('RAW.RAW_ORDERS', 'O', 'clickhouse')).toBe('RAW.RAW_ORDERS AS O');
  });

  it('quotes every column alias so case survives verbatim', () => {
    expect(quoteColumnAlias('authorEmail', 'clickhouse')).toBe('`authorEmail`');
    expect(quoteColumnAlias('lower', 'clickhouse')).toBe('`lower`');
  });

  it('treats ClickHouse-specific clause words as reserved', () => {
    expect(isReservedWord('PREWHERE', 'clickhouse')).toBe(true);
    expect(isReservedWord('FINAL', 'clickhouse')).toBe(true);
    expect(isReservedWord('SETTINGS', 'clickhouse')).toBe(true);
    expect(isReservedWord('order_id', 'clickhouse')).toBe(false);
  });

  it('quotes reserved words in safeIdentifier', () => {
    expect(safeIdentifier('SAMPLE', 'clickhouse')).toBe('`SAMPLE`');
    expect(safeIdentifier('OrderId', 'clickhouse')).toBe('OrderId');
  });

  it('declares the capabilities ClickHouse actually has', () => {
    expect(supportsDialectCapability('clickhouse', 'qualify')).toBe(true);
    expect(supportsDialectCapability('clickhouse', 'selectStarExcept')).toBe(true);
    expect(supportsDialectCapability('clickhouse', 'namedWindowClause')).toBe(true);
  });

  it('declares the capabilities ClickHouse lacks, so models fail loudly', () => {
    // No MERGE statement, so incremental merge and the snapshot strategy that
    // builds on it cannot be expressed.
    expect(supportsDialectCapability('clickhouse', 'incrementalMerge')).toBe(false);
    expect(supportsDialectCapability('clickhouse', 'snapshot')).toBe(false);
    // A ClickHouse MATERIALIZED VIEW is an insert trigger, not a refreshable
    // snapshot, so it must not stand in for one.
    expect(supportsDialectCapability('clickhouse', 'materializedView')).toBe(false);
    expect(supportsDialectCapability('clickhouse', 'dynamicTable')).toBe(false);
    expect(supportsDialectCapability('clickhouse', 'flattenJson')).toBe(false);
  });

  it('declares only the fuzzy algorithms ClickHouse ships natively', () => {
    expect(supportsFuzzyAlgorithm('clickhouse', 'edit_distance')).toBe(true);
    expect(supportsFuzzyAlgorithm('clickhouse', 'soundex')).toBe(true);
    expect(supportsFuzzyAlgorithm('clickhouse', 'jaro_winkler')).toBe(false);
    expect(supportsFuzzyAlgorithm('clickhouse', 'metaphone')).toBe(false);
    expect(supportsFuzzyAlgorithm('clickhouse', 'token_cosine')).toBe(false);
  });
});

describe('escapeSqlString for clickhouse', () => {
  // ClickHouse consumes backslash escapes inside single-quoted literals, so it
  // belongs with MySQL/BigQuery/Databricks/Snowflake rather than the ANSI group.
  it('escapes backslashes so a trailing one cannot terminate the literal', () => {
    expect(escapeSqlString('C:\\path\\', 'clickhouse')).toBe('C:\\\\path\\\\');
  });

  it('escapes control characters to their backslash sequences', () => {
    expect(escapeSqlString('a\nb\tc', 'clickhouse')).toBe('a\\nb\\tc');
  });

  it('doubles apostrophes', () => {
    expect(escapeSqlString("it's", 'clickhouse')).toBe("it''s");
  });

  it('keeps a regex word boundary intact rather than emitting a backspace', () => {
    // '\b' must survive as the two characters RE2 reads as a word boundary.
    expect(escapeSqlString('\\bword\\b', 'clickhouse')).toBe('\\\\bword\\\\b');
  });
});
