import { describe, expect, it } from 'vitest';

import { mapColumnType } from '../../src/runtime/warehouse-type-mapper.js';

describe('mapColumnType — clickhouse', () => {
  const map = (type: string) => mapColumnType('clickhouse', type);

  it.each(['Int8', 'UInt64', 'Nullable(Int64)', 'LowCardinality(UInt8)'])(
    'maps %s to integer',
    (type) => expect(map(type)).toBe('integer')
  );
  it.each(['Float32', 'Float64', 'Decimal(18, 4)'])('maps %s to number', (type) =>
    expect(map(type)).toBe('number')
  );
  it('maps Decimal(38, 0) to integer', () => expect(map('Decimal(38, 0)')).toBe('integer'));
  it('maps Bool to boolean', () => expect(map('Bool')).toBe('boolean'));
  it.each(['DateTime', 'DateTime64(3)', "Nullable(DateTime64(3, 'UTC'))"])(
    'maps %s to timestamp',
    (type) => expect(map(type)).toBe('timestamp')
  );
  it.each(['Date', 'Date32'])('maps %s to string', (type) => expect(map(type)).toBe('string'));
  it.each(['String', 'FixedString(16)', 'UUID', "Enum8('a' = 1)"])('maps %s to string', (type) =>
    expect(map(type)).toBe('string')
  );
  it('maps Array(Float32) to array', () => expect(map('Array(Float32)')).toBe('array'));
  it.each(['Map(String, String)', 'Tuple(UInt8, String)', 'JSON'])('maps %s to object', (type) =>
    expect(map(type)).toBe('object')
  );
  it('maps unknown types to string', () => expect(map('SomethingNew')).toBe('string'));
});

// ── Snowflake ──

describe('mapColumnType — snowflake', () => {
  const map = (t: string) => mapColumnType('snowflake', t);

  describe('integer types', () => {
    it.each(['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'BYTEINT'])(
      'maps %s to integer',
      (t) => {
        expect(map(t)).toBe('integer');
      }
    );

    it('maps NUMBER without parens to integer (default 38,0)', () => {
      expect(map('NUMBER')).toBe('integer');
    });

    it('maps NUMBER(38,0) to integer', () => {
      expect(map('NUMBER(38,0)')).toBe('integer');
    });

    it('maps DECIMAL(10,0) to integer', () => {
      expect(map('DECIMAL(10,0)')).toBe('integer');
    });

    it('maps NUMERIC(18,0) to integer', () => {
      expect(map('NUMERIC(18,0)')).toBe('integer');
    });
  });

  describe('number types', () => {
    it.each(['FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE', 'REAL'])('maps %s to number', (t) => {
      expect(map(t)).toBe('number');
    });

    it('maps NUMBER(10,2) to number (non-zero scale)', () => {
      expect(map('NUMBER(10,2)')).toBe('number');
    });

    it('maps DECIMAL(18,4) to number', () => {
      expect(map('DECIMAL(18,4)')).toBe('number');
    });
  });

  describe('string types', () => {
    it.each(['VARCHAR', 'CHAR', 'STRING', 'TEXT'])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });

    it('maps VARCHAR(255) to string', () => {
      expect(map('VARCHAR(255)')).toBe('string');
    });
  });

  it('maps BOOLEAN to boolean', () => {
    expect(map('BOOLEAN')).toBe('boolean');
  });

  it('maps DATE to string', () => {
    expect(map('DATE')).toBe('string');
  });

  describe('timestamp types', () => {
    it.each(['TIMESTAMP', 'TIMESTAMP_LTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ', 'DATETIME'])(
      'maps %s to timestamp',
      (t) => {
        expect(map(t)).toBe('timestamp');
      }
    );
  });

  it('maps VARIANT to object', () => {
    expect(map('VARIANT')).toBe('object');
  });

  it('maps OBJECT to object', () => {
    expect(map('OBJECT')).toBe('object');
  });

  it('maps ARRAY to array', () => {
    expect(map('ARRAY')).toBe('array');
  });

  it('maps BINARY to string', () => {
    expect(map('BINARY')).toBe('string');
  });

  it('maps unknown types to string', () => {
    expect(map('GEOGRAPHY')).toBe('string');
  });
});

// ── BigQuery ──

describe('mapColumnType — bigquery', () => {
  const map = (t: string) => mapColumnType('bigquery', t);

  describe('integer types', () => {
    it.each(['INT64', 'INT', 'INTEGER', 'SMALLINT', 'BIGINT', 'TINYINT', 'BYTEINT'])(
      'maps %s to integer',
      (t) => {
        expect(map(t)).toBe('integer');
      }
    );
  });

  describe('number types', () => {
    it.each(['FLOAT64', 'FLOAT', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL', 'BIGDECIMAL'])(
      'maps %s to number',
      (t) => {
        expect(map(t)).toBe('number');
      }
    );
  });

  it('maps STRING to string', () => {
    expect(map('STRING')).toBe('string');
  });

  it('maps BOOL to boolean', () => {
    expect(map('BOOL')).toBe('boolean');
  });

  it('maps BOOLEAN to boolean', () => {
    expect(map('BOOLEAN')).toBe('boolean');
  });

  it('maps DATE to string', () => {
    expect(map('DATE')).toBe('string');
  });

  describe('timestamp types', () => {
    it.each(['TIMESTAMP', 'DATETIME', 'TIME'])('maps %s to timestamp', (t) => {
      expect(map(t)).toBe('timestamp');
    });
  });

  it('maps RECORD to object', () => {
    expect(map('RECORD')).toBe('object');
  });

  it('maps JSON to object', () => {
    expect(map('JSON')).toBe('object');
  });

  it('maps BYTES to string', () => {
    expect(map('BYTES')).toBe('string');
  });

  it('maps ARRAY<INT64> to array', () => {
    expect(map('ARRAY<INT64>')).toBe('array');
  });

  it('maps STRUCT<...> to object', () => {
    expect(map('STRUCT<name STRING, age INT64>')).toBe('object');
  });

  it('maps GEOGRAPHY to string', () => {
    expect(map('GEOGRAPHY')).toBe('string');
  });

  it('maps INTERVAL to string', () => {
    expect(map('INTERVAL')).toBe('string');
  });

  it('maps RANGE to string', () => {
    expect(map('RANGE')).toBe('string');
  });

  it('maps unknown types to string', () => {
    expect(map('SOMETHINGNEW')).toBe('string');
  });
});

// ── PostgreSQL ──

describe('mapColumnType — postgres', () => {
  const map = (t: string) => mapColumnType('postgres', t);

  describe('integer types', () => {
    it.each([
      'int2',
      'int4',
      'int8',
      'smallint',
      'integer',
      'int',
      'bigint',
      'serial',
      'serial2',
      'serial4',
      'serial8',
      'bigserial',
      'smallserial',
      'oid',
    ])('maps %s to integer', (t) => {
      expect(map(t)).toBe('integer');
    });
  });

  describe('number types', () => {
    it.each(['float4', 'float8', 'real', 'double precision', 'numeric', 'decimal', 'money'])(
      'maps %s to number',
      (t) => {
        expect(map(t)).toBe('number');
      }
    );
  });

  describe('string types', () => {
    it.each([
      'text',
      'varchar',
      'char',
      'character',
      'character varying',
      'bpchar',
      'uuid',
      'citext',
      'name',
      'inet',
      'cidr',
      'macaddr',
      'macaddr8',
      'interval',
      'bit',
      'bit varying',
      'varbit',
      'bytea',
    ])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });

    it('maps varchar(255) to string', () => {
      expect(map('varchar(255)')).toBe('string');
    });
  });

  it('maps bool to boolean', () => {
    expect(map('bool')).toBe('boolean');
  });

  it('maps boolean to boolean', () => {
    expect(map('boolean')).toBe('boolean');
  });

  it('maps date to string', () => {
    expect(map('date')).toBe('string');
  });

  describe('timestamp types', () => {
    it.each([
      'timestamp',
      'timestamptz',
      'timestamp without time zone',
      'timestamp with time zone',
    ])('maps %s to timestamp', (t) => {
      expect(map(t)).toBe('timestamp');
    });
  });

  describe('time types map to string', () => {
    it.each(['time', 'timetz', 'time without time zone', 'time with time zone'])(
      'maps %s to string',
      (t) => {
        expect(map(t)).toBe('string');
      }
    );
  });

  describe('json types', () => {
    it('maps json to object', () => {
      expect(map('json')).toBe('object');
    });

    it('maps jsonb to object', () => {
      expect(map('jsonb')).toBe('object');
    });
  });

  describe('array types', () => {
    it('maps text[] to array', () => {
      expect(map('text[]')).toBe('array');
    });

    it('maps varchar(255)[] to array', () => {
      expect(map('varchar(255)[]')).toBe('array');
    });

    it('maps _int4 (pg_catalog) to array', () => {
      expect(map('_int4')).toBe('array');
    });

    it('maps _text (pg_catalog) to array', () => {
      expect(map('_text')).toBe('array');
    });
  });

  it('maps unknown types to string', () => {
    expect(map('tsvector')).toBe('string');
  });
});

// ── MySQL ──

describe('mapColumnType — mysql', () => {
  const map = (t: string) => mapColumnType('mysql', t);

  describe('integer types', () => {
    it.each(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT'])(
      'maps %s to integer',
      (t) => {
        expect(map(t)).toBe('integer');
      }
    );

    it('maps TINYINT(4) to integer (not boolean)', () => {
      expect(map('TINYINT(4)')).toBe('integer');
    });
  });

  describe('boolean special case', () => {
    it('maps TINYINT(1) to boolean', () => {
      expect(map('TINYINT(1)')).toBe('boolean');
    });

    it('maps BOOLEAN to boolean', () => {
      expect(map('BOOLEAN')).toBe('boolean');
    });

    it('maps BOOL to boolean', () => {
      expect(map('BOOL')).toBe('boolean');
    });
  });

  describe('number types', () => {
    it.each(['FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC'])('maps %s to number', (t) => {
      expect(map(t)).toBe('number');
    });
  });

  describe('string types', () => {
    it.each(['VARCHAR', 'CHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'ENUM', 'SET'])(
      'maps %s to string',
      (t) => {
        expect(map(t)).toBe('string');
      }
    );

    it('maps VARCHAR(255) to string', () => {
      expect(map('VARCHAR(255)')).toBe('string');
    });
  });

  it('maps DATE to string', () => {
    expect(map('DATE')).toBe('string');
  });

  describe('timestamp types', () => {
    it.each(['TIMESTAMP', 'DATETIME'])('maps %s to timestamp', (t) => {
      expect(map(t)).toBe('timestamp');
    });
  });

  describe('time-like types map to string', () => {
    it('maps TIME to string', () => {
      expect(map('TIME')).toBe('string');
    });

    it('maps YEAR to string', () => {
      expect(map('YEAR')).toBe('string');
    });
  });

  it('maps JSON to object', () => {
    expect(map('JSON')).toBe('object');
  });

  describe('binary types', () => {
    it.each(['BINARY', 'VARBINARY', 'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB'])(
      'maps %s to string',
      (t) => {
        expect(map(t)).toBe('string');
      }
    );
  });

  it('maps unknown types to string', () => {
    expect(map('GEOMETRY')).toBe('string');
  });
});

// ── Redshift ──

describe('mapColumnType — redshift', () => {
  const map = (t: string) => mapColumnType('redshift', t);

  describe('integer types', () => {
    it.each(['INT2', 'SMALLINT', 'INT', 'INT4', 'INTEGER', 'INT8', 'BIGINT'])(
      'maps %s to integer',
      (t) => {
        expect(map(t)).toBe('integer');
      }
    );

    it('maps DECIMAL(10,0) to integer (zero scale)', () => {
      expect(map('DECIMAL(10,0)')).toBe('integer');
    });

    it('maps NUMERIC(18,0) to integer (zero scale)', () => {
      expect(map('NUMERIC(18,0)')).toBe('integer');
    });
  });

  describe('number types', () => {
    it.each(['FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE PRECISION', 'REAL'])('maps %s to number', (t) => {
      expect(map(t)).toBe('number');
    });

    it('maps DECIMAL(10,2) to number (non-zero scale)', () => {
      expect(map('DECIMAL(10,2)')).toBe('number');
    });

    it('maps NUMERIC without parens to number', () => {
      expect(map('NUMERIC')).toBe('number');
    });

    it('maps DECIMAL without parens to number', () => {
      expect(map('DECIMAL')).toBe('number');
    });
  });

  describe('string types', () => {
    it.each([
      'VARCHAR',
      'CHAR',
      'CHARACTER',
      'CHARACTER VARYING',
      'NVARCHAR',
      'NCHAR',
      'TEXT',
      'BPCHAR',
    ])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });

    it('maps VARCHAR(256) to string', () => {
      expect(map('VARCHAR(256)')).toBe('string');
    });
  });

  describe('boolean types', () => {
    it('maps BOOLEAN to boolean', () => {
      expect(map('BOOLEAN')).toBe('boolean');
    });

    it('maps BOOL to boolean', () => {
      expect(map('BOOL')).toBe('boolean');
    });
  });

  describe('timestamp types', () => {
    it.each([
      'TIMESTAMP',
      'TIMESTAMPTZ',
      'TIMESTAMP WITH TIME ZONE',
      'TIMESTAMP WITHOUT TIME ZONE',
    ])('maps %s to timestamp', (t) => {
      expect(map(t)).toBe('timestamp');
    });
  });

  describe('date/time types map to string', () => {
    it.each(['DATE', 'TIME', 'TIMETZ'])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });
  });

  it('maps SUPER to object', () => {
    expect(map('SUPER')).toBe('object');
  });

  describe('special types map to string', () => {
    it.each(['GEOMETRY', 'GEOGRAPHY', 'HLLSKETCH', 'VARBYTE'])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });
  });

  it('maps unknown types to string', () => {
    expect(map('SOMETHINGUNKNOWN')).toBe('string');
  });
});

// ── DuckDB (Iceberg / Delta) ──

describe('mapColumnType — iceberg (duckdb)', () => {
  const map = (t: string) => mapColumnType('iceberg', t);

  describe('integer types', () => {
    it.each([
      'TINYINT',
      'SMALLINT',
      'INTEGER',
      'INT',
      'BIGINT',
      'HUGEINT',
      'UTINYINT',
      'USMALLINT',
      'UINTEGER',
      'UBIGINT',
    ])('maps %s to integer', (t) => {
      expect(map(t)).toBe('integer');
    });

    it('maps DECIMAL(10,0) to integer (zero scale)', () => {
      expect(map('DECIMAL(10,0)')).toBe('integer');
    });
  });

  describe('number types', () => {
    it.each(['FLOAT', 'DOUBLE', 'REAL'])('maps %s to number', (t) => {
      expect(map(t)).toBe('number');
    });

    it('maps DECIMAL(10,2) to number (non-zero scale)', () => {
      expect(map('DECIMAL(10,2)')).toBe('number');
    });
  });

  describe('string types', () => {
    it.each(['VARCHAR', 'TEXT', 'CHAR', 'UUID', 'BLOB', 'ENUM'])('maps %s to string', (t) => {
      expect(map(t)).toBe('string');
    });

    it('maps DATE to string', () => {
      expect(map('DATE')).toBe('string');
    });

    it('maps TIME to string', () => {
      expect(map('TIME')).toBe('string');
    });

    it('maps INTERVAL to string', () => {
      expect(map('INTERVAL')).toBe('string');
    });
  });

  describe('boolean types', () => {
    it('maps BOOLEAN to boolean', () => {
      expect(map('BOOLEAN')).toBe('boolean');
    });

    it('maps BOOL to boolean', () => {
      expect(map('BOOL')).toBe('boolean');
    });
  });

  describe('timestamp types', () => {
    it.each([
      'TIMESTAMP',
      'TIMESTAMPTZ',
      'TIMESTAMP_S',
      'TIMESTAMP_MS',
      'TIMESTAMP_NS',
      'TIMESTAMP WITH TIME ZONE',
    ])('maps %s to timestamp', (t) => {
      expect(map(t)).toBe('timestamp');
    });
  });

  describe('complex types', () => {
    it('maps JSON to object', () => {
      expect(map('JSON')).toBe('object');
    });

    it('maps STRUCT to object', () => {
      expect(map('STRUCT(name VARCHAR, age INTEGER)')).toBe('object');
    });

    it('maps MAP to object', () => {
      expect(map('MAP(VARCHAR, INTEGER)')).toBe('object');
    });

    it('maps LIST to array', () => {
      expect(map('LIST')).toBe('array');
    });

    it('maps INTEGER[] to array', () => {
      expect(map('INTEGER[]')).toBe('array');
    });
  });

  it('maps unknown types to string', () => {
    expect(map('SOMETHING_UNKNOWN')).toBe('string');
  });
});

describe('mapColumnType — delta (duckdb)', () => {
  const map = (t: string) => mapColumnType('delta', t);

  it('maps BIGINT to integer', () => {
    expect(map('BIGINT')).toBe('integer');
  });

  it('maps DOUBLE to number', () => {
    expect(map('DOUBLE')).toBe('number');
  });

  it('maps VARCHAR to string', () => {
    expect(map('VARCHAR')).toBe('string');
  });

  it('maps BOOLEAN to boolean', () => {
    expect(map('BOOLEAN')).toBe('boolean');
  });

  it('maps TIMESTAMP to timestamp', () => {
    expect(map('TIMESTAMP')).toBe('timestamp');
  });
});

// ── Case insensitivity ──

describe('mapColumnType — case insensitivity', () => {
  it('handles lowercase snowflake types', () => {
    expect(mapColumnType('snowflake', 'varchar')).toBe('string');
  });

  it('handles mixed-case bigquery types', () => {
    expect(mapColumnType('bigquery', 'String')).toBe('string');
  });

  it('handles uppercase postgres types', () => {
    expect(mapColumnType('postgres', 'TEXT')).toBe('string');
  });

  it('handles lowercase mysql types', () => {
    expect(mapColumnType('mysql', 'json')).toBe('object');
  });

  it('trims whitespace', () => {
    expect(mapColumnType('snowflake', '  VARCHAR  ')).toBe('string');
  });
});
