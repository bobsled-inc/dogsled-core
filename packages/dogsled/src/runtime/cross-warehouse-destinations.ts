import { interpolateSecrets, type IntegrationFile } from '@bobsled-inc/connections';
import { buildFqNameWithDatabase } from '@bobsled-inc/model-spec';
import type {
  CrossWarehousePublishContext,
  PlannedPublishedModel,
  ResolvedIntegration,
} from '@bobsled-inc/model-spec/project';
import type { DatabaseDestConfig } from '@bobsled-inc/loader';
import { CommandError } from '@bobsled-inc/protocol';

export interface PublishTarget {
  integration: ResolvedIntegration;
  config: DatabaseDestConfig;
  schema: string;
  table: string;
  database?: string;
}

export async function resolvePublishTarget(
  model: PlannedPublishedModel,
  context: CrossWarehousePublishContext
): Promise<PublishTarget> {
  const integration = context.project.integrations.get(model.targetHandle);
  if (!integration) {
    throw new CommandError(`Unknown publish target integration "${model.targetHandle}".`, 2);
  }
  const interpolated = await interpolateSecrets(integration.integration, context.secretResolver);
  const schema = model.targetSchema ?? integration.targetSchema;
  const database =
    model.targetDatabase ?? integration.targetDatabase ?? defaultPublishDatabase(interpolated);
  return {
    integration: { ...integration, integration: interpolated },
    config: toDestinationConfig(interpolated, schema, database),
    schema,
    table: model.node.parsedSpec.name,
    database,
  };
}

function defaultPublishDatabase(integration: IntegrationFile): string | undefined {
  if (integration.source_type === 'databricks') {
    return integration.connection.catalog;
  }
  if (integration.source_type === 'bigquery') {
    return integration.connection.project_id ?? integration.connection.project_ids?.[0];
  }
  return undefined;
}

export function targetFqName(target: PublishTarget): string {
  return buildFqNameWithDatabase(
    target.schema,
    target.table,
    target.integration.dialect,
    target.database
  );
}

function toDestinationConfig(
  integration: IntegrationFile,
  targetSchema: string,
  targetDatabase: string | undefined
): DatabaseDestConfig {
  switch (integration.source_type) {
    case 'duckdb': {
      if (integration.auth.type !== 'file') {
        throw new CommandError('publish: duckdb target requires auth.type: file.', 2);
      }
      return {
        dest: 'duckdb',
        dbPath: integration.auth.path,
        targetSchema,
        bufferSize: 1,
        logFormat: 'json',
        maxConcurrentLoads: 1,
      };
    }
    case 'postgres': {
      if (integration.auth.type !== 'password') {
        throw new CommandError('publish: postgres target requires auth.type: password in v1.', 2);
      }
      return {
        dest: 'postgres',
        host: required(integration.connection.host, 'postgres.connection.host'),
        port: integration.connection.port,
        database: integration.connection.database,
        schema: targetSchema,
        username: required(integration.auth.user, 'postgres.auth.user'),
        password: required(integration.auth.password, 'postgres.auth.password'),
        ssl: integration.connection.ssl?.mode !== 'disable',
        bufferSize: 1,
        logFormat: 'json',
        maxConcurrentLoads: 1,
      };
    }
    case 'clickhouse': {
      if (integration.auth.type !== 'password') {
        throw new CommandError('publish: clickhouse target requires auth.type: password.', 2);
      }
      // TLS unless explicitly disabled, and the port follows the scheme, so the
      // load path reaches ClickHouse Cloud on the same terms as the runner.
      const ssl = integration.connection.ssl?.mode !== 'disable';
      return {
        dest: 'clickhouse',
        host: required(integration.connection.host, 'clickhouse.connection.host'),
        port: integration.connection.port ?? (ssl ? 8443 : 8123),
        // ClickHouse has one namespace level, and `buildFqNameWithDatabase`
        // resolves it as `database ?? schema` for `database_table`. Resolving it
        // the same way here keeps the rows and the FQN pointing at one place.
        database: targetDatabase ?? targetSchema,
        username: required(integration.auth.user, 'clickhouse.auth.user'),
        // ClickHouse permits a passwordless user, and the key is omitted rather
        // than set to undefined so it satisfies the optional property.
        ...(integration.auth.password === undefined ? {} : { password: integration.auth.password }),
        ssl,
        vectorIndex: false,
        bufferSize: 1,
        logFormat: 'json',
        maxConcurrentLoads: 1,
      };
    }
    case 'bigquery': {
      const projectId = required(
        targetDatabase ??
          integration.connection.project_id ??
          integration.connection.project_ids?.[0],
        'bigquery.connection.project_id'
      );
      const auth = integration.auth;
      let credentials: Record<string, unknown> | undefined;
      let keyFilename: string | undefined;
      if (auth.type === 'service_account') {
        const raw = required(auth.credentials, 'bigquery.auth.credentials');
        try {
          credentials = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          keyFilename = raw;
        }
      }
      return {
        dest: 'bigquery',
        projectId,
        datasetId: targetSchema,
        location: integration.connection.default_location ?? integration.connection.location,
        credentials,
        keyFilename,
        bufferSize: 1,
        logFormat: 'json',
        maxConcurrentLoads: 1,
        stagingFormat: 'jsonl',
        targetFileSizeMb: 256,
        maxLoadJobs: 9000,
      };
    }
    case 'snowflake': {
      const auth = integration.auth;
      return {
        dest: 'snowflake',
        account: required(
          integration.connection.account_identifier,
          'snowflake.connection.account_identifier'
        ),
        username: required(integration.connection.user, 'snowflake.connection.user'),
        password: auth.type === 'pat' ? required(auth.token, 'snowflake.auth.token') : undefined,
        privateKeyPath:
          auth.type === 'rsa_key'
            ? required(auth.private_key_path, 'snowflake.auth.private_key_path')
            : undefined,
        privateKeyPassphrase: auth.type === 'rsa_key' ? auth.private_key_passphrase : undefined,
        authenticator:
          auth.type === 'oauth' ? 'OAUTH' : auth.type === 'rsa_key' ? 'SNOWFLAKE_JWT' : undefined,
        oauthClientId:
          auth.type === 'oauth' ? required(auth.client_id, 'snowflake.auth.client_id') : undefined,
        oauthClientSecret:
          auth.type === 'oauth'
            ? required(auth.client_secret, 'snowflake.auth.client_secret')
            : undefined,
        oauthTokenUrl: auth.type === 'oauth' ? auth.token_url : undefined,
        warehouse: required(integration.connection.warehouse, 'snowflake.connection.warehouse'),
        database: required(
          targetDatabase ?? integration.connection.database,
          'snowflake.connection.database'
        ),
        targetSchema,
        role: integration.connection.role,
        bufferSize: 1,
        logFormat: 'json',
        maxConcurrentLoads: 1,
      };
    }
    case 'databricks': {
      if (integration.auth.type !== 'pat') {
        throw new CommandError('publish: databricks target requires auth.type: pat in v1.', 2);
      }
      return {
        dest: 'databricks',
        serverHostname: required(
          normalizeDatabricksHostname(integration.connection.workspace_url),
          'databricks.connection.workspace_url'
        ),
        httpPath: required(integration.connection.http_path, 'databricks.connection.http_path'),
        accessToken: required(integration.auth.token, 'databricks.auth.token'),
        catalog: required(
          targetDatabase ?? integration.connection.catalog,
          'databricks.connection.catalog'
        ),
        schema: targetSchema,
        bufferSize: 1,
        logFormat: 'json',
        maxConcurrentLoads: 1,
      };
    }
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) {
    throw new CommandError(`publish target is missing required ${label}.`, 2);
  }
  return value;
}

function normalizeDatabricksHostname(rawWorkspaceUrl: string | undefined): string | undefined {
  if (!rawWorkspaceUrl) return undefined;
  // Strip scheme + anything after the host (path, query, fragment, trailing
  // slash) so the destination receives a bare hostname even when the user
  // pasted the full workspace URL into integrations/<handle>.yml.
  // Trim FIRST so a leading space doesn't defeat the scheme regex
  // (otherwise " https://foo" would only have the trailing space removed
  // and collapse to "https:"). Scheme match is case-insensitive to
  // accept HTTPS://.
  return rawWorkspaceUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .trim();
}
