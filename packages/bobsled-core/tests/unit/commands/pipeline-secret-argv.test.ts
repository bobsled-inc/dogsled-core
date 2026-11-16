import { describe, expect, it } from 'vitest';
import {
  buildLoadArgs,
  buildLoadEnv,
  buildLoadArgsForDestination,
  buildDestinationLoadEnv,
} from '../../../src/commands/pipeline-load-args.js';
import type { PipelineOptions } from '../../../src/commands/pipeline.js';
import type { NamedDestination } from '../../../src/runner/config/schema.js';

describe('pipeline loader secrets', () => {
  it.each([
    ['postgresPassword', '--postgres-password'],
    ['mysqlPassword', '--mysql-password'],
    ['sfPassword', '--sf-password'],
    ['sfPrivateKeyPassphrase', '--sf-private-key-passphrase'],
    ['bqAccessToken', '--bq-access-token'],
    ['databricksToken', '--databricks-token'],
    ['databricksOauthClientSecret', '--databricks-oauth-client-secret'],
    ['clickhousePassword', '--clickhouse-password'],
    ['turbopufferApiKey', '--turbopuffer-api-key'],
  ])('keeps %s out of argv and resolves it in the child environment', (key, flag) => {
    const options = {
      integration: 'test',
      outputDir: './out',
      dest: 'duckdb',
      [key!]: 'synthetic-private-value',
    } as PipelineOptions;
    const args = buildLoadArgs(options);
    const reference = args[args.indexOf(flag!) + 1]!;
    expect(reference).toMatch(/^\$DOGSLED_LOADER_/);
    expect(args.join(' ')).not.toContain('synthetic-private-value');
    expect(buildLoadEnv({}, options)[reference.slice(1)]).toBe('synthetic-private-value');
    const indirect = { ...options, [key!]: '$SOURCE_SECRET' };
    expect(
      buildLoadEnv({}, indirect, { SOURCE_SECRET: 'synthetic-private-value' })[reference.slice(1)]
    ).toBe('synthetic-private-value');
  });
  it.each([
    {
      auth_env_vars: ['SOURCE_SECRET'],
      name: 'pg',
      type: 'postgres',
      host: 'localhost',
      database: 'test',
      username: 'test',
      password: '$SOURCE_SECRET',
    },
    {
      auth_env_vars: ['SOURCE_SECRET'],
      name: 'mysql',
      type: 'mysql',
      host: 'localhost',
      database: 'test',
      user: 'test',
      password: '$SOURCE_SECRET',
    },
    {
      auth_env_vars: ['SOURCE_SECRET'],
      name: 'sf',
      type: 'snowflake',
      account: 'test',
      username: 'test',
      warehouse: 'test',
      database: 'test',
      password: '$SOURCE_SECRET',
      private_key_passphrase: '$SOURCE_SECRET',
    },
    {
      auth_env_vars: ['SOURCE_SECRET'],
      name: 'bq',
      type: 'bigquery',
      project: 'test',
      dataset: 'test',
      credentials_access_token: '$SOURCE_SECRET',
    },
  ] satisfies NamedDestination[])('protects named $type destination secrets', (destination) => {
    const env = { SOURCE_SECRET: 'synthetic-private-value' };
    const args = buildLoadArgsForDestination(
      destination,
      { integration: 'test', outputDir: './out' },
      env
    );
    expect(args.join(' ')).not.toContain('synthetic-private-value');
    expect(args.join(' ')).not.toContain('$SOURCE_SECRET');
    const child = buildDestinationLoadEnv({}, destination, env);
    for (const reference of args.filter((value) => value.startsWith('$DOGSLED_LOADER_'))) {
      expect(child[reference.slice(1)]).toBe('synthetic-private-value');
    }
  });
});
