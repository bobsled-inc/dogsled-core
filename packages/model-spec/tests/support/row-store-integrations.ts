/** The integrations the row store's gated suites connect to. Secrets stay in the environment. */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  EnvSecretResolver,
  IntegrationFileSchema,
  interpolateSecrets,
  type IntegrationFile,
  type PostgresIntegration,
  type SnowflakeIntegration,
} from '@bobsled-inc/connections';

export function postgresIntegration(): PostgresIntegration {
  const env = process.env;
  return {
    spec_version: '1',
    type: 'integration',
    name: 'lake',
    source_type: 'postgres',
    connection: {
      host: env.DOGSLED_MODEL_SPEC_POSTGRES_HOST!,
      port: Number(env.DOGSLED_MODEL_SPEC_POSTGRES_PORT ?? 5432),
      database: env.DOGSLED_MODEL_SPEC_POSTGRES_DATABASE!,
    },
    auth: {
      type: 'password',
      user: env.DOGSLED_MODEL_SPEC_POSTGRES_USER!,
      password: env.DOGSLED_MODEL_SPEC_POSTGRES_PASSWORD!,
    },
  };
}

/** The opt-in cloud suites' integration when it is a Snowflake one. They also accept BigQuery
 * and Databricks, which the row store does not support yet. */
export async function snowflakeIntegration(): Promise<SnowflakeIntegration | undefined> {
  const path = process.env.DOGSLED_MODEL_SPEC_CHECKPOINT_INTEGRATION;
  if (!path || !process.env.DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA) return undefined;
  const integration: IntegrationFile = IntegrationFileSchema.parse(
    await interpolateSecrets(parse(await readFile(path, 'utf8')), new EnvSecretResolver())
  );
  return integration.source_type === 'snowflake' ? integration : undefined;
}
