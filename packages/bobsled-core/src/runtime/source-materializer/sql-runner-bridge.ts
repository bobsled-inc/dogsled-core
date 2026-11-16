import {
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';

import type { ResolvedDestination } from './destination-resolver.js';
import { escapeLiteral, validateIdentifier } from './sql-utils.js';

export interface CreateSqlRunnerArgs {
  destination: ResolvedDestination;
  resolveRunnerImpl?: typeof resolveRunner;
}

function duckDbIntegration(path: string, schema: string): IntegrationFile {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'source_materializer_duckdb',
    source_type: 'duckdb',
    connection: { schema },
    auth: path === ':memory:' ? { type: 'memory' } : { type: 'file', path, read_only: false },
  };
}

function bigQueryIntegration(destination: ResolvedDestination): IntegrationFile {
  if (destination.config.dest !== 'bigquery') {
    throw new CommandError('Expected BigQuery destination config', 2);
  }
  const auth =
    destination.config.credentials !== undefined
      ? {
          type: 'service_account' as const,
          credentials: JSON.stringify(destination.config.credentials),
        }
      : destination.config.keyFilename !== undefined
        ? { type: 'service_account' as const, credentials: destination.config.keyFilename }
        : { type: 'adc' as const };

  return {
    spec_version: '1',
    type: 'integration',
    name: 'source_materializer_bigquery',
    source_type: 'bigquery',
    connection: {
      project_id: destination.config.projectId,
      dataset: destination.schema,
      location: destination.config.location,
    },
    auth,
  };
}

function snowflakeIntegration(destination: ResolvedDestination): IntegrationFile {
  if (destination.config.dest !== 'snowflake') {
    throw new CommandError('Expected Snowflake destination config', 2);
  }
  const config = destination.config;
  const connection = {
    account_identifier: config.account,
    warehouse: config.warehouse,
    user: config.username,
    database: config.database,
    schema: destination.schema,
    role: config.role ?? 'PUBLIC',
  };

  if (config.authenticator === 'SNOWFLAKE_JWT') {
    if (!config.privateKeyPath) {
      throw new CommandError('snowflake SNOWFLAKE_JWT auth requires privateKeyPath', 2);
    }
    return {
      spec_version: '1',
      type: 'integration',
      name: 'source_materializer_snowflake',
      source_type: 'snowflake',
      connection,
      auth: {
        type: 'rsa_key',
        private_key_path: config.privateKeyPath,
        private_key_passphrase: config.privateKeyPassphrase,
      },
    };
  }

  if (config.authenticator === 'OAUTH') {
    if (!config.oauthClientId || !config.oauthClientSecret || !config.oauthTokenUrl) {
      throw new CommandError(
        'snowflake OAUTH auth requires oauthClientId, oauthClientSecret, and oauthTokenUrl',
        2
      );
    }
    return {
      spec_version: '1',
      type: 'integration',
      name: 'source_materializer_snowflake',
      source_type: 'snowflake',
      connection,
      auth: {
        type: 'oauth',
        client_id: config.oauthClientId,
        client_secret: config.oauthClientSecret,
        token_url: config.oauthTokenUrl,
      },
    };
  }

  if (!config.password) {
    throw new CommandError(
      'snowflake destination requires password, OAUTH, or SNOWFLAKE_JWT auth for query execution',
      2
    );
  }
  return {
    spec_version: '1',
    type: 'integration',
    name: 'source_materializer_snowflake',
    source_type: 'snowflake',
    connection,
    auth: { type: 'pat', token: config.password },
  };
}

function runnerIntegrationFor(destination: ResolvedDestination): IntegrationFile {
  if (destination.kind === 'in_memory') return duckDbIntegration(':memory:', destination.schema);
  if (destination.kind === 'duckdb') {
    if (destination.config.dest !== 'duckdb') throw new CommandError('Expected DuckDB config', 2);
    return duckDbIntegration(destination.config.dbPath, destination.schema);
  }
  if (destination.kind === 'ducklake') return duckDbIntegration(':memory:', destination.schema);
  if (destination.kind === 'bigquery') return bigQueryIntegration(destination);
  return snowflakeIntegration(destination);
}

export async function createSqlRunnerFor(args: CreateSqlRunnerArgs): Promise<SqlRunnerModule> {
  const resolve = args.resolveRunnerImpl ?? resolveRunner;
  const runner = await resolve(runnerIntegrationFor(args.destination));

  if (args.destination.kind === 'ducklake') {
    if (args.destination.config.dest !== 'ducklake') {
      throw new CommandError('Expected DuckLake config', 2);
    }
    // ducklake is a core DuckDB extension as of 1.3 (bundled in 1.4.x). The
    // community build is not published for 1.4.x and 404s, so install the core
    // extension first and only fall back to the community repo for older engines.
    try {
      await runner.run('INSTALL ducklake');
    } catch {
      await runner.run('INSTALL ducklake FROM community');
    }
    await runner.run('LOAD ducklake');
    const alias = validateIdentifier(args.destination.config.attachAlias);
    const attachOptionParts: string[] = [];
    if (args.destination.config.dataPath) {
      attachOptionParts.push(`DATA_PATH '${escapeLiteral(args.destination.config.dataPath)}'`);
    }
    if (args.destination.config.metadataSchema) {
      attachOptionParts.push(
        `METADATA_SCHEMA '${escapeLiteral(args.destination.config.metadataSchema)}'`
      );
    }
    const attachOptions = attachOptionParts.length > 0 ? ` (${attachOptionParts.join(', ')})` : '';
    await runner.run(
      `ATTACH '${escapeLiteral(args.destination.config.catalogUrl)}' AS "${alias}"${attachOptions}`
    );
    await runner.run(`USE "${alias}"`);
  }

  return runner;
}
