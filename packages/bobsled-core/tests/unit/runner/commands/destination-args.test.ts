import { describe, expect, it } from 'vitest';

import {
  buildDestinationCliArgs,
  SNOWFLAKE_ACCESS_TOKEN_ENV,
  SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV,
} from '../../../../src/runner/commands/destination-args.js';

describe('buildDestinationCliArgs — bigquery token credentials', () => {
  const base = { type: 'bigquery' as const, project: 'proj', dataset: 'ds' };

  it('emits --bq-token-command when credentials_token_command is set', () => {
    const args = buildDestinationCliArgs({
      ...base,
      credentials_token_command: 'mint-token --json',
    });
    const idx = args.indexOf('--bq-token-command');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('mint-token --json');
  });

  it('emits --bq-access-token when only the static token is set', () => {
    const args = buildDestinationCliArgs({ ...base, credentials_access_token: 'tok' });
    expect(args).toContain('--bq-access-token');
    expect(args).not.toContain('--bq-token-command');
  });

  it('emits only --bq-token-command when both token fields are set (precedence)', () => {
    const args = buildDestinationCliArgs({
      ...base,
      credentials_access_token: 'tok',
      credentials_token_command: 'mint-token --json',
    });
    expect(args).toContain('--bq-token-command');
    expect(args).not.toContain('--bq-access-token');
  });

  it('resolves $VAR placeholders in the token command via valueResolver', () => {
    const args = buildDestinationCliArgs(
      { auth_env_vars: ['TOKEN_CMD'], ...base, credentials_token_command: '$TOKEN_CMD' },
      { valueResolver: (v) => (v === '$TOKEN_CMD' ? 'gcloud print-token --json' : v) }
    );
    const idx = args.indexOf('--bq-token-command');
    expect(args[idx + 1]).toBe('gcloud print-token --json');
  });
});

describe('buildDestinationCliArgs — Snowflake OIDC credentials', () => {
  const base = {
    type: 'snowflake' as const,
    account: 'acme-org',
    username: 'loader',
    warehouse: 'compute_wh',
    database: 'raw',
  };

  it('emits --sf-access-token for a static pre-minted token', () => {
    const args = buildDestinationCliArgs({ ...base, credentials_access_token: 'jwt-token' });
    const idx = args.indexOf('--sf-access-token');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('jwt-token');
    expect(args).not.toContain('--sf-token-command');
  });

  it('emits an env placeholder when the caller supplies a secure token env var', () => {
    const args = buildDestinationCliArgs(
      { ...base, credentials_access_token: 'jwt-token' },
      { snowflakeAccessTokenEnv: SNOWFLAKE_ACCESS_TOKEN_ENV }
    );
    const idx = args.indexOf('--sf-access-token');
    expect(args[idx + 1]).toBe(`$${SNOWFLAKE_ACCESS_TOKEN_ENV}`);
    expect(args).not.toContain('jwt-token');
  });

  it('emits --sf-token-command when a refresh command is set', () => {
    const args = buildDestinationCliArgs({
      ...base,
      credentials_token_command: 'mint-snowflake-token --json',
    });
    const idx = args.indexOf('--sf-token-command');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('mint-snowflake-token --json');
    expect(args).not.toContain('--sf-access-token');
  });

  it('gives the token command deterministic precedence over the static token', () => {
    const args = buildDestinationCliArgs({
      ...base,
      credentials_access_token: 'jwt-token',
      credentials_token_command: 'mint-snowflake-token --json',
    });
    expect(args).toContain('--sf-token-command');
    expect(args).not.toContain('--sf-access-token');
  });

  it('emits a protected env placeholder for workload identity tokens', () => {
    const args = buildDestinationCliArgs({
      ...base,
      credentials_workload_identity_token: 'vercel-oidc-token',
    });

    expect(args).toContain('--sf-workload-identity-token');
    expect(args).toContain(`$${SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV}`);
    expect(args).not.toContain('vercel-oidc-token');
  });
});

describe('buildDestinationCliArgs — ClickHouse and Turbopuffer', () => {
  it('builds ClickHouse arguments including the HTTPS and vector-index flags', () => {
    expect(
      buildDestinationCliArgs({
        auth_env_vars: ['P'],
        type: 'clickhouse',
        host: 'h',
        port: 8443,
        database: 'd',
        password: '$P',
        ssl: true,
        vector_index: true,
      })
    ).toEqual([
      '--dest',
      'clickhouse',
      '--clickhouse-host',
      'h',
      '--clickhouse-port',
      '8443',
      '--clickhouse-database',
      'd',
      '--clickhouse-password',
      '$BOBSLED_CORE_LOADER_CLICKHOUSE_PASSWORD',
      '--clickhouse-ssl',
      '--clickhouse-vector-index',
    ]);
  });

  it('builds Turbopuffer arguments including full-text columns', () => {
    expect(
      buildDestinationCliArgs({
        auth_env_vars: ['K'],
        type: 'turbopuffer',
        api_key: '$K',
        full_text_columns: ['a', 'b'],
      })
    ).toEqual([
      '--dest',
      'turbopuffer',
      '--turbopuffer-api-key',
      '$BOBSLED_CORE_LOADER_TURBOPUFFER_API_KEY',
      '--turbopuffer-full-text-columns',
      'a,b',
    ]);
  });
});

describe('buildDestinationCliArgs — managed destination intent', () => {
  it('rejects an unmaterialized managed destination before building CLI args', () => {
    expect(() =>
      buildDestinationCliArgs({
        type: 'dogsled_managed',
        dogsled_connection_ref: 'warehouse-prod',
      })
    ).toThrow('A "dogsled_managed" destination only runs in Dogsled Cloud.');
  });
});
