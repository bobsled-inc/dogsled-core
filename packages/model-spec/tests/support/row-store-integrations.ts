/** The integrations the row store's gated suites connect to. Secrets stay in the environment. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  EnvSecretResolver,
  IntegrationFileSchema,
  interpolateSecrets,
  type CustomRunnerRegistry,
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
      host: env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_HOST!,
      port: Number(env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_PORT ?? 5432),
      database: env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_DATABASE!,
    },
    auth: {
      type: 'password',
      user: env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_USER!,
      password: env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_PASSWORD!,
    },
  };
}

/** The opt-in cloud suites' integration when it is a Snowflake one. They also accept BigQuery
 * and Databricks, which the row store does not support yet. */
export async function snowflakeIntegration(): Promise<SnowflakeIntegration | undefined> {
  const path = process.env.BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_INTEGRATION;
  if (!path || !process.env.BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_SCHEMA) return undefined;
  const integration: IntegrationFile = IntegrationFileSchema.parse(
    await interpolateSecrets(parse(await readFile(path, 'utf8')), new EnvSecretResolver())
  );
  return integration.source_type === 'snowflake' ? integration : undefined;
}

/** A host's own runner factories, so that it can prove the store through them before it switches.
 * Names an ES module that exports a `CustomRunnerRegistry` as `customRunners`. */
export async function hostRunners(): Promise<{ customRunners?: CustomRunnerRegistry }> {
  const path = process.env.BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_RUNNERS;
  if (!path) return {};
  const { customRunners } = (await import(pathToFileURL(path).href)) as {
    customRunners: CustomRunnerRegistry;
  };
  return { customRunners };
}
