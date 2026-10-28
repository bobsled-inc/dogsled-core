import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
/**
 * `integrations/<handle>.yml` file schema.
 *
 * An integration is a single connectable system — a warehouse this Model Spec project
 * can read from or write to. The schema is a discriminated union on
 * `source_type`; each variant embeds its dialect's `connection` and `auth`.
 *
 * This schema lives alongside the existing canonical schema in
 * `packages/extractor/src/framework/core/warehouse.ts`. Both parse the same
 * YAML files; Model Spec consumes this copy pending consolidation.
 */

import { z } from 'zod';

import { BigQueryAuthSchema, BigQueryConnectionSchema } from './bigquery.js';
import { ClickHouseAuthSchema, ClickHouseConnectionSchema } from './clickhouse.js';
import { DatabricksAuthSchema, DatabricksConnectionSchema } from './databricks.js';
import { DuckDbAuthSchema, DuckDbConnectionSchema } from './duckdb.js';
import { PostgresAuthSchema, PostgresConnectionSchema } from './postgres.js';
import { snakeCaseHandleSchema } from './shared.js';
import { SnowflakeAuthSchema, SnowflakeConnectionSchema } from './snowflake.js';

// ---------------------------------------------------------------------------
// Source types covered by the shared connections package (V0)
// ---------------------------------------------------------------------------

/**
 * Source types `@bobsled-inc/connections` knows about in V0. Extractor and
 * loader may know about additional variants (redshift, mysql, iceberg,
 * delta, api) — those will be migrated into this package by the follow-up
 * consolidation PR, not this one.
 */
export const SourceTypeValues = [
  'snowflake',
  'bigquery',
  'postgres',
  'databricks',
  'duckdb',
  'clickhouse',
] as const;
export const SourceTypeSchema = z.enum(SourceTypeValues);
export type SourceType = z.infer<typeof SourceTypeSchema>;

// ---------------------------------------------------------------------------
// Per-dialect integration schemas
// ---------------------------------------------------------------------------

const BaseIntegrationFields = {
  spec_version: z.literal('1'),
  type: z.literal('integration'),
  auth_env_vars: AuthEnvVarsSchema,
  name: snakeCaseHandleSchema,
} as const;

export const CrossWarehouseStagingSchema = z
  .object({
    uri: z.string().trim().min(1),
  })
  .strict();

export const SnowflakeIntegrationSchema = z
  .object({
    ...BaseIntegrationFields,
    source_type: z.literal('snowflake'),
    connection: SnowflakeConnectionSchema,
    auth: SnowflakeAuthSchema,
    cross_warehouse_staging: CrossWarehouseStagingSchema.optional(),
  })
  // passthrough so host-specific metadata fields (e.g. storage, tags) travel
  // through unchanged without this package needing to know about them
  .passthrough();

export const BigQueryIntegrationSchema = z
  .object({
    ...BaseIntegrationFields,
    source_type: z.literal('bigquery'),
    connection: BigQueryConnectionSchema,
    auth: BigQueryAuthSchema,
    cross_warehouse_staging: CrossWarehouseStagingSchema.optional(),
  })
  .passthrough();

export const PostgresIntegrationSchema = z
  .object({
    ...BaseIntegrationFields,
    source_type: z.literal('postgres'),
    connection: PostgresConnectionSchema,
    auth: PostgresAuthSchema,
  })
  .passthrough();

export const ClickHouseIntegrationSchema = z
  .object({
    ...BaseIntegrationFields,
    source_type: z.literal('clickhouse'),
    connection: ClickHouseConnectionSchema,
    auth: ClickHouseAuthSchema,
  })
  .passthrough();

export const DatabricksIntegrationSchema = z
  .object({
    ...BaseIntegrationFields,
    source_type: z.literal('databricks'),
    connection: DatabricksConnectionSchema,
    auth: DatabricksAuthSchema,
    cross_warehouse_staging: CrossWarehouseStagingSchema.optional(),
  })
  .passthrough();

export const DuckDbIntegrationSchema = z
  .object({
    ...BaseIntegrationFields,
    source_type: z.literal('duckdb'),
    connection: DuckDbConnectionSchema,
    auth: DuckDbAuthSchema,
    cross_warehouse_staging: CrossWarehouseStagingSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export const IntegrationFileSchema = z.discriminatedUnion('source_type', [
  SnowflakeIntegrationSchema,
  BigQueryIntegrationSchema,
  PostgresIntegrationSchema,
  DatabricksIntegrationSchema,
  DuckDbIntegrationSchema,
  ClickHouseIntegrationSchema,
]);

export type IntegrationFile = z.infer<typeof IntegrationFileSchema>;
export type SnowflakeIntegration = z.infer<typeof SnowflakeIntegrationSchema>;
export type BigQueryIntegration = z.infer<typeof BigQueryIntegrationSchema>;
export type PostgresIntegration = z.infer<typeof PostgresIntegrationSchema>;
export type DatabricksIntegration = z.infer<typeof DatabricksIntegrationSchema>;
export type DuckDbIntegration = z.infer<typeof DuckDbIntegrationSchema>;
export type ClickHouseIntegration = z.infer<typeof ClickHouseIntegrationSchema>;
