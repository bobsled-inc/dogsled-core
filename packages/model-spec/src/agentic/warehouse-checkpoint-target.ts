import { caseName } from '../compiler/dialect.js';
import type { IntegrationFile } from '@bobsled-inc/connections';

export type WarehouseCheckpointTargetOptions = {
  database?: string;
  schema: string;
};

export function resolveWarehouseCheckpointTarget(
  integration: IntegrationFile,
  options: WarehouseCheckpointTargetOptions
): { catalog?: string; schema: string } {
  if (!options.schema.trim() || options.schema.length > 1024) {
    throw new Error('Invalid checkpoint schema');
  }
  if (options.database !== undefined) {
    if (integration.source_type !== 'snowflake') {
      throw new Error('Checkpoint database is only supported for Snowflake');
    }
    if (!options.database.trim() || options.database.length > 1024) {
      throw new Error('Invalid checkpoint database');
    }
  }
  const catalog =
    integration.source_type === 'snowflake'
      ? (options.database ?? integration.connection?.database)
      : integration.source_type === 'databricks'
        ? integration.connection?.catalog
        : integration.source_type === 'bigquery'
          ? integration.connection.project_id
          : undefined;
  if (integration.source_type === 'bigquery' && !catalog) {
    throw new Error('Checkpoint store requires a single BigQuery project_id');
  }
  return {
    ...(catalog ? { catalog: caseName(catalog, integration.source_type) } : {}),
    schema: caseName(options.schema, integration.source_type),
  };
}
