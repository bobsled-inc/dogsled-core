import { describe, expect, it, vi } from 'vitest';

import type { IntegrationFile } from '../../../../src/schemas/integration.js';

const builders = vi.hoisted(() => ({
  postgres: vi.fn(),
  snowflake: vi.fn(),
  bigquery: vi.fn(),
  databricks: vi.fn(),
}));
vi.mock('../../../../src/runtime/runners/postgres.js', () => ({
  buildPostgresRunner: builders.postgres,
}));
vi.mock('../../../../src/runtime/runners/snowflake.js', () => ({
  buildSnowflakeRunner: builders.snowflake,
}));
vi.mock('../../../../src/runtime/runners/bigquery.js', () => ({
  buildBigQueryRunner: builders.bigquery,
}));
vi.mock('../../../../src/runtime/runners/databricks.js', () => ({
  buildDatabricksRunner: builders.databricks,
}));

const { builtinRunnerRegistry } = await import('../../../../src/runtime/runners/index.js');

describe('built-in runner registry', () => {
  it.each([
    ['postgres', 'password'],
    ['postgres', 'iam'],
    ['snowflake', 'pat'],
    ['snowflake', 'rsa_key'],
    ['snowflake', 'oauth'],
    ['bigquery', 'adc'],
    ['bigquery', 'wif'],
    ['bigquery', 'service_account'],
    ['databricks', 'pat'],
    ['databricks', 'oauth_m2m'],
  ] as const)('forwards the statement limit to %s with %s auth', async (sourceType, authType) => {
    const factory = builtinRunnerRegistry.get(sourceType, authType)!;
    await factory({ source_type: sourceType } as IntegrationFile, { statementTimeoutMs: 60_000 });
    expect(builders[sourceType]).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ statementTimeoutMs: 60_000 })
    );
  });
});
