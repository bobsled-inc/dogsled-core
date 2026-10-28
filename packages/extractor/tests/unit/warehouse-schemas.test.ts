import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { IntegrationSpecSchema, ResourceSpecSchema } from '../../src/framework/extractor/index.js';

// ── Helpers ──

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function loadYaml(relativePath: string): unknown {
  const content = readFileSync(resolve(fixturesDir, relativePath), 'utf-8');
  return parseYaml(content);
}

// ── Integration spec validation ──

describe('IntegrationSpecSchema — warehouse integrations', () => {
  it('validates snowflake integration spec', () => {
    const spec = loadYaml('integrations/snowflake.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates bigquery integration spec', () => {
    const spec = loadYaml('integrations/bigquery.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('accepts bigquery spec with access_token auth (static token only)', () => {
    const spec = {
      auth_env_vars: ['BQ_TOKEN'],
      spec_version: '1',
      type: 'integration',
      name: 'managed_bigquery',
      source_type: 'bigquery',
      connection: { project_ids: ['proj-1'], billing_project_id: 'proj-1' },
      auth: { type: 'access_token', access_token: '${{ env.BQ_TOKEN }}' },
    };
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('accepts bigquery spec with access_token auth + token_command (refreshable)', () => {
    const spec = {
      auth_env_vars: ['BQ_TOKEN', 'BQ_TOKEN_COMMAND'],
      spec_version: '1',
      type: 'integration',
      name: 'managed_bigquery',
      source_type: 'bigquery',
      connection: { project_ids: ['proj-1'], billing_project_id: 'proj-1' },
      auth: {
        type: 'access_token',
        access_token: '${{ env.BQ_TOKEN }}',
        token_command: '${{ env.BQ_TOKEN_COMMAND }}',
      },
    };
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('rejects a raw BigQuery token_command from source YAML', () => {
    const spec = {
      auth_env_vars: ['BQ_TOKEN'],
      spec_version: '1',
      type: 'integration',
      name: 'unsafe_managed_bigquery',
      source_type: 'bigquery',
      connection: { project_ids: ['proj-1'], billing_project_id: 'proj-1' },
      auth: {
        type: 'access_token',
        access_token: '${{ env.BQ_TOKEN }}',
        token_command: 'node ./mint-token.js',
      },
    };
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => /raw shell commands/i.test(issue.message))).toBe(
        true
      );
    }
  });

  it('rejects bigquery access_token auth missing the access_token field', () => {
    const spec = {
      spec_version: '1',
      type: 'integration',
      name: 'bad_managed_bigquery',
      source_type: 'bigquery',
      connection: { project_ids: ['proj-1'], billing_project_id: 'proj-1' },
      auth: { type: 'access_token' },
    };
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it('validates postgres integration spec', () => {
    const spec = loadYaml('integrations/postgres.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates mysql integration spec', () => {
    const spec = loadYaml('integrations/mysql.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates clickhouse integration spec', () => {
    const spec = loadYaml('integrations/clickhouse.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates redshift integration spec', () => {
    const spec = loadYaml('integrations/redshift.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates iceberg REST catalog integration spec', () => {
    const spec = loadYaml('integrations/iceberg_rest.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates iceberg direct integration spec', () => {
    const spec = loadYaml('integrations/iceberg_direct.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates delta integration spec', () => {
    const spec = loadYaml('integrations/delta.yml');
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates API integration spec without source_type (backward compat)', () => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'github_api',
      transport: {
        base_url: 'https://api.github.com',
        auth: { type: 'none' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates API integration spec with explicit source_type: api', () => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'github_api',
      source_type: 'api',
      transport: {
        base_url: 'https://api.github.com',
        auth: { type: 'none' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid source_type', () => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'bad_source',
      source_type: 'oracle',
      connection: { host: 'localhost' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects snowflake spec missing required connection fields', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['SF_ACCOUNT', 'SF_TOKEN'],
      spec_version: '1',
      type: 'integration',
      name: 'bad_snowflake',
      source_type: 'snowflake',
      connection: {
        account_identifier_env: 'SF_ACCOUNT',
        // missing warehouse_env, database, schema, role
      },
      auth: { type: 'pat', token_env: 'SF_TOKEN' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects bigquery spec with empty project_ids', () => {
    const result = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      type: 'integration',
      name: 'bad_bigquery',
      source_type: 'bigquery',
      connection: {
        project_ids: [],
        billing_project_id: 'billing',
      },
      auth: { type: 'adc' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects postgres spec with invalid port', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['PG_HOST', 'PG_PASS', 'PG_USER'],
      spec_version: '1',
      type: 'integration',
      name: 'bad_postgres',
      source_type: 'postgres',
      connection: {
        host_env: 'PG_HOST',
        port: -1,
        database: 'test_db',
      },
      auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASS' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects mysql spec missing auth', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['MYSQL_HOST'],
      spec_version: '1',
      type: 'integration',
      name: 'bad_mysql',
      source_type: 'mysql',
      connection: {
        host_env: 'MYSQL_HOST',
        port: 3306,
        database: 'test_db',
      },
      // no auth block
    });
    expect(result.success).toBe(false);
  });

  it('rejects clickhouse spec missing auth', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['CLICKHOUSE_HOST'],
      spec_version: '1',
      type: 'integration',
      name: 'bad_clickhouse',
      source_type: 'clickhouse',
      connection: {
        host_env: 'CLICKHOUSE_HOST',
        database: 'analytics',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects snowflake spec with unknown auth type', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['SF_ACCOUNT', 'SF_WH'],
      spec_version: '1',
      type: 'integration',
      name: 'bad_auth',
      source_type: 'snowflake',
      connection: {
        account_identifier_env: 'SF_ACCOUNT',
        warehouse_env: 'SF_WH',
        database: 'DB',
        schema: 'SCH',
        role: 'ROLE',
      },
      auth: { type: 'kerberos', principal: 'user@REALM' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields on strict snowflake connection', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['SF_ACCOUNT', 'SF_TOKEN', 'SF_WH'],
      spec_version: '1',
      type: 'integration',
      name: 'strict_test',
      source_type: 'snowflake',
      connection: {
        account_identifier_env: 'SF_ACCOUNT',
        warehouse_env: 'SF_WH',
        database: 'DB',
        schema: 'SCH',
        role: 'ROLE',
        extra_field: 'should_fail',
      },
      auth: { type: 'pat', token_env: 'SF_TOKEN' },
    });
    expect(result.success).toBe(false);
  });
});

// ── Resource spec validation ──

describe('ResourceSpecSchema — warehouse resources', () => {
  it('validates snowflake orders (incremental_merge)', () => {
    const spec = loadYaml('resources/snowflake/orders.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates snowflake orders_cdc (change_tracking)', () => {
    const spec = loadYaml('resources/snowflake/orders_cdc.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates bigquery events (incremental_append)', () => {
    const spec = loadYaml('resources/bigquery/events.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates bigquery events_cdc (change_tracking appends)', () => {
    const spec = loadYaml('resources/bigquery/events_cdc.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates bigquery orders_cdc (change_tracking changes)', () => {
    const spec = loadYaml('resources/bigquery/orders_cdc.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates postgres customers (incremental_merge)', () => {
    const spec = loadYaml('resources/postgres/customers.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates postgres active_subscriptions (custom SQL)', () => {
    const spec = loadYaml('resources/postgres/active_subscriptions.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates postgres customers_cdc (change_tracking pgoutput)', () => {
    const spec = loadYaml('resources/postgres/customers_cdc.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates mysql products (full_refresh)', () => {
    const spec = loadYaml('resources/mysql/products.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates mysql order_events (incremental_append)', () => {
    const spec = loadYaml('resources/mysql/order_events.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates redshift events (incremental_append)', () => {
    const spec = loadYaml('resources/redshift/events.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates iceberg events (incremental_append)', () => {
    const spec = loadYaml('resources/iceberg/events.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates delta events (incremental_append)', () => {
    const spec = loadYaml('resources/delta/events.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('validates delta orders_cdc (change_tracking cdf)', () => {
    const spec = loadYaml('resources/delta/orders_cdc.yml');
    const result = ResourceSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });
});

// ── Resource spec validation — invalid cases ──

describe('ResourceSpecSchema — invalid warehouse resources', () => {
  it('rejects a legacy warehouse resource with an empty output map', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'empty_legacy',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'full_refresh' },
      output: {},
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(
      result.error.issues.some(
        (issue) =>
          issue.message ===
          'Resource "empty_legacy" declares no columns; add at least one field under "output"'
      )
    ).toBe(true);
  });

  it('rejects resource with neither table nor sql in source', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_source',
      integration: 'test_snowflake',
      source: {},
      replication: { method: 'full_refresh' },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects incremental_append without cursor_field', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'no_cursor',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'incremental_append' },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects incremental_merge without cursor_field', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'no_cursor_merge',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'incremental_merge' },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects cursor_field that does not reference an output field', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_cursor_ref',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: {
        method: 'incremental_append',
        cursor_field: 'nonexistent_field',
        cursor_type: 'timestamp',
      },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects primary_key that does not reference an output field', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_pk_ref',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: {
        method: 'full_refresh',
        primary_key: ['nonexistent_key'],
      },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects change_tracking config on non-change_tracking method', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_ct_method',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: {
        method: 'full_refresh',
        change_tracking: { information: 'default' },
      },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid replication method', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_method',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'stream_cdc' },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid output field type', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_field_type',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'full_refresh' },
      output: { id: { type: 'bigint' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects postgres change_tracking resources that use source.sql', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'customers_cdc_sql',
      integration: 'test_postgres',
      source: { sql: 'SELECT * FROM customers' },
      replication: {
        method: 'change_tracking',
        primary_key: ['id'],
        change_tracking: {
          slot_name: 'track_customers_slot',
          publication_name: 'track_customers_pub',
        },
      },
      output: {
        id: { type: 'integer' },
        _change_type: { type: 'string' },
      },
      extract: { table: { load_strategy: 'append' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects postgres change_tracking resources without replication.primary_key', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'customers_cdc_no_pk',
      integration: 'test_postgres',
      source: { table: 'customers', schema: 'public' },
      replication: {
        method: 'change_tracking',
        change_tracking: {
          slot_name: 'track_customers_slot',
          publication_name: 'track_customers_pub',
        },
      },
      output: {
        id: { type: 'integer' },
        _change_type: { type: 'string' },
      },
      extract: { table: { load_strategy: 'append' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects postgres change_tracking resources without _change_type output', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'customers_cdc_no_change_type',
      integration: 'test_postgres',
      source: { table: 'customers', schema: 'public' },
      replication: {
        method: 'change_tracking',
        primary_key: ['id'],
        change_tracking: {
          slot_name: 'track_customers_slot',
          publication_name: 'track_customers_pub',
        },
      },
      output: {
        id: { type: 'integer' },
      },
      extract: { table: { load_strategy: 'append' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects postgres change_tracking resources without append load_strategy', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'customers_cdc_merge',
      integration: 'test_postgres',
      source: { table: 'customers', schema: 'public' },
      replication: {
        method: 'change_tracking',
        primary_key: ['id'],
        change_tracking: {
          slot_name: 'track_customers_slot',
          publication_name: 'track_customers_pub',
        },
      },
      output: {
        id: { type: 'integer' },
        _change_type: { type: 'string' },
      },
      extract: { table: { load_strategy: 'merge' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields on strict source config', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'strict_source',
      integration: 'test_snowflake',
      source: { table: 'ORDERS', extra_field: 'bad' },
      replication: { method: 'full_refresh' },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });
});

// ── Replication config validation ──

describe('ReplicationConfigSchema validation', () => {
  it('accepts full_refresh with no cursor or pk', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'simple_refresh',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'full_refresh' },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts change_tracking with snowflake change_tracking config', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'sf_cdc',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: {
        method: 'change_tracking',
        change_tracking: { information: 'default' },
        primary_key: ['id'],
      },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts change_tracking with bigquery change_tracking config', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bq_cdc',
      integration: 'test_bigquery',
      source: { table: 'events', dataset: 'analytics' },
      replication: {
        method: 'change_tracking',
        change_tracking: { type: 'appends' },
      },
      output: { event_id: { type: 'integer' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts change_tracking with delta CDF config', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'delta_cdf',
      integration: 'test_delta',
      source: { table: 'orders' },
      replication: {
        method: 'change_tracking',
        change_tracking: { type: 'cdf' },
        primary_key: ['id'],
      },
      output: { id: { type: 'integer' }, _change_type: { type: 'string' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects incremental_merge without primary_key', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'merge_no_pk',
      integration: 'test_postgres',
      source: { table: 'customers' },
      replication: {
        method: 'incremental_merge',
        cursor_field: 'updated_at',
        cursor_type: 'timestamp',
      },
      output: {
        id: { type: 'integer' },
        updated_at: { type: 'timestamp' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects change_tracking method without change_tracking config', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'ct_no_config',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: {
        method: 'change_tracking',
      },
      output: { id: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects extract.table.primary_key referencing nonexistent output field', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'bad_table_pk',
      integration: 'test_snowflake',
      source: { table: 'ORDERS' },
      replication: { method: 'full_refresh' },
      output: { id: { type: 'integer' } },
      extract: { table: { primary_key: ['nonexistent_col'] } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts incremental_merge with cursor and primary key', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      type: 'resource',
      name: 'merge_resource',
      integration: 'test_postgres',
      source: { table: 'customers' },
      replication: {
        method: 'incremental_merge',
        cursor_field: 'updated_at',
        cursor_type: 'timestamp',
        primary_key: ['id'],
      },
      output: {
        id: { type: 'integer' },
        updated_at: { type: 'timestamp' },
      },
    });
    expect(result.success).toBe(true);
  });
});
