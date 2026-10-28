import { describe, expect, it } from 'vitest';
import { targetToLoaderConfig } from '../../src/runtime/target-loader.js';

const target = {
  spec_version: '1',
  type: 'target',
  name: 'example',
  integration: 'warehouse',
} as const;
const snowflake = {
  auth_env_vars: [
    'EXAMPLE_DATABASE',
    'EXAMPLE_ROLE',
    'EXAMPLE_SCHEMA',
    'OVERRIDE_DATABASE',
    'OVERRIDE_SCHEMA',
    'OVERRIDE_ROLE',
    'OVERRIDE_WAREHOUSE',
  ],
  spec_version: '1',
  type: 'integration',
  name: 'warehouse',
  source_type: 'snowflake',
  connection: {
    account_identifier: 'example-account',
    user: 'example_user',
    warehouse: 'EXAMPLE_WH',
    database: '${{ env.EXAMPLE_DATABASE }}',
    schema: '${{ env.EXAMPLE_SCHEMA }}',
    role: '${{ env.EXAMPLE_ROLE }}',
  },
  auth: { type: 'pat', token: 'test-only-placeholder' },
} as const;
const sfEnv = {
  EXAMPLE_DATABASE: 'EXAMPLE_DB',
  EXAMPLE_SCHEMA: 'EXAMPLE_SCHEMA',
  EXAMPLE_ROLE: 'EXAMPLE_ROLE',
};
const bigquery = {
  auth_env_vars: ['EXAMPLE_DATASET', 'EXAMPLE_LOCATION', 'EXAMPLE_PROJECT', 'OVERRIDE_DATASET'],
  spec_version: '1',
  type: 'integration',
  name: 'warehouse',
  source_type: 'bigquery',
  connection: {
    project_id: '${{ env.EXAMPLE_PROJECT }}',
    dataset: '${{ env.EXAMPLE_DATASET }}',
    location: '${{ env.EXAMPLE_LOCATION }}',
  },
  auth: { type: 'adc' },
} as const;
const bqEnv = {
  EXAMPLE_PROJECT: 'example-project',
  EXAMPLE_DATASET: 'example_dataset',
  EXAMPLE_LOCATION: 'US',
};

describe('destination namespace environment templates', () => {
  it('renders Snowflake database, schema and role before constructing a destination', () => {
    expect(targetToLoaderConfig(target, snowflake, sfEnv)).toMatchObject({
      dest: 'snowflake',
      database: 'EXAMPLE_DB',
      targetSchema: 'EXAMPLE_SCHEMA',
      role: 'EXAMPLE_ROLE',
    });
  });
  it('renders Snowflake overrides without resolving unused connection defaults', () => {
    expect(
      targetToLoaderConfig(
        {
          ...target,
          overrides: {
            database: '${{ env.OVERRIDE_DATABASE }}',
            schema: '${{ env.OVERRIDE_SCHEMA }}',
            role: '${{ env.OVERRIDE_ROLE }}',
            warehouse: '${{ env.OVERRIDE_WAREHOUSE }}',
          },
        },
        snowflake,
        {
          OVERRIDE_DATABASE: 'OVERRIDE_DB',
          OVERRIDE_SCHEMA: 'OVERRIDE_SCHEMA',
          OVERRIDE_ROLE: 'OVERRIDE_ROLE',
          OVERRIDE_WAREHOUSE: 'OVERRIDE_WH',
        }
      )
    ).toMatchObject({
      database: 'OVERRIDE_DB',
      targetSchema: 'OVERRIDE_SCHEMA',
      role: 'OVERRIDE_ROLE',
      warehouse: 'OVERRIDE_WH',
    });
  });
  it('renders BigQuery project, dataset and location', () => {
    expect(targetToLoaderConfig(target, bigquery, bqEnv)).toMatchObject({
      dest: 'bigquery',
      projectId: 'example-project',
      datasetId: 'example_dataset',
      location: 'US',
    });
  });
  it('renders a BigQuery dataset override without requiring the unused default', () => {
    expect(
      targetToLoaderConfig(
        { ...target, overrides: { schema: '${{ env.OVERRIDE_DATASET }}' } },
        bigquery,
        {
          EXAMPLE_PROJECT: 'example-project',
          EXAMPLE_LOCATION: 'US',
          OVERRIDE_DATASET: 'override_dataset',
        }
      )
    ).toMatchObject({ datasetId: 'override_dataset' });
  });
  it('renders the first project_ids entry when the shorthand is absent', () => {
    expect(
      targetToLoaderConfig(
        target,
        {
          ...bigquery,
          connection: {
            project_ids: ['${{ env.EXAMPLE_PROJECT }}'],
            dataset: '${{ env.EXAMPLE_DATASET }}',
            location: 'US',
          },
        },
        bqEnv
      )
    ).toMatchObject({ projectId: 'example-project' });
  });
  it.each(Object.keys(sfEnv))('rejects an unset Snowflake namespace variable %s', (missing) => {
    expect(() =>
      targetToLoaderConfig(target, snowflake, { ...sfEnv, [missing]: undefined })
    ).toThrow(new RegExp(missing));
  });
  it.each(Object.keys(bqEnv))('rejects an unset BigQuery namespace variable %s', (missing) => {
    expect(() =>
      targetToLoaderConfig(target, bigquery, { ...bqEnv, [missing]: undefined })
    ).toThrow(new RegExp(missing));
  });
});

it('rejects undeclared loader references before reading the supplied environment', () => {
  const env = new Proxy(
    {},
    {
      get: () => {
        throw new Error('Unexpected secret read');
      },
    }
  );
  expect(() => targetToLoaderConfig(target, { ...snowflake, auth_env_vars: [] }, env)).toThrow(
    'Add EXAMPLE_DATABASE to auth_env_vars'
  );
});
