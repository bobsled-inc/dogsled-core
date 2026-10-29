import { describe, expect, it } from 'vitest';

import {
  quoteIdentifier,
  buildFullyQualifiedTable,
  buildWhereClause,
  buildExtractionQuery,
} from '../../src/runtime/warehouse-query-builder.js';

import type { Dialect, QueryBuilderConfig } from '../../src/runtime/warehouse-query-builder.js';

// ── quoteIdentifier ──

describe('quoteIdentifier', () => {
  it('double-quotes for snowflake', () => {
    expect(quoteIdentifier('snowflake', 'MY_TABLE')).toBe('"MY_TABLE"');
  });

  it('double-quotes for postgres', () => {
    expect(quoteIdentifier('postgres', 'my_table')).toBe('"my_table"');
  });

  it('double-quotes for redshift', () => {
    expect(quoteIdentifier('redshift', 'my_table')).toBe('"my_table"');
  });

  it('backticks for bigquery', () => {
    expect(quoteIdentifier('bigquery', 'my_table')).toBe('`my_table`');
  });

  it('backticks for mysql', () => {
    expect(quoteIdentifier('mysql', 'my_table')).toBe('`my_table`');
  });

  it('backticks for clickhouse', () => {
    expect(quoteIdentifier('clickhouse', 'my_table')).toBe('`my_table`');
  });

  it('escapes embedded double-quotes for snowflake', () => {
    expect(quoteIdentifier('snowflake', 'col"name')).toBe('"col""name"');
  });

  it('escapes embedded backticks for mysql', () => {
    expect(quoteIdentifier('mysql', 'col`name')).toBe('`col``name`');
  });

  it('double-quotes for iceberg', () => {
    expect(quoteIdentifier('iceberg', 'event_ts')).toBe('"event_ts"');
  });

  it('double-quotes for delta', () => {
    expect(quoteIdentifier('delta', 'event_ts')).toBe('"event_ts"');
  });
});

// ── buildFullyQualifiedTable ──

describe('buildFullyQualifiedTable', () => {
  it('builds snowflake FQN with database, schema, and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('snowflake', config)).toBe('"ANALYTICS"."PUBLIC"."ORDERS"');
  });

  it('builds snowflake FQN with only table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'snowflake',
      table: 'ORDERS',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('snowflake', config)).toBe('"ORDERS"');
  });

  it('builds bigquery FQN with project, dataset, and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'bigquery',
      table: 'orders',
      project: 'my-project',
      dataset: 'analytics',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('bigquery', config)).toBe('`my-project.analytics.orders`');
  });

  it('builds bigquery FQN with only dataset and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'bigquery',
      table: 'orders',
      dataset: 'analytics',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('bigquery', config)).toBe('`analytics.orders`');
  });

  it('builds postgres FQN with schema and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'postgres',
      table: 'orders',
      schema: 'public',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('postgres', config)).toBe('"public"."orders"');
  });

  it('builds redshift FQN with schema and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'redshift',
      table: 'events',
      schema: 'analytics',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('redshift', config)).toBe('"analytics"."events"');
  });

  it('builds mysql FQN with database and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'mysql',
      table: 'orders',
      database: 'analytics',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('mysql', config)).toBe('`analytics`.`orders`');
  });

  it('builds clickhouse FQN with database and table', () => {
    const config: QueryBuilderConfig = {
      dialect: 'clickhouse',
      table: 'events',
      database: 'analytics',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('clickhouse', config)).toBe('`analytics`.`events`');
  });

  it('treats a clickhouse resource schema as its database', () => {
    const config: QueryBuilderConfig = {
      dialect: 'clickhouse',
      table: 'events',
      schema: 'analytics',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('clickhouse', config)).toBe('`analytics`.`events`');
  });

  it('returns TVF for iceberg when tvf is provided', () => {
    const config: QueryBuilderConfig = {
      dialect: 'iceberg',
      tvf: "iceberg_scan('s3://bucket/metadata.json')",
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('iceberg', config)).toBe(
      "iceberg_scan('s3://bucket/metadata.json')"
    );
  });

  it('returns TVF for delta when tvf is provided', () => {
    const config: QueryBuilderConfig = {
      dialect: 'delta',
      tvf: "delta_scan('s3://bucket/table')",
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('delta', config)).toBe("delta_scan('s3://bucket/table')");
  });

  it('falls back to quoted table name for iceberg without tvf', () => {
    const config: QueryBuilderConfig = {
      dialect: 'iceberg',
      table: 'events',
      method: 'full_refresh',
    };
    expect(buildFullyQualifiedTable('iceberg', config)).toBe('"events"');
  });

  it('throws when table is missing', () => {
    const config: QueryBuilderConfig = {
      dialect: 'snowflake',
      method: 'full_refresh',
    };
    expect(() => buildFullyQualifiedTable('snowflake', config)).toThrow(
      'table is required when building a fully-qualified table name'
    );
  });
});

// ── buildWhereClause ──

describe('buildWhereClause', () => {
  it('builds snowflake parameterized WHERE with :N placeholders', () => {
    expect(buildWhereClause('snowflake', 'UPDATED_AT', 1)).toBe(
      'WHERE "UPDATED_AT" > :1 ORDER BY "UPDATED_AT"'
    );
  });

  it('builds bigquery parameterized WHERE with positional ? placeholder', () => {
    expect(buildWhereClause('bigquery', 'updated_at', 1)).toBe(
      'WHERE `updated_at` > ? ORDER BY `updated_at`'
    );
  });

  it('builds postgres parameterized WHERE with $N placeholders', () => {
    expect(buildWhereClause('postgres', 'updated_at', 1)).toBe(
      'WHERE "updated_at" > $1 ORDER BY "updated_at"'
    );
  });

  it('builds redshift parameterized WHERE with $N placeholders', () => {
    expect(buildWhereClause('redshift', 'created_at', 1)).toBe(
      'WHERE "created_at" > $1 ORDER BY "created_at"'
    );
  });

  it('builds mysql parameterized WHERE with ? placeholders', () => {
    expect(buildWhereClause('mysql', 'updated_at', 1)).toBe(
      'WHERE `updated_at` > ? ORDER BY `updated_at`'
    );
  });

  it('builds clickhouse named parameter placeholders', () => {
    expect(buildWhereClause('clickhouse', 'updated_at', 1)).toBe(
      'WHERE `updated_at` > {p1:String} ORDER BY `updated_at`'
    );
  });

  it('builds iceberg WHERE with double-quoted identifiers and $N placeholder', () => {
    expect(buildWhereClause('iceberg', 'event_ts', 1)).toBe(
      'WHERE "event_ts" > $1 ORDER BY "event_ts"'
    );
  });

  it('builds delta WHERE with double-quoted identifiers and $N placeholder', () => {
    expect(buildWhereClause('delta', 'event_ts', 1)).toBe(
      'WHERE "event_ts" > $1 ORDER BY "event_ts"'
    );
  });
});

// ── buildExtractionQuery — full_refresh ──

describe('buildExtractionQuery — full_refresh', () => {
  const dialects: Dialect[] = ['snowflake', 'bigquery', 'postgres', 'mysql'];

  it('generates SELECT * for snowflake full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'full_refresh',
    });
    expect(result.sql).toBe('SELECT * FROM "DB"."SCHEMA"."ORDERS"');
    expect(result.params).toEqual([]);
  });

  it('generates SELECT * for bigquery full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'orders',
      project: 'proj',
      dataset: 'ds',
      method: 'full_refresh',
    });
    expect(result.sql).toBe('SELECT * FROM `proj.ds.orders`');
    expect(result.params).toEqual([]);
  });

  it('generates SELECT * for postgres full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'postgres',
      table: 'orders',
      schema: 'public',
      method: 'full_refresh',
    });
    expect(result.sql).toBe('SELECT * FROM "public"."orders"');
    expect(result.params).toEqual([]);
  });

  it('generates SELECT * for redshift full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'redshift',
      table: 'events',
      schema: 'analytics',
      method: 'full_refresh',
    });
    expect(result.sql).toBe('SELECT * FROM "analytics"."events"');
    expect(result.params).toEqual([]);
  });

  it('generates SELECT * for mysql full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'mysql',
      table: 'orders',
      database: 'analytics',
      method: 'full_refresh',
    });
    expect(result.sql).toBe('SELECT * FROM `analytics`.`orders`');
    expect(result.params).toEqual([]);
  });

  it('uses custom SQL directly for full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      sql: 'SELECT id, name FROM "DB"."SCHEMA"."ORDERS" WHERE active = true',
      method: 'full_refresh',
    });
    expect(result.sql).toBe('SELECT id, name FROM "DB"."SCHEMA"."ORDERS" WHERE active = true');
    expect(result.params).toEqual([]);
  });

  for (const dialect of dialects) {
    it(`returns empty params for ${dialect} full refresh`, () => {
      const result = buildExtractionQuery({
        dialect,
        table: 'orders',
        method: 'full_refresh',
      });
      expect(result.params).toEqual([]);
    });
  }
});

// ── buildExtractionQuery — incremental ──

describe('buildExtractionQuery — incremental_append', () => {
  it('includes WHERE and ORDER BY with cursor value for snowflake', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'incremental_append',
      cursorField: 'UPDATED_AT',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM "DB"."SCHEMA"."ORDERS" WHERE "UPDATED_AT" > :1 ORDER BY "UPDATED_AT"'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('includes WHERE and ORDER BY with cursor value for postgres', () => {
    const result = buildExtractionQuery({
      dialect: 'postgres',
      table: 'orders',
      schema: 'public',
      method: 'incremental_append',
      cursorField: 'updated_at',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM "public"."orders" WHERE "updated_at" > $1 ORDER BY "updated_at"'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('includes WHERE and ORDER BY with cursor value for redshift', () => {
    const result = buildExtractionQuery({
      dialect: 'redshift',
      table: 'events',
      schema: 'analytics',
      method: 'incremental_append',
      cursorField: 'created_at',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM "analytics"."events" WHERE "created_at" > $1 ORDER BY "created_at"'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('includes WHERE and ORDER BY with cursor value for mysql', () => {
    const result = buildExtractionQuery({
      dialect: 'mysql',
      table: 'orders',
      database: 'analytics',
      method: 'incremental_append',
      cursorField: 'updated_at',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM `analytics`.`orders` WHERE `updated_at` > ? ORDER BY `updated_at`'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('includes WHERE and ORDER BY with cursor value for bigquery', () => {
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'orders',
      project: 'proj',
      dataset: 'ds',
      method: 'incremental_append',
      cursorField: 'updated_at',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM `proj.ds.orders` WHERE `updated_at` > ? ORDER BY `updated_at`'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('omits WHERE when no cursor value (first run)', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'incremental_append',
      cursorField: 'UPDATED_AT',
    });
    expect(result.sql).toBe('SELECT * FROM "DB"."SCHEMA"."ORDERS" ORDER BY "UPDATED_AT"');
    expect(result.params).toEqual([]);
  });

  it('falls back to full refresh when no cursor field', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'incremental_append',
    });
    expect(result.sql).toBe('SELECT * FROM "DB"."SCHEMA"."ORDERS"');
    expect(result.params).toEqual([]);
  });
});

describe('buildExtractionQuery — incremental_merge', () => {
  it('generates same SQL as incremental_append (merge is loader concern)', () => {
    const appendResult = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'incremental_append',
      cursorField: 'UPDATED_AT',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    const mergeResult = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'incremental_merge',
      cursorField: 'UPDATED_AT',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(mergeResult.sql).toBe(appendResult.sql);
    expect(mergeResult.params).toEqual(appendResult.params);
  });
});

// ── buildExtractionQuery — incremental with custom SQL ──

describe('buildExtractionQuery — incremental with custom SQL', () => {
  it('wraps custom SQL as subquery with WHERE clause', () => {
    const result = buildExtractionQuery({
      dialect: 'postgres',
      sql: 'SELECT * FROM orders JOIN customers ON orders.cid = customers.id',
      method: 'incremental_append',
      cursorField: 'updated_at',
      cursorValue: '2026-01-01',
    });
    expect(result.sql).toBe(
      'SELECT * FROM (SELECT * FROM orders JOIN customers ON orders.cid = customers.id) AS _src WHERE "updated_at" > $1 ORDER BY "updated_at"'
    );
    expect(result.params).toEqual(['2026-01-01']);
  });

  it('wraps custom SQL as subquery without WHERE on first run', () => {
    const result = buildExtractionQuery({
      dialect: 'postgres',
      sql: 'SELECT * FROM orders',
      method: 'incremental_append',
      cursorField: 'updated_at',
    });
    expect(result.sql).toBe('SELECT * FROM (SELECT * FROM orders) AS _src ORDER BY "updated_at"');
    expect(result.params).toEqual([]);
  });
});

// ── buildExtractionQuery — lakehouse incremental with custom SQL ──

describe('buildExtractionQuery — lakehouse incremental with custom SQL', () => {
  it('wraps iceberg custom SQL as subquery with inlined cursor value', () => {
    const result = buildExtractionQuery({
      dialect: 'iceberg',
      sql: "SELECT * FROM iceberg_scan('s3://bucket/events') WHERE region = 'us'",
      method: 'incremental_append',
      cursorField: 'event_ts',
      cursorValue: '2026-03-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      "SELECT * FROM (SELECT * FROM iceberg_scan('s3://bucket/events') WHERE region = 'us') AS _src " +
        'WHERE "event_ts" > \'2026-03-01T00:00:00Z\' ORDER BY "event_ts"'
    );
    expect(result.params).toEqual([]);
  });

  it('wraps delta custom SQL as subquery with inlined cursor value', () => {
    const result = buildExtractionQuery({
      dialect: 'delta',
      sql: "SELECT * FROM delta_scan('s3://bucket/table')",
      method: 'incremental_append',
      cursorField: 'updated_at',
      cursorValue: '2026-06-15T12:00:00Z',
    });
    expect(result.sql).toBe(
      "SELECT * FROM (SELECT * FROM delta_scan('s3://bucket/table')) AS _src " +
        'WHERE "updated_at" > \'2026-06-15T12:00:00Z\' ORDER BY "updated_at"'
    );
    expect(result.params).toEqual([]);
  });
});

// ── buildExtractionQuery — lakehouse cursor value escaping ──

describe('buildExtractionQuery — lakehouse single-quote escaping', () => {
  it('escapes single quotes in iceberg cursor values', () => {
    const result = buildExtractionQuery({
      dialect: 'iceberg',
      tvf: "iceberg_scan('s3://bucket/events')",
      method: 'incremental_append',
      cursorField: 'name',
      cursorValue: "O'Brien",
    });
    expect(result.sql).toBe(
      "SELECT * FROM iceberg_scan('s3://bucket/events') " +
        'WHERE "name" > \'O\'\'Brien\' ORDER BY "name"'
    );
    expect(result.params).toEqual([]);
  });

  it('escapes single quotes in delta cursor values', () => {
    const result = buildExtractionQuery({
      dialect: 'delta',
      tvf: "delta_scan('s3://bucket/table')",
      method: 'incremental_append',
      cursorField: 'category',
      cursorValue: "it's a test",
    });
    expect(result.sql).toBe(
      "SELECT * FROM delta_scan('s3://bucket/table') " +
        'WHERE "category" > \'it\'\'s a test\' ORDER BY "category"'
    );
    expect(result.params).toEqual([]);
  });
});

// ── buildExtractionQuery — change_tracking ──

describe('buildExtractionQuery — change_tracking (Snowflake)', () => {
  it('generates CHANGES clause with DEFAULT information', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'change_tracking',
      changeTracking: { information: 'default' },
      lastSyncTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT *, METADATA$ACTION, METADATA$ISUPDATE, METADATA$ROW_ID' +
        ' FROM "DB"."SCHEMA"."ORDERS"' +
        ' CHANGES(INFORMATION => DEFAULT)' +
        ' AT(TIMESTAMP => :1::TIMESTAMP_LTZ)'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('generates CHANGES clause with APPEND_ONLY information', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'change_tracking',
      changeTracking: { information: 'append_only' },
      lastSyncTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toContain('CHANGES(INFORMATION => APPEND_ONLY)');
  });

  it('defaults to DEFAULT information when not specified', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'change_tracking',
      lastSyncTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toContain('CHANGES(INFORMATION => DEFAULT)');
  });

  it('throws when lastSyncTimestamp is missing', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'snowflake',
        table: 'ORDERS',
        database: 'DB',
        schema: 'SCHEMA',
        method: 'change_tracking',
      })
    ).toThrow('lastSyncTimestamp is required for Snowflake change tracking');
  });
});

describe('buildExtractionQuery — change_tracking (BigQuery)', () => {
  it('generates APPENDS TVF', () => {
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'events',
      project: 'proj',
      dataset: 'ds',
      method: 'change_tracking',
      changeTracking: { type: 'appends' },
      lastSyncTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM APPENDS(TABLE `proj.ds.events`, CAST(? AS TIMESTAMP), CURRENT_TIMESTAMP())'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('generates CHANGES TVF', () => {
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'events',
      project: 'proj',
      dataset: 'ds',
      method: 'change_tracking',
      changeTracking: { type: 'changes' },
      lastSyncTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      'SELECT * FROM CHANGES(TABLE `proj.ds.events`, CAST(? AS TIMESTAMP), CURRENT_TIMESTAMP())'
    );
  });

  it('throws when changeTracking.type is missing', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'bigquery',
        table: 'events',
        project: 'proj',
        dataset: 'ds',
        method: 'change_tracking',
        lastSyncTimestamp: '2026-01-01T00:00:00Z',
      })
    ).toThrow('changeTracking.type (appends | changes) is required for BigQuery change tracking');
  });

  it('throws when lastSyncTimestamp is missing', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'bigquery',
        table: 'events',
        project: 'proj',
        dataset: 'ds',
        method: 'change_tracking',
        changeTracking: { type: 'appends' },
      })
    ).toThrow('lastSyncTimestamp is required for BigQuery change tracking');
  });
});

describe('buildExtractionQuery — change_tracking (PostgreSQL)', () => {
  it('generates pg_logical_slot_peek_binary_changes() with publication_names', () => {
    const result = buildExtractionQuery({
      dialect: 'postgres',
      method: 'change_tracking',
      changeTracking: {
        plugin: 'pgoutput',
        slot_name: 'track_customers_slot',
        publication_name: 'track_customers_pub',
      },
    });

    expect(result.sql).toBe(
      "SELECT lsn::text AS lsn, xid::text AS xid, data FROM pg_logical_slot_peek_binary_changes($1, NULL, NULL, 'proto_version', '1', 'publication_names', $2)"
    );
    expect(result.params).toEqual(['track_customers_slot', 'track_customers_pub']);
  });

  it('throws when slot_name is missing', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'postgres',
        method: 'change_tracking',
        changeTracking: {
          publication_name: 'track_customers_pub',
        },
      })
    ).toThrow(
      'changeTracking.slot_name and changeTracking.publication_name are required for PostgreSQL change tracking'
    );
  });

  it('throws when publication_name is missing', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'postgres',
        method: 'change_tracking',
        changeTracking: {
          slot_name: 'track_customers_slot',
        },
      })
    ).toThrow(
      'changeTracking.slot_name and changeTracking.publication_name are required for PostgreSQL change tracking'
    );
  });
});

// ── TVF-based lakehouse queries ──

describe('buildExtractionQuery — iceberg (TVF)', () => {
  it('generates SELECT * FROM iceberg_scan() for full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'iceberg',
      tvf: "iceberg_scan('s3://bucket/warehouse/analytics/events')",
      method: 'full_refresh',
    });
    expect(result.sql).toBe("SELECT * FROM iceberg_scan('s3://bucket/warehouse/analytics/events')");
    expect(result.params).toEqual([]);
  });

  it('generates incremental query with TVF and inlined cursor value', () => {
    const result = buildExtractionQuery({
      dialect: 'iceberg',
      tvf: "iceberg_scan('s3://bucket/warehouse/analytics/events')",
      method: 'incremental_append',
      cursorField: 'event_timestamp',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      "SELECT * FROM iceberg_scan('s3://bucket/warehouse/analytics/events') " +
        'WHERE "event_timestamp" > \'2026-01-01T00:00:00Z\' ORDER BY "event_timestamp"'
    );
    expect(result.params).toEqual([]);
  });

  it('throws for unsupported change_tracking on iceberg', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'iceberg',
        tvf: "iceberg_scan('s3://bucket/table')",
        method: 'change_tracking',
      })
    ).toThrow('change_tracking is not supported for iceberg');
  });
});

describe('buildExtractionQuery — delta (TVF)', () => {
  it('generates SELECT * FROM delta_scan() for full refresh', () => {
    const result = buildExtractionQuery({
      dialect: 'delta',
      tvf: "delta_scan('s3://bucket/delta-tables/analytics/events')",
      method: 'full_refresh',
    });
    expect(result.sql).toBe(
      "SELECT * FROM delta_scan('s3://bucket/delta-tables/analytics/events')"
    );
    expect(result.params).toEqual([]);
  });

  it('generates incremental query with TVF and inlined cursor value', () => {
    const result = buildExtractionQuery({
      dialect: 'delta',
      tvf: "delta_scan('s3://bucket/delta-tables/analytics/events')",
      method: 'incremental_append',
      cursorField: 'event_timestamp',
      cursorValue: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).toBe(
      "SELECT * FROM delta_scan('s3://bucket/delta-tables/analytics/events') " +
        'WHERE "event_timestamp" > \'2026-01-01T00:00:00Z\' ORDER BY "event_timestamp"'
    );
    expect(result.params).toEqual([]);
  });

  it('generates CDF change_tracking query from TVF', () => {
    const result = buildExtractionQuery({
      dialect: 'delta',
      tvf: "read_parquet('s3://bucket/table/_change_data/*.parquet') WHERE _commit_version > 42",
      method: 'change_tracking',
      changeTracking: { type: 'cdf' },
    });
    expect(result.sql).toBe(
      "SELECT * FROM read_parquet('s3://bucket/table/_change_data/*.parquet') WHERE _commit_version > 42"
    );
    expect(result.params).toEqual([]);
  });
});

describe('buildExtractionQuery — change_tracking (unsupported dialects)', () => {
  it('throws for mysql', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'mysql',
        table: 'orders',
        method: 'change_tracking',
      })
    ).toThrow('change_tracking is not supported for mysql');
  });

  it('throws for redshift', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'redshift',
        table: 'events',
        method: 'change_tracking',
      })
    ).toThrow('change_tracking is not supported for redshift');
  });

  it('throws for iceberg', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'iceberg',
        table: 'events',
        method: 'change_tracking',
      })
    ).toThrow('change_tracking is not supported for iceberg');
  });

  it('throws for clickhouse', () => {
    expect(() =>
      buildExtractionQuery({
        dialect: 'clickhouse',
        table: 'events',
        method: 'change_tracking',
      })
    ).toThrow('change_tracking is not supported for clickhouse');
  });
});

describe('backtick identifier hardening', () => {
  it.each(['bigquery', 'mysql', 'clickhouse'] as const)(
    'rejects backslashes and newlines for %s',
    (dialect) => {
      expect(() => quoteIdentifier(dialect, 'x\\` AS SELECT 1; DROP TABLE t; --')).toThrow(
        'backslashes and control characters are not allowed'
      );
      expect(() => quoteIdentifier(dialect, 'a\nb')).toThrow(
        'backslashes and control characters are not allowed'
      );
    }
  );

  it('leaves double-quote dialects unchanged', () => {
    expect(quoteIdentifier('snowflake', 'a\\b')).toBe('"a\\b"');
  });
});

describe('BigQuery backtick rejection', () => {
  it('rejects embedded backticks for BigQuery and keeps doubling for MySQL', () => {
    expect(() => quoteIdentifier('bigquery', 'a`b')).toThrow('backticks are not allowed');
    expect(quoteIdentifier('mysql', 'a`b')).toBe('`a``b`');
  });
});

// ── BigQuery positional parameter regression ──

describe('BigQuery incremental query — positional parameters', () => {
  it('uses ? placeholder (not @pN) so the SDK positional array mode matches the SQL', () => {
    // The bug: buildParamPlaceholder emitted @p1 (named) while bigquery-client
    // passed params as an array (positional). BigQuery rejected the mismatch with
    // "Named parameters are not supported". Verify the placeholder is now ? so
    // the SQL and the array params stay consistent.
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'events',
      project: 'my-project',
      dataset: 'analytics',
      method: 'incremental_append',
      cursorField: 'id',
      cursorValue: '999',
    });
    expect(result.sql).not.toMatch(/@p\d+/);
    expect(result.sql).toBe(
      'SELECT * FROM `my-project.analytics.events` WHERE `id` > ? ORDER BY `id`'
    );
    expect(result.params).toEqual(['999']);
  });

  it('regression P2-1: numeric-looking STRING cursor never gets CAST(? AS INT64)', () => {
    // Scenario: a BigQuery STRING column holds values like "00999". Run 1 saves
    // the bookmark with no declared cursor_type. Run 2 passes cursorKind: undefined
    // because buildQueryConfig only uses replication.cursor_type (not value-inferred
    // bookmark.cursor_type). Without this fix, resolveCursorKind would infer
    // 'integer' from "00999" and produce CAST(? AS INT64), failing with
    // "No matching signature for operator > for argument types: STRING, INT64".
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'events',
      project: 'my-project',
      dataset: 'analytics',
      method: 'incremental_append',
      cursorField: 'id',
      cursorValue: '00999',
      // cursorKind intentionally absent — no replication.cursor_type declared
    });
    expect(result.sql).not.toContain('CAST');
    expect(result.sql).toBe(
      'SELECT * FROM `my-project.analytics.events` WHERE `id` > ? ORDER BY `id`'
    );
    expect(result.params).toEqual(['00999']);
  });

  it('uses CAST(? AS TIMESTAMP) for BigQuery change_tracking (APPENDS)', () => {
    const result = buildExtractionQuery({
      dialect: 'bigquery',
      table: 'events',
      project: 'my-project',
      dataset: 'analytics',
      method: 'change_tracking',
      changeTracking: { type: 'appends' },
      lastSyncTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(result.sql).not.toMatch(/@p\d+/);
    expect(result.sql).toContain('CAST(? AS TIMESTAMP)');
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });
});

// ── BigQuery cursor kind type mapping ──

describe('BigQuery incremental query — cursor kind type casting', () => {
  const base = {
    dialect: 'bigquery' as const,
    table: 'orders',
    project: 'proj',
    dataset: 'ds',
    method: 'incremental_append' as const,
    cursorField: 'id',
    cursorValue: '8',
  };

  it('integer cursor emits CAST(? AS INT64) so an INT64 column comparison succeeds', () => {
    const result = buildExtractionQuery({ ...base, cursorKind: 'integer' });
    expect(result.sql).toBe(
      'SELECT * FROM `proj.ds.orders` WHERE `id` > CAST(? AS INT64) ORDER BY `id`'
    );
    // Value is preserved as a string — no precision loss for large INT64s.
    expect(result.params).toEqual(['8']);
  });

  it('timestamp cursor emits plain ? (STRING coerced by BigQuery to DATE/DATETIME/TIMESTAMP)', () => {
    // GoogleSQL coerces STRING query parameters to DATE, DATETIME, and TIMESTAMP
    // automatically. Emitting CAST(? AS TIMESTAMP) against a DATETIME column
    // would fail because DATETIME != TIMESTAMP in BigQuery.
    const result = buildExtractionQuery({
      ...base,
      cursorField: 'created_at',
      cursorValue: '2026-01-01T00:00:00Z',
      cursorKind: 'timestamp',
    });
    expect(result.sql).toBe(
      'SELECT * FROM `proj.ds.orders` WHERE `created_at` > ? ORDER BY `created_at`'
    );
    expect(result.params).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('timestamp cursorKind covers DATE and DATETIME columns (all map to timestamp kind)', () => {
    // BigQuery DATE and DATETIME columns are both mapped to the timestamp
    // CursorKind by mapColumnType. Plain ? is used for all of them so a
    // DATETIME column does not receive CAST(? AS TIMESTAMP) which BigQuery rejects.
    const result = buildExtractionQuery({
      ...base,
      cursorField: 'updated_date',
      cursorValue: '2026-01-01',
      cursorKind: 'timestamp',
    });
    expect(result.sql).toContain('> ?');
    expect(result.sql).not.toContain('CAST');
  });

  it('number cursor emits CAST(? AS FLOAT64)', () => {
    const result = buildExtractionQuery({ ...base, cursorValue: '3.14', cursorKind: 'number' });
    expect(result.sql).toContain('CAST(? AS FLOAT64)');
    expect(result.params).toEqual(['3.14']);
  });

  it('string cursor emits plain ? (STRING binding)', () => {
    const result = buildExtractionQuery({ ...base, cursorValue: 'zz', cursorKind: 'string' });
    expect(result.sql).toBe('SELECT * FROM `proj.ds.orders` WHERE `id` > ? ORDER BY `id`');
    expect(result.params).toEqual(['zz']);
  });

  it('absent cursorKind falls back to plain ? (current behaviour for unknown kinds)', () => {
    const result = buildExtractionQuery({ ...base });
    expect(result.sql).toBe('SELECT * FROM `proj.ds.orders` WHERE `id` > ? ORDER BY `id`');
    expect(result.params).toEqual(['8']);
  });

  it('Snowflake uses :N placeholder regardless of cursorKind (other dialects unchanged)', () => {
    const result = buildExtractionQuery({
      dialect: 'snowflake',
      table: 'ORDERS',
      database: 'DB',
      schema: 'SCHEMA',
      method: 'incremental_append',
      cursorField: 'ID',
      cursorValue: '8',
      cursorKind: 'integer',
    });
    expect(result.sql).toBe('SELECT * FROM "DB"."SCHEMA"."ORDERS" WHERE "ID" > :1 ORDER BY "ID"');
    expect(result.params).toEqual(['8']);
  });

  it('PostgreSQL uses $N placeholder regardless of cursorKind (other dialects unchanged)', () => {
    const result = buildExtractionQuery({
      dialect: 'postgres',
      table: 'orders',
      schema: 'public',
      method: 'incremental_append',
      cursorField: 'id',
      cursorValue: '8',
      cursorKind: 'integer',
    });
    expect(result.sql).toBe('SELECT * FROM "public"."orders" WHERE "id" > $1 ORDER BY "id"');
    expect(result.params).toEqual(['8']);
  });
});
