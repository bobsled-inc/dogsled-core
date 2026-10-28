import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import {
  SnowflakeOAuthSchema,
  IcebergRestCatalogConnectionSchema,
  IcebergOAuth2AuthSchema,
  SourceConfigSchema,
  PostgresConnectionSchema,
  RedshiftConnectionSchema,
  MysqlConnectionSchema,
} from '../../../src/framework/core/warehouse.js';

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('Warehouse schema security', () => {
  describe('HTTPS enforcement', () => {
    it('rejects HTTP Snowflake OAuth token_url', () => {
      const result = SnowflakeOAuthSchema.safeParse({
        type: 'oauth',
        client_id_env: 'SF_CLIENT_ID',
        client_secret_env: 'SF_CLIENT_SECRET',
        token_url: 'http://auth.example.com/token',
      });
      expect(result.success).toBe(false);
    });

    it('accepts HTTPS Snowflake OAuth token_url', () => {
      const result = SnowflakeOAuthSchema.safeParse({
        type: 'oauth',
        client_id_env: 'SF_CLIENT_ID',
        client_secret_env: 'SF_CLIENT_SECRET',
        token_url: 'https://auth.example.com/token',
      });
      expect(result.success).toBe(true);
    });

    it('rejects HTTP Iceberg catalog_url', () => {
      const result = IcebergRestCatalogConnectionSchema.safeParse({
        mode: 'rest_catalog',
        catalog_url: 'http://catalog.example.com',
      });
      expect(result.success).toBe(false);
    });

    it('accepts HTTPS Iceberg catalog_url', () => {
      const result = IcebergRestCatalogConnectionSchema.safeParse({
        mode: 'rest_catalog',
        catalog_url: 'https://catalog.example.com',
      });
      expect(result.success).toBe(true);
    });

    it('rejects HTTP Iceberg OAuth token_url', () => {
      const result = IcebergOAuth2AuthSchema.safeParse({
        type: 'oauth2',
        client_id_env: 'ICE_CLIENT_ID',
        client_secret_env: 'ICE_CLIENT_SECRET',
        token_url: 'http://auth.example.com/token',
      });
      expect(result.success).toBe(false);
    });

    it('accepts HTTPS Iceberg OAuth token_url', () => {
      const result = IcebergOAuth2AuthSchema.safeParse({
        type: 'oauth2',
        client_id_env: 'ICE_CLIENT_ID',
        client_secret_env: 'ICE_CLIENT_SECRET',
        token_url: 'https://auth.example.com/token',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('SQL length limit', () => {
    it('rejects SQL exceeding 100K characters', () => {
      const result = SourceConfigSchema.safeParse({
        sql: 'SELECT ' + 'x'.repeat(100_001),
      });
      expect(result.success).toBe(false);
    });

    it('accepts SQL within 100K characters', () => {
      const result = SourceConfigSchema.safeParse({
        sql: 'SELECT * FROM users',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Port range', () => {
    it('rejects PostgreSQL port > 65535', () => {
      const result = PostgresConnectionSchema.safeParse({
        host_env: 'PG_HOST',
        port: 70000,
        database: 'mydb',
      });
      expect(result.success).toBe(false);
    });

    it('rejects Redshift port > 65535', () => {
      const result = RedshiftConnectionSchema.safeParse({
        host_env: 'RS_HOST',
        port: 99999,
        database: 'mydb',
      });
      expect(result.success).toBe(false);
    });

    it('rejects MySQL port > 65535', () => {
      const result = MysqlConnectionSchema.safeParse({
        host_env: 'MYSQL_HOST',
        port: 65536,
        database: 'mydb',
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid ports', () => {
      expect(
        PostgresConnectionSchema.safeParse({
          host_env: 'PG_HOST',
          port: 5432,
          database: 'mydb',
        }).success
      ).toBe(true);

      expect(
        MysqlConnectionSchema.safeParse({
          host_env: 'MYSQL_HOST',
          port: 3306,
          database: 'mydb',
        }).success
      ).toBe(true);
    });
  });

  describe('MySQL statement_timeout_ms schema', () => {
    it('accepts valid timeout', () => {
      const result = MysqlConnectionSchema.safeParse({
        host_env: 'MYSQL_HOST',
        port: 3306,
        database: 'mydb',
        statement_timeout_ms: 30_000,
      });
      expect(result.success).toBe(true);
    });

    it('rejects timeout > 24h', () => {
      const result = MysqlConnectionSchema.safeParse({
        host_env: 'MYSQL_HOST',
        port: 3306,
        database: 'mydb',
        statement_timeout_ms: 86_400_001,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative timeout', () => {
      const result = MysqlConnectionSchema.safeParse({
        host_env: 'MYSQL_HOST',
        port: 3306,
        database: 'mydb',
        statement_timeout_ms: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Snowflake identifier validation
// ---------------------------------------------------------------------------

import { SnowflakeWarehouseClient } from '../../../src/runtime/snowflake-client.js';

describe('Snowflake identifier validation', () => {
  function createSnowflakeClient(overrides: Record<string, unknown> = {}) {
    return new SnowflakeWarehouseClient({
      accountIdentifier: 'test-account',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'PUBLIC',
      auth: { type: 'pat', token: 'test-token' },
      ...overrides,
    });
  }

  it('accepts valid identifiers', () => {
    expect(() => createSnowflakeClient()).not.toThrow();
    expect(() =>
      createSnowflakeClient({
        database: 'MY_DB',
        schema: 'MY_SCHEMA',
        warehouse: 'COMPUTE_WH',
        role: 'ANALYTICS_ROLE',
      })
    ).not.toThrow();
  });

  it('accepts identifiers with $ sign', () => {
    expect(() => createSnowflakeClient({ database: 'DB$PROD' })).not.toThrow();
  });

  it('rejects identifiers with hyphens', () => {
    expect(() => createSnowflakeClient({ database: 'ANALYTICS-PROD' })).toThrow(
      /disallowed characters/
    );
  });

  it('rejects identifiers with quotes', () => {
    expect(() => createSnowflakeClient({ database: 'DB"INJECT' })).toThrow(/disallowed characters/);
  });

  it('rejects identifiers with semicolons', () => {
    expect(() => createSnowflakeClient({ database: 'DB;DROP TABLE' })).toThrow(
      /disallowed characters/
    );
  });

  it('rejects identifiers with slashes', () => {
    expect(() => createSnowflakeClient({ schema: '../etc/passwd' })).toThrow(
      /disallowed characters/
    );
  });

  it('rejects identifiers with whitespace', () => {
    expect(() => createSnowflakeClient({ warehouse: 'WH NAME' })).toThrow(/disallowed characters/);
  });

  it('rejects identifiers starting with a digit', () => {
    expect(() => createSnowflakeClient({ database: '123DB' })).toThrow(/disallowed characters/);
  });
});

// ---------------------------------------------------------------------------
// DuckDB lakehouse params safety
// ---------------------------------------------------------------------------

import { IcebergWarehouseClient } from '../../../src/runtime/iceberg-client.js';
import { DeltaWarehouseClient } from '../../../src/runtime/delta-client.js';

describe('DuckDB lakehouse params safety', () => {
  it('Iceberg client throws on non-empty params', async () => {
    const client = new IcebergWarehouseClient({
      mode: 'direct',
      warehouse_path: 's3://bucket/warehouse',
      storage: { type: 'aws_iam', region: 'us-east-1' },
    });

    const gen = client.execute('SELECT 1', ['unexpected-param']);
    await expect(gen.next()).rejects.toThrow('do not support bind parameters');
  });

  it('Delta client throws on non-empty params', async () => {
    const client = new DeltaWarehouseClient({
      storage_url: 's3://bucket/delta',
      storage: { type: 'aws_iam', region: 'us-east-1' },
    });

    const gen = client.execute('SELECT 1', ['unexpected-param']);
    await expect(gen.next()).rejects.toThrow('do not support bind parameters');
  });

  it('Iceberg execute allows empty params', async () => {
    const client = new IcebergWarehouseClient({
      mode: 'direct',
      warehouse_path: 's3://bucket/warehouse',
      storage: { type: 'aws_iam', region: 'us-east-1' },
    });

    // Empty params must not trigger the params-safety error. The query is
    // allowed through to DuckDB; `SELECT 1` yields one batch with one row.
    const gen = client.execute('SELECT 1', []);
    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual([{ '1': 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Iceberg/Delta config parsing
// ---------------------------------------------------------------------------

describe('Iceberg config parsing', () => {
  it('rejects missing mode', () => {
    expect(() => new IcebergWarehouseClient({})).toThrow(/mode/);
  });

  it('rejects rest_catalog mode without catalog_url', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'rest_catalog',
          auth: { type: 'token', token: 'test' },
        })
    ).toThrow(/catalog_url/);
  });

  it('rejects direct mode without storage', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'direct',
          warehouse_path: 's3://bucket/wh',
        })
    ).toThrow(/storage/);
  });

  it('accepts valid rest_catalog config', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'rest_catalog',
          catalog_url: 'https://catalog.example.com',
          auth: { type: 'token', token: 'test' },
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).not.toThrow();
  });

  it('accepts valid direct config', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'direct',
          warehouse_path: 's3://bucket/wh',
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).not.toThrow();
  });
});

describe('Delta config parsing', () => {
  it('rejects missing storage_url', () => {
    expect(() => new DeltaWarehouseClient({})).toThrow(/storage_url/);
  });

  it('rejects missing storage', () => {
    expect(
      () =>
        new DeltaWarehouseClient({
          storage_url: 's3://bucket/delta',
        })
    ).toThrow(/storage/);
  });

  it('accepts valid config', () => {
    expect(
      () =>
        new DeltaWarehouseClient({
          storage_url: 's3://bucket/delta',
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).not.toThrow();
  });

  it('rejects file:// storage_url scheme', () => {
    expect(
      () =>
        new DeltaWarehouseClient({
          storage_url: 'file:///etc/passwd',
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).toThrow(/scheme/);
  });

  it('rejects bare path storage_url', () => {
    expect(
      () =>
        new DeltaWarehouseClient({
          storage_url: '/tmp/delta-table',
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).toThrow(/scheme/);
  });
});

describe('Iceberg warehouse_path scheme validation', () => {
  it('rejects file:// warehouse_path', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'direct',
          warehouse_path: 'file:///etc/passwd',
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).toThrow(/scheme/);
  });

  it('rejects bare path warehouse_path', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'direct',
          warehouse_path: '/tmp/iceberg-table',
          storage: { type: 'aws_iam', region: 'us-east-1' },
        })
    ).toThrow(/scheme/);
  });

  it('accepts gs:// warehouse_path', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'direct',
          warehouse_path: 'gs://bucket/warehouse',
          storage: { type: 'gcp_hmac', access_key_id: 'k', secret_access_key: 's' },
        })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Storage auth per-type field validation
// ---------------------------------------------------------------------------

describe('Storage auth per-type validation', () => {
  it('rejects aws_credentials without required fields', () => {
    expect(
      () =>
        new DeltaWarehouseClient({
          storage_url: 's3://bucket/delta',
          storage: { type: 'aws_credentials' },
        })
    ).toThrow(/access_key_id/);
  });

  it('rejects aws_iam without region', () => {
    expect(
      () =>
        new DeltaWarehouseClient({
          storage_url: 's3://bucket/delta',
          storage: { type: 'aws_iam' },
        })
    ).toThrow(/region/);
  });

  it('rejects gcp_service_account without key', () => {
    expect(
      () =>
        new IcebergWarehouseClient({
          mode: 'direct',
          warehouse_path: 's3://bucket/wh',
          storage: { type: 'gcp_service_account' },
        })
    ).toThrow(/service_account_key/);
  });
});

// ---------------------------------------------------------------------------
// DuckDB escapeSqlString
// ---------------------------------------------------------------------------

import { escapeSqlString } from '../../../src/runtime/duckdb-engine.js';

describe('escapeSqlString', () => {
  it('escapes single quotes', () => {
    expect(escapeSqlString("O'Reilly")).toBe("O''Reilly");
  });

  it('escapes backslashes', () => {
    expect(escapeSqlString('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes both backslashes and quotes together', () => {
    // Input: a\b'c → backslashes first: a\\b'c → then quotes: a\\b''c
    expect(escapeSqlString("a\\b'c")).toBe("a\\\\b''c");
  });
});

// ---------------------------------------------------------------------------
// DB host SSRF validation
// ---------------------------------------------------------------------------

describe('Warehouse connection SSRF', () => {
  let originalValue: string | undefined;

  beforeAll(() => {
    originalValue = process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    delete process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
  });

  afterAll(() => {
    if (originalValue !== undefined) {
      process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalValue;
    }
  });

  it('isPrivateHost blocks cloud metadata IP', async () => {
    const { isPrivateHost } = await import('../../../src/framework/core/shared.js');
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });

  it('isPrivateHost blocks 10.x private range', async () => {
    const { isPrivateHost } = await import('../../../src/framework/core/shared.js');
    expect(isPrivateHost('10.0.0.1')).toBe(true);
  });

  it('isPrivateHost allows public IPs', async () => {
    const { isPrivateHost } = await import('../../../src/framework/core/shared.js');
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });
});
