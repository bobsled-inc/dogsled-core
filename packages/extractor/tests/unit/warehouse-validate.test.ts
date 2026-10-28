import { describe, expect, it } from 'vitest';

import {
  validateWarehouseResourceForIntegration,
  type IntegrationSpec,
  type WarehouseResourceSpec,
} from '../../src/framework/extractor/index.js';
import { validatePostgresCdcSlotUniqueness } from '../../src/commands/validate.js';

function postgresIntegration(): IntegrationSpec {
  return {
    auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
    spec_version: '1',
    type: 'integration',
    name: 'test_postgres',
    source_type: 'postgres',
    connection: {
      host_env: 'PG_HOST',
      port: 5432,
      database: 'analytics',
      schema: 'public',
    },
    auth: {
      type: 'password',
      username_env: 'PG_USER',
      password_env: 'PG_PASSWORD',
    },
  };
}

function snowflakeIntegration(): IntegrationSpec {
  return {
    auth_env_vars: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_TOKEN', 'SNOWFLAKE_WAREHOUSE'],
    spec_version: '1',
    type: 'integration',
    name: 'test_snowflake',
    source_type: 'snowflake',
    connection: {
      account_identifier_env: 'SNOWFLAKE_ACCOUNT',
      warehouse_env: 'SNOWFLAKE_WAREHOUSE',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
      role: 'ANALYST',
    },
    auth: {
      type: 'pat',
      token_env: 'SNOWFLAKE_TOKEN',
    },
  };
}

function postgresCdcResource(
  name = 'customers_cdc',
  slotName = 'track_customers_slot'
): WarehouseResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name,
    integration: 'test_postgres',
    source: {
      table: 'customers',
      schema: 'public',
    },
    replication: {
      method: 'change_tracking',
      primary_key: ['id'],
      change_tracking: {
        slot_name: slotName,
        publication_name: 'track_customers_pub',
      },
    },
    output: {
      id: { type: 'integer' },
      _change_type: { type: 'string' },
    },
    extract: {
      table: {
        load_strategy: 'append',
      },
    },
  };
}

describe('validateWarehouseResourceForIntegration', () => {
  it('accepts pgoutput change_tracking for postgres integrations', () => {
    expect(
      validateWarehouseResourceForIntegration(postgresIntegration(), postgresCdcResource())
    ).toEqual([]);
  });

  it('rejects non-pgoutput change_tracking config for postgres integrations', () => {
    const resource = {
      ...postgresCdcResource(),
      replication: {
        method: 'change_tracking',
        change_tracking: { information: 'default' },
      },
    } as WarehouseResourceSpec;

    expect(validateWarehouseResourceForIntegration(postgresIntegration(), resource)).toEqual([
      'PostgreSQL change_tracking resources must use slot_name/publication_name (pgoutput) configuration',
    ]);
  });

  it('rejects pgoutput change_tracking config on non-postgres integrations', () => {
    expect(
      validateWarehouseResourceForIntegration(snowflakeIntegration(), postgresCdcResource())
    ).toEqual([
      'change_tracking config with slot_name/publication_name is only valid for PostgreSQL resources (got snowflake)',
    ]);
  });

  it('rejects pgoutput change_tracking config when source_type is omitted', () => {
    const integration = { ...postgresIntegration() } as Partial<IntegrationSpec> & {
      source_type?: IntegrationSpec['source_type'];
    };
    delete integration.source_type;

    expect(
      validateWarehouseResourceForIntegration(integration as IntegrationSpec, postgresCdcResource())
    ).toEqual([
      'change_tracking config with slot_name/publication_name is only valid for PostgreSQL resources (got undefined)',
    ]);
  });
});

describe('validatePostgresCdcSlotUniqueness', () => {
  it('reports duplicate slot ownership', () => {
    expect(
      validatePostgresCdcSlotUniqueness([
        postgresCdcResource('customers_cdc', 'shared_slot'),
        postgresCdcResource('accounts_cdc', 'shared_slot'),
      ])
    ).toEqual([
      {
        slotName: 'shared_slot',
        firstOwner: 'customers_cdc',
        duplicateOwner: 'accounts_cdc',
      },
    ]);
  });

  it('ignores distinct slot names', () => {
    expect(
      validatePostgresCdcSlotUniqueness([
        postgresCdcResource('customers_cdc', 'customers_slot'),
        postgresCdcResource('accounts_cdc', 'accounts_slot'),
      ])
    ).toEqual([]);
  });
});
