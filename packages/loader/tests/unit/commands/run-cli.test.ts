import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';

import { CommandError } from '@bobsled-inc/protocol';
import { buildConfigInput, resolveOptionPlaceholders } from '../../../src/commands/run-cli.js';
import { registerRunCommand } from '../../../src/commands/run.js';
import { LoaderConfigSchema } from '../../../src/schemas/config.js';
import type { LoaderConfig } from '../../../src/schemas/config.js';

describe('buildConfigInput', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PG_HOST = 'db.example.com';
    process.env.PG_PASSWORD = 'resolved-pg-password';
    process.env.PGVECTOR_COLUMNS = 'embedding, search_vector';
    process.env.TPUF_KEY = 'resolved-turbopuffer-key';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('resolves $VARNAME destination env placeholders inside the loader process', () => {
    const config = buildConfigInput({
      dest: 'postgres',
      postgresHost: '$PG_HOST',
      postgresDatabase: 'warehouse',
      postgresUser: 'loader',
      postgresPassword: '$PG_PASSWORD',
    });

    expect(config).toMatchObject({
      dest: 'postgres',
      host: 'db.example.com',
      password: 'resolved-pg-password',
    });
  });

  it('resolves ${{ env.VARNAME }} destination env placeholders inside the loader process', () => {
    const config = buildConfigInput({
      dest: 'postgres',
      postgresHost: '${{ env.PG_HOST }}',
      postgresDatabase: 'warehouse',
      postgresUser: 'loader',
      postgresPassword: '${{ env.PG_PASSWORD }}',
    });

    expect(config).toMatchObject({
      dest: 'postgres',
      host: 'db.example.com',
      password: 'resolved-pg-password',
    });
  });

  it('rejects invalid environment variable names in placeholders', () => {
    expect(() =>
      buildConfigInput({
        dest: 'postgres',
        postgresHost: '$INVALID-HOST-NAME',
        postgresDatabase: 'warehouse',
        postgresUser: 'loader',
      })
    ).toThrow('Invalid environment variable name in placeholder');
  });

  it('names the option, never its value, when a placeholder is invalid', () => {
    const secret = '$ecr3t!';
    let message = '';
    try {
      buildConfigInput({
        dest: 'postgres',
        postgresHost: 'db.example.com',
        postgresDatabase: 'warehouse',
        postgresUser: 'loader',
        postgresPassword: secret,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('destination field "password"');
    expect(message).not.toContain(secret);

    expect(() => resolveOptionPlaceholders({ postgresPassword: secret })).toThrow(
      /for --postgres-password\./
    );
    try {
      resolveOptionPlaceholders({ postgresPassword: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('fails when a $VARNAME placeholder environment variable is unset', () => {
    delete process.env.PG_PASSWORD;

    expect(() =>
      buildConfigInput({
        dest: 'postgres',
        postgresHost: 'db.example.com',
        postgresDatabase: 'warehouse',
        postgresUser: 'loader',
        postgresPassword: '$PG_PASSWORD',
      })
    ).toThrow('Missing environment variable: PG_PASSWORD');
  });

  it('fails when a ${{ env.VARNAME }} placeholder environment variable is unset', () => {
    delete process.env.PG_PASSWORD;

    expect(() =>
      buildConfigInput({
        dest: 'postgres',
        postgresHost: 'db.example.com',
        postgresDatabase: 'warehouse',
        postgresUser: 'loader',
        postgresPassword: '${{ env.PG_PASSWORD }}',
      })
    ).toThrow('Missing environment variable: PG_PASSWORD');
  });

  it('allows intentionally empty environment variable values', () => {
    process.env.PG_PASSWORD = '';

    const config = buildConfigInput({
      dest: 'postgres',
      postgresHost: 'db.example.com',
      postgresDatabase: 'warehouse',
      postgresUser: 'loader',
      postgresPassword: '$PG_PASSWORD',
    });

    expect(config).toMatchObject({
      dest: 'postgres',
      password: '',
    });
  });

  it('builds pgvector config with parsed vector columns', () => {
    const config = buildConfigInput({
      dest: 'pgvector',
      pgvectorHost: '$PG_HOST',
      pgvectorDatabase: 'vectors',
      pgvectorUser: 'loader',
      pgvectorPassword: '$PG_PASSWORD',
      vectorDimension: 1536,
      vectorColumns: '$PGVECTOR_COLUMNS',
    });

    expect(config).toMatchObject({
      dest: 'pgvector',
      host: 'db.example.com',
      password: 'resolved-pg-password',
      vectorDimension: 1536,
      vectorColumns: ['embedding', 'search_vector'],
    });
  });

  it('builds Turbopuffer config with resolved API key and parsed full-text columns', () => {
    const config = buildConfigInput({
      dest: 'turbopuffer',
      turbopufferApiKey: '$TPUF_KEY',
      turbopufferFullTextColumns: 'title, body',
      turbopufferRegion: 'gcp-us-central1',
    });

    expect(config).toMatchObject({
      dest: 'turbopuffer',
      apiKey: 'resolved-turbopuffer-key',
      region: 'gcp-us-central1',
      fullTextColumns: ['title', 'body'],
    });
  });

  it('carries Snowflake OIDC token fields into the loader config', () => {
    process.env.SF_ACCESS_TOKEN = 'snowflake-oidc-token';
    process.env.SF_TOKEN_COMMAND = 'mint-snowflake-token --json';

    const config = buildConfigInput({
      dest: 'snowflake',
      sfAccount: 'acct',
      sfUsername: 'loader',
      sfWarehouse: 'WH',
      sfDatabase: 'DB',
      sfAccessToken: '$SF_ACCESS_TOKEN',
      sfTokenCommand: '${{ env.SF_TOKEN_COMMAND }}',
    });

    expect(config).toMatchObject({
      dest: 'snowflake',
      accessToken: 'snowflake-oidc-token',
      tokenCommand: 'mint-snowflake-token --json',
    });
  });

  it('carries Snowflake per-stream table ownership markers into the loader config', () => {
    const config = buildConfigInput({
      dest: 'snowflake',
      sfAccount: 'acct',
      sfUsername: 'loader',
      sfWarehouse: 'WH',
      sfDatabase: 'DB',
      targetSchema: 'STAGING',
      streamTableOwnershipMarker: { issues: 'temp-dataset-123' },
    });

    expect(config).toMatchObject({
      dest: 'snowflake',
      streamTableOwnershipMarkers: { issues: 'temp-dataset-123' },
    });
  });

  it('omits an empty reconciliation selection and carries explicit Snowflake streams', () => {
    const base = {
      dest: 'snowflake',
      sfAccount: 'acct',
      sfUsername: 'loader',
      sfWarehouse: 'WH',
      sfDatabase: 'DB',
    };

    expect(buildConfigInput({ ...base, reconcileSchema: [] })).not.toHaveProperty(
      'reconcileSchema'
    );
    expect(buildConfigInput({ ...base, reconcileSchema: ['issues', 'events'] })).toMatchObject({
      reconcileSchema: ['issues', 'events'],
    });
  });

  it('maps the Snowflake workload identity token into the loader config', () => {
    const config = buildConfigInput({
      dest: 'snowflake',
      sfAccount: 'acct',
      sfUsername: 'loader',
      sfWarehouse: 'WH',
      sfDatabase: 'DB',
      sfWorkloadIdentityToken: 'header.payload.signature',
    });

    expect(config).toMatchObject({
      workloadIdentityToken: 'header.payload.signature',
    });
  });

  it.each(['\n', '\r\n'])(
    'rejects Snowflake WIF tokens with raw leading/trailing %j',
    (lineBreak) => {
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
      ).toString('base64url');
      const token = `header.${payload}.signature${lineBreak}`;
      const config = buildConfigInput({
        dest: 'snowflake',
        sfAccount: 'acct',
        sfUsername: 'loader',
        sfWarehouse: 'WH',
        sfDatabase: 'DB',
        sfWorkloadIdentityToken: token,
      });

      const parsed = LoaderConfigSchema.safeParse(config);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: 'must not contain CR or LF characters' }),
          ])
        );
      }
    }
  );

  it('carries per-stream load strategy, schema behavior, and table overrides into database config', () => {
    const config = buildConfigInput({
      dest: 'postgres',
      postgresHost: '$PG_HOST',
      postgresDatabase: 'warehouse',
      postgresUser: 'loader',
      postgresPassword: '$PG_PASSWORD',
      streamLoadStrategy: { issues: 'merge' },
      streamSchemaBehavior: { issues: 'strict' },
      streamTable: { issues: 'raw_issues' },
    });

    expect(config).toMatchObject({
      streamLoadStrategies: { issues: 'merge' },
      streamSchemaBehaviors: { issues: 'strict' },
      streamTables: { issues: 'raw_issues' },
    });
  });
});

describe('registerRunCommand Snowflake workload identity option', () => {
  const originalEnv = { ...process.env };

  function createProgram(
    runHandler: (config: LoaderConfig, dependencies?: { queryTag?: string }) => Promise<unknown>
  ): Command {
    const program = new Command();
    registerRunCommand(program, runHandler);
    return program;
  }

  async function parseSnowflakeRun(
    program: Command,
    reference: string,
    additionalArgs: string[] = []
  ): Promise<unknown> {
    try {
      await program.parseAsync([
        'node',
        'dogsled load',
        'run',
        '--dest',
        'snowflake',
        '--sf-account',
        'acct',
        '--sf-username',
        'loader',
        '--sf-warehouse',
        'WH',
        '--sf-database',
        'DB',
        ...additionalArgs,
        '--sf-workload-identity-token',
        reference,
      ]);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('rejects a literal token before invoking the run handler', async () => {
    const token = 'not-a-real-jwt-token';
    let handlerCalls = 0;
    const program = createProgram(async () => {
      handlerCalls += 1;
    });

    const error = await parseSnowflakeRun(program, token);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      message: 'Snowflake workload identity token must be an environment variable reference.',
      exitCode: 2,
    });
    expect(String(error)).not.toContain(token);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a malformed environment reference before invoking the run handler', async () => {
    const reference = '$SF-WIF-TOKEN';
    let handlerCalls = 0;
    const program = createProgram(async () => {
      handlerCalls += 1;
    });

    const error = await parseSnowflakeRun(program, reference);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      message: 'Snowflake workload identity token must be an environment variable reference.',
      exitCode: 2,
    });
    expect(String(error)).not.toContain(reference);
    expect(handlerCalls).toBe(0);
  });

  it.each(['$SF_WIF_TOKEN', '${{ env.SF_WIF_TOKEN }}'])(
    'resolves the quoted %s reference before invoking the run handler',
    async (reference) => {
      const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
      ).toString('base64url');
      const resolvedToken = `header.${payload}.signature`;
      process.env.SF_WIF_TOKEN = resolvedToken;
      let receivedConfig: LoaderConfig | undefined;
      const program = createProgram(async (config) => {
        receivedConfig = config;
      });

      expect(await parseSnowflakeRun(program, reference)).toBeUndefined();

      expect(receivedConfig?.dest).toBe('snowflake');
      if (receivedConfig?.dest !== 'snowflake') {
        throw new Error('Expected the run handler to receive a Snowflake config.');
      }
      expect(receivedConfig.workloadIdentityToken).toBe(resolvedToken);
    }
  );

  it('passes query tags as transient run dependencies instead of persisted config', async () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    process.env.SF_WIF_TOKEN = `header.${payload}.signature`;
    let receivedConfig: LoaderConfig | undefined;
    let receivedQueryTag: string | undefined;
    const program = createProgram(async (config, dependencies) => {
      receivedConfig = config;
      receivedQueryTag = dependencies?.queryTag;
    });

    expect(
      await parseSnowflakeRun(program, '$SF_WIF_TOKEN', ['--query-tag', 'managed:run-42'])
    ).toBeUndefined();
    expect(receivedQueryTag).toBe('managed:run-42');
    expect(receivedConfig).not.toHaveProperty('queryTag');
  });

  it.each(['$SF_WIF_TOKEN', '${{ env.SF_WIF_TOKEN }}'])(
    'rejects a %s reference when its environment value is blank or unset',
    async (reference) => {
      if (reference === '$SF_WIF_TOKEN') {
        process.env.SF_WIF_TOKEN = '';
      } else {
        delete process.env.SF_WIF_TOKEN;
      }
      let handlerCalls = 0;
      const program = createProgram(async () => {
        handlerCalls += 1;
      });

      const error = await parseSnowflakeRun(program, reference);

      expect(error).toBeInstanceOf(CommandError);
      expect(error).toMatchObject({ name: 'CommandError', exitCode: 2 });
      expect(String(error)).not.toContain(reference);
      expect(handlerCalls).toBe(0);
    }
  );

  it.each([
    {
      path: 'dry-run validation',
      additionalArgs: [
        '--dry-run',
        '--stream-table',
        'issues:shared_table',
        '--stream-table',
        'pull_requests:shared_table',
      ],
    },
    {
      path: 'load-file target resolution',
      additionalArgs: ['--load-file', '/loader-wif-boundary-does-not-exist.yml'],
    },
    {
      path: 'load-integration target resolution',
      additionalArgs: ['--load-integration', 'loader_wif_boundary_does_not_exist'],
    },
  ])('rejects a literal token before $path', async ({ additionalArgs }) => {
    const token = 'literal-wif-token-bypass-sentinel';
    let handlerCalls = 0;
    const program = createProgram(async () => {
      handlerCalls += 1;
    });

    const error = await parseSnowflakeRun(program, token, additionalArgs);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      message: 'Snowflake workload identity token must be an environment variable reference.',
      exitCode: 2,
    });
    expect(String(error)).not.toContain(token);
    expect(handlerCalls).toBe(0);
  });
});
