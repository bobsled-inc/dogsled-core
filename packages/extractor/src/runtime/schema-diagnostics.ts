import * as path from 'node:path';

import type { JsonObject, SchemaBehavior } from '@bobsled-inc/protocol';

export interface SchemaBehaviorResourceLike {
  name: string;
  load?: {
    defaults?: {
      schema_behavior?: SchemaBehavior;
    };
  };
}

export interface ResourceProgressMetadata {
  effective_resource_path: string;
  schema_column_count: number;
}

export interface SchemaBehaviorDefaultWarning {
  event: 'schema_behavior.project_default_replaced';
  message: string;
  attributes: JsonObject;
}

interface SchemaWarningLogger {
  log(level: 'warn', message: string, event: string, attributes: JsonObject): Promise<void>;
}

/**
 * Describe the project schema-behavior default that a resource-level `load`
 * block shadows. The resource block intentionally replaces the project block,
 * so omitting the nested behavior makes the loader fall back to `evolve`.
 */
export function buildSchemaBehaviorDefaultWarning(
  resource: SchemaBehaviorResourceLike,
  projectDefault: SchemaBehavior | undefined
): SchemaBehaviorDefaultWarning | undefined {
  if (
    projectDefault === undefined ||
    resource.load === undefined ||
    resource.load.defaults?.schema_behavior !== undefined
  ) {
    return undefined;
  }

  return {
    event: 'schema_behavior.project_default_replaced',
    message:
      `Resource "${resource.name}" defines a load block without ` +
      `load.defaults.schema_behavior. Resource-level load replaces project default ` +
      `schema_behavior "${projectDefault}" rather than merging; the loader falls back ` +
      `to "evolve" unless an explicit loader or stream schema_behavior override is provided.`,
    attributes: {
      resource: resource.name,
      project_default_schema_behavior: projectDefault,
      replacement_semantics: 'resource_load_replaces_project_default',
      loader_fallback_schema_behavior: 'evolve',
      fallback_can_be_overridden: true,
    },
  };
}

export async function logSchemaBehaviorDefaultWarning(
  logger: SchemaWarningLogger,
  resource: SchemaBehaviorResourceLike,
  projectDefault: SchemaBehavior | undefined
): Promise<void> {
  const warning = buildSchemaBehaviorDefaultWarning(resource, projectDefault);
  if (warning) {
    await logger.log('warn', warning.message, warning.event, warning.attributes);
  }
}

export function getResourceProgressMetadata(
  resource: { output?: Record<string, unknown> },
  filePath: string
): ResourceProgressMetadata {
  return {
    effective_resource_path: path.resolve(filePath),
    schema_column_count: Object.keys(resource.output ?? {}).length,
  };
}
