import { getResources, getSource } from '@bobsled-inc/integrations';
import { stringify as stringifyYaml } from 'yaml';

import type { IntegrationResource } from '@bobsled-inc/integrations';

import { modelPackageDefinitions } from './definitions/index.js';
import { buildSourceColumn, buildStagingColumn, renameStagingColumn } from './normalizers.js';
import {
  buildSourceTableName,
  integrationModelPath,
  integrationMetadataPath,
  integrationSourcePath,
  rawSourceName,
  singularizeName,
  stagingModelName,
} from './utils.js';

import type {
  DataTestSpec,
  GeneratedFile,
  ModelPackage,
  ModelPackageManifest,
  ModelSpecFile,
  MetricSpecFile,
  PackageBuildOptions,
  ResourceOutputField,
  ResourceSpecLike,
  RelationshipSpecFile,
  SourceSpecFile,
} from './types.js';

function compositeKeyUniquenessTest(columns: string[]): DataTestSpec {
  if (columns.length === 0) {
    throw new Error('compositeKeyUniquenessTest requires at least one column');
  }
  const selectColumns = columns.join(', ');
  return {
    type: 'custom',
    sql: `SELECT ${selectColumns}, COUNT(*) AS duplicate_count FROM {name} GROUP BY ${selectColumns} HAVING COUNT(*) > 1`,
  };
}

interface ResourceContext {
  resourceName: string;
  sourceName: string;
  stagingName: string;
  sourceSpec: SourceSpecFile;
  stagingSpec: ModelSpecFile;
  stagedPrimaryKeys: string[];
}

const DEFAULT_RAW_SCHEMA = 'raw';
const DEFAULT_SOURCES_DIR = 'sources';
const DEFAULT_MODELS_DIR = 'models';
const DEFAULT_METRICS_DIR = 'metrics';
const DEFAULT_RELATIONSHIPS_DIR = 'relationships';

export function getModelPackageDefinition(name: string): ModelPackageManifest {
  const definition = modelPackageDefinitions.find((candidate) => candidate.name === name);
  if (!definition) {
    const available = modelPackageDefinitions.map((candidate) => candidate.name).join(', ');
    throw new Error(`Unknown model package "${name}". Available: ${available}`);
  }
  return definition;
}

export function buildModelPackage(
  definition: ModelPackageManifest,
  options: PackageBuildOptions = {}
): ModelPackage {
  const rawSchema = options.rawSchema ?? DEFAULT_RAW_SCHEMA;
  const sourceDir = options.sourceDir ?? DEFAULT_SOURCES_DIR;
  const modelDir = options.modelDir ?? DEFAULT_MODELS_DIR;
  const metricDir = options.metricDir ?? DEFAULT_METRICS_DIR;
  const relationshipDir = options.relationshipDir ?? DEFAULT_RELATIONSHIPS_DIR;
  const connection = definition.connection ?? definition.name;
  const defaultTransport = getSource(definition.name).spec.default_transport;

  const resources = getResources(definition.name)
    .flatMap((entry) => {
      const resource = toResourceSpecLike(entry, defaultTransport);
      return resource ? [resource] : [];
    })
    .filter((resource) =>
      definition.includeResources ? definition.includeResources.includes(resource.name) : true
    );

  if (resources.length === 0) {
    throw new Error(
      `Model package "${definition.name}" resolved zero resources. Check that the integration has published resource specs.`
    );
  }

  if (definition.includeResources) {
    const resolvedNames = new Set(resources.map((r) => r.name));
    const missing = definition.includeResources.filter((name) => !resolvedNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Model package "${definition.name}" is missing requested resources: ${missing.join(', ')}`
      );
    }
  }

  const preliminaryContexts = resources.map((resource) =>
    buildPreliminaryContext(definition.name, connection, rawSchema, resource)
  );
  const referenceIndex = buildReferenceIndex(preliminaryContexts);
  const resourceContexts = preliminaryContexts.map((context) =>
    finalizeResourceContext(context, referenceIndex)
  );

  const files: GeneratedFile[] = [
    ...resourceContexts.map((context) => ({
      path: integrationSourcePath(sourceDir, definition.name, context.resourceName),
      content: stringifySpec(context.sourceSpec),
      kind: 'source' as const,
    })),
    ...resourceContexts.map((context) => ({
      path: integrationModelPath(modelDir, definition.name, context.stagingName),
      content: stringifySpec(context.stagingSpec),
      kind: 'model' as const,
    })),
    ...definition.marts.map((spec) => ({
      path: integrationModelPath(modelDir, definition.name, spec.name),
      content: stringifySpec(spec),
      kind: 'model' as const,
    })),
    ...definition.metrics.map((spec) => ({
      path: integrationMetadataPath(metricDir, definition.name, spec.name),
      content: stringifySpec(spec),
      kind: 'metric' as const,
    })),
    ...definition.relationships.map((spec) => ({
      path: integrationMetadataPath(relationshipDir, definition.name, spec.name),
      content: stringifySpec(spec),
      kind: 'relationship' as const,
    })),
  ];

  return {
    name: definition.name,
    displayName: definition.displayName,
    description: definition.description,
    connection,
    tags: definition.tags,
    resourceNames: resourceContexts.map((context) => context.resourceName),
    sourceSpecs: resourceContexts.map((context) => context.sourceSpec),
    stagingSpecs: resourceContexts.map((context) => context.stagingSpec),
    martSpecs: definition.marts,
    metricSpecs: definition.metrics,
    relationshipSpecs: definition.relationships,
    files,
  };
}

function stringifySpec(
  spec: SourceSpecFile | ModelSpecFile | MetricSpecFile | RelationshipSpecFile
): string {
  return stringifyYaml(spec, {
    lineWidth: 0,
    minContentWidth: 0,
  });
}

interface PreliminaryResourceContext {
  resourceName: string;
  sourceName: string;
  stagingName: string;
  sourceSpec: SourceSpecFile;
  primaryKeySourceNames: string[];
  renamedColumns: Map<string, string>;
  outputFields: Array<[string, ResourceOutputField]>;
}

function buildPreliminaryContext(
  integrationName: string,
  connection: string,
  rawSchema: string,
  resource: ResourceSpecLike
): PreliminaryResourceContext {
  const outputFields = Object.entries(resource.output ?? {});
  if (outputFields.length === 0) {
    throw new Error(
      `Integration resource "${integrationName}/${resource.name}" has no output fields`
    );
  }

  const sourceName = rawSourceName(resource.name);
  const stagingName = stagingModelName(integrationName, resource.name);
  const primaryKeySourceNames =
    resource.extract?.table?.primary_key && resource.extract.table.primary_key.length > 0
      ? resource.extract.table.primary_key
      : (() => {
          throw new Error(
            `Integration resource "${integrationName}/${resource.name}" has no primary key defined in extract.table.primary_key`
          );
        })();
  const renamedColumns = new Map<string, string>();

  for (const [fieldName, field] of outputFields) {
    renamedColumns.set(
      fieldName,
      renameStagingColumn(resource.name, fieldName, field.type, field.description)
    );
  }

  const sourceSpec: SourceSpecFile = {
    spec_version: '0.2',
    name: sourceName,
    type: 'source',
    source_type: 'warehouse_table',
    connection,
    table: buildSourceTableName(
      rawSchema,
      integrationName,
      resource.tableResourceName ?? resource.name
    ),
    description: `Raw ${integrationName} ${resource.name} records as extracted by Bobsled Core.`,
    trust_tier: 'bronze',
    schema: {
      columns: outputFields.map(([fieldName, field]) => buildSourceColumn(fieldName, field)),
    },
  };

  return {
    resourceName: resource.name,
    sourceName,
    stagingName,
    sourceSpec,
    primaryKeySourceNames,
    renamedColumns,
    outputFields,
  };
}

function buildReferenceIndex(contexts: PreliminaryResourceContext[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const context of contexts) {
    const stagedPrimaryKeys = context.primaryKeySourceNames.map(
      (fieldName) => context.renamedColumns.get(fieldName) ?? fieldName
    );
    if (stagedPrimaryKeys.length !== 1) continue;
    const primaryKey = stagedPrimaryKeys[0];
    if (!primaryKey) continue;
    index.set(primaryKey, `${context.stagingName}.${primaryKey}`);
  }

  return index;
}

function finalizeResourceContext(
  context: PreliminaryResourceContext,
  referenceIndex: Map<string, string>
): ResourceContext {
  const stagedPrimaryKeys = context.primaryKeySourceNames.map(
    (fieldName) => context.renamedColumns.get(fieldName) ?? fieldName
  );

  const stagingColumns = context.outputFields.map(([fieldName, field]) => {
    const targetFieldName = context.renamedColumns.get(fieldName) ?? fieldName;
    const isPrimaryKey = stagedPrimaryKeys.length === 1 && stagedPrimaryKeys[0] === targetFieldName;
    const reference = inferReference(
      targetFieldName,
      context.resourceName,
      context.stagingName,
      referenceIndex
    );

    return buildStagingColumn(fieldName, targetFieldName, field, isPrimaryKey, reference);
  });

  if (stagedPrimaryKeys.length > 1) {
    for (const column of stagingColumns) {
      if (stagedPrimaryKeys.includes(column.name)) {
        column.not_null = true;
      }
    }
  }

  const grain = stagedPrimaryKeys.length === 1 ? stagedPrimaryKeys[0]! : stagedPrimaryKeys;

  const stagingSpec: ModelSpecFile = {
    spec_version: '0.2',
    name: context.stagingName,
    type: 'model',
    description: `Staged ${context.resourceName} records from the ${context.sourceSpec.connection} integration.`,
    grain,
    source: {
      ref: `${context.sourceSpec.connection}.${context.sourceName}`,
    },
    columns: stagingColumns,
    tags: [context.sourceSpec.connection, 'staging'],
    trust_tier: 'silver',
    tests:
      stagedPrimaryKeys.length > 1 ? [compositeKeyUniquenessTest(stagedPrimaryKeys)] : undefined,
    materialization: {
      type: 'view',
    },
  };

  return {
    resourceName: context.resourceName,
    sourceName: context.sourceName,
    stagingName: context.stagingName,
    sourceSpec: context.sourceSpec,
    stagingSpec,
    stagedPrimaryKeys,
  };
}

function toResourceSpecLike(
  entry: IntegrationResource,
  defaultTransport: string | undefined
): ResourceSpecLike | undefined {
  const { resource } = entry;
  const rawResource = resource as { entity?: unknown; via?: unknown };
  const entity = typeof rawResource.entity === 'string' ? rawResource.entity : undefined;
  const via = typeof rawResource.via === 'string' ? rawResource.via : undefined;
  if (entity && via && defaultTransport !== undefined && via !== defaultTransport) {
    return undefined;
  }

  const logicalName = entity ?? resource.name;
  const output: Record<string, ResourceOutputField> = {};
  if (resource.output) {
    for (const [key, field] of Object.entries(resource.output)) {
      output[key] = {
        type: field.type,
        description: field.description,
        unit: field.unit,
        path: field.path,
      };
    }
  }
  return {
    name: logicalName,
    ...(logicalName !== resource.name ? { tableResourceName: resource.name } : {}),
    description: resource.description ?? '',
    output,
    extract: resource.extract,
  };
}

function inferReference(
  columnName: string,
  resourceName: string,
  stagingName: string,
  referenceIndex: Map<string, string>
): string | undefined {
  if (columnName === `${singularizeName(resourceName)}_id`) return undefined;
  const reference = referenceIndex.get(columnName);
  if (reference?.startsWith(`${stagingName}.`)) return undefined;
  return reference;
}
