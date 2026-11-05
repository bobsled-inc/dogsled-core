import { PROTOCOL_VERSION } from '@bobsled-inc/protocol';

import type {
  LoadStrategy,
  ResourceSpec,
  SchemaBehavior,
  SchemaColumn,
  SchemaMessage,
} from '../types/index.js';

export type SchemaResourceLike = Pick<ResourceSpec, 'name' | 'output'> & {
  extract?: ResourceSpec['extract'];
  /** File Resources declare incrementality here instead of `extract.incremental`. */
  replication?: { method: string };
  load?: {
    defaults?: {
      schema_behavior?: SchemaBehavior;
    };
  };
};

/**
 * Resolve load strategy from resource config and runtime options.
 *
 * Priority: explicit YAML override > --full-refresh flag > file `incremental_append` > inference
 * from incremental + PKs > full_refresh.
 */
function resolveLoadStrategy(
  resource: SchemaResourceLike,
  primaryKeys: Set<string>,
  options?: { fullRefresh?: boolean }
): LoadStrategy {
  if (resource.extract?.table?.load_strategy) {
    return resource.extract.table.load_strategy;
  }
  if (options?.fullRefresh) {
    return 'full_refresh';
  }
  // A file run emits only new or changed files, so replacing the table would drop earlier files.
  if (resource.replication?.method === 'incremental_append') {
    return 'append';
  }
  const extract = resource.extract;
  if (extract && 'incremental' in extract && extract.incremental) {
    return primaryKeys.size > 0 ? 'merge' : 'append';
  }
  return 'full_refresh';
}

export function buildSchemaColumns(resource: SchemaResourceLike): SchemaColumn[] {
  const primaryKeys = new Set(resource.extract?.table?.primary_key ?? []);
  return Object.entries(resource.output).map(([name, field]) => ({
    name,
    type: field.type,
    ...(primaryKeys.has(name) ? { primary_key: true } : {}),
  }));
}

export function buildSchemaMessage(
  resource: SchemaResourceLike,
  options?: { fullRefresh?: boolean; defaultSchemaBehavior?: SchemaBehavior }
): SchemaMessage {
  const primaryKeys = new Set(resource.extract?.table?.primary_key ?? []);
  const loadStrategy = resolveLoadStrategy(resource, primaryKeys, options);

  const extractConfig = resource.extract;
  const cursorField =
    extractConfig && 'incremental' in extractConfig
      ? extractConfig.incremental?.cursor_field
      : undefined;

  const partitionBy = resource.extract?.table?.partition_by;
  // Resource-level load config replaces the project default as a whole. An
  // explicit `load: {}` therefore intentionally does not inherit this value.
  const schemaBehavior =
    resource.load !== undefined
      ? resource.load.defaults?.schema_behavior
      : options?.defaultSchemaBehavior;

  return {
    _v: PROTOCOL_VERSION,
    type: 'SCHEMA',
    stream: resource.name,
    schema: {
      columns: buildSchemaColumns(resource),
    },
    key_properties: [...primaryKeys].map(String),
    load_strategy: loadStrategy,
    ...(schemaBehavior ? { schema_behavior: schemaBehavior } : {}),
    ...(cursorField ? { cursor_field: cursorField } : {}),
    ...(partitionBy ? { partition_by: partitionBy } : {}),
  };
}
