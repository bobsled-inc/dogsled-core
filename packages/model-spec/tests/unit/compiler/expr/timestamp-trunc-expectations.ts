import type { SupportedDialect } from '../../../../src/compiler/dialect.js';

export const TIMESTAMP_TRUNC_EXPECTATIONS = {
  bigquery: 'TIMESTAMP_TRUNC(created_at, DAY)',
  clickhouse: "date_trunc('day', created_at)",
  databricks: "date_trunc('day', created_at)",
  duckdb: "date_trunc('day', created_at)",
  mysql: "CAST(DATE_FORMAT(created_at, '%Y-%m-%d 00:00:00') AS DATETIME)",
  pgvector: "date_trunc('day', created_at)",
  postgres: "date_trunc('day', created_at)",
  redshift: "date_trunc('day', created_at)",
  snowflake: "DATE_TRUNC('DAY', CREATED_AT)",
} satisfies Record<SupportedDialect, string>;

export const TIMESTAMP_TRUNC_CASES = Object.entries(TIMESTAMP_TRUNC_EXPECTATIONS) as Array<
  [SupportedDialect, string]
>;
