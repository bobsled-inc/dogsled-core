import * as fs from 'node:fs';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import {
  buildIndexedSourceRegistry,
  type SourceColumnRegistry,
  type SourceEntryRegistry,
  type SourceRegistry,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import type { FieldMetadata } from '@bobsled-inc/protocol';
import { loadIndexedIntegrations } from '@bobsled-inc/connections';
import {
  loadProjectConfig,
  resolveConfig,
  resolveIndexedIntegrationByHandle,
  resolveIndexedIntegrations,
  selectActiveIntegration,
  type ResolvedIntegration,
  type ResolvedProjectConfig,
} from '@bobsled-inc/model-spec/project';
import { resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';

import { discoverResolutionSpecs, resolveResolutionSpec } from '../compiler/identity/parser.js';
import type {
  ResolvedResolutionSpec,
  SourceFieldMetadataRegistry,
} from '../compiler/identity/types.js';

export interface EntityGraphProjectOptions {
  cwd?: string;
  entityNames?: string[];
  integration?: string;
  dialect?: string;
  schema?: string;
  verbose?: boolean;
  quiet?: boolean;
  /**
   * Host-injected, pre-resolved integration context. When set, the loader uses
   * it verbatim and skips the on-disk `integrations/*.yml` read + strict
   * `IntegrationFileSchema` validation — the generic equivalent of model-spec's
   * `loadProject({ skipIntegrations: true })` + manual `project.integrations`
   * injection. Lets an embedding host (e.g. an orchestrator that already holds
   * the resolved connection in memory) drive runs against integration shapes
   * the on-disk schema would reject. This option knows nothing about how the
   * host resolved the integration; it just accepts the resolved result.
   */
  resolvedIntegration?: ResolvedIntegration;
}

export interface EntityGraphProjectContext {
  cwd: string;
  config: ResolvedProjectConfig;
  specs: ResolvedResolutionSpec[];
  dialect: SupportedDialect;
  targetSchema: string;
  entityGraphDir: string;
  mdmDir: string;
  verbose: boolean;
  quiet: boolean;
  warnings: string[];
  integration?: ResolvedIntegration;
}

function assertResolutionMode(
  options: Pick<EntityGraphProjectOptions, 'integration' | 'dialect' | 'resolvedIntegration'>
) {
  if (options.dialect && (options.integration || options.resolvedIntegration)) {
    throw new CommandError(
      '--dialect cannot be combined with --integration. The integration determines the dialect; use --schema to override only the output schema.',
      2
    );
  }
}

function loadSourceRegistry(index: ProjectIndex): {
  sourceRegistry: SourceRegistry;
  columnRegistry?: SourceColumnRegistry;
  fieldMetadataRegistry?: SourceFieldMetadataRegistry;
} {
  const registryResult = buildIndexedSourceRegistry(index);
  if (!registryResult.ok) {
    throw new CommandError(registryResult.error, 2);
  }
  return {
    sourceRegistry: registryResult.registry,
    columnRegistry: registryResult.columnRegistry,
    fieldMetadataRegistry: buildFieldMetadataRegistry(registryResult.entryRegistry),
  };
}

function buildFieldMetadataRegistry(
  entryRegistry: SourceEntryRegistry
): SourceFieldMetadataRegistry {
  const metadata = new Map<string, Record<string, FieldMetadata>>();
  for (const [ref, entry] of entryRegistry) {
    const columns: Record<string, FieldMetadata> = {};
    for (const column of entry.columns) {
      if (columns[column.name]) {
        throw new CommandError(
          `Source ${ref} declares duplicate column '${column.name}'. Column names must be unique for entity-graph field metadata.`,
          2
        );
      }
      columns[column.name] = {
        name: column.name,
        type: column.type,
        ...(column.description !== undefined ? { description: column.description } : {}),
        ...(column.semantic_role !== undefined ? { semantic_role: column.semantic_role } : {}),
        ...(column.tags !== undefined ? { tags: column.tags } : {}),
        ...(column.unit !== undefined ? { unit: column.unit } : {}),
        ...(column.format !== undefined ? { format: column.format } : {}),
        ...(column.pii !== undefined ? { pii: column.pii } : {}),
        ...(column.enum_values !== undefined ? { enum_values: column.enum_values } : {}),
        ...(column.examples !== undefined ? { examples: column.examples } : {}),
        ...(column.references !== undefined ? { references: column.references } : {}),
        ...(column.business_rule !== undefined ? { business_rule: column.business_rule } : {}),
        ...(column.quality_notes !== undefined ? { quality_notes: column.quality_notes } : {}),
        ...(column.owner !== undefined ? { owner: column.owner } : {}),
        ...(column.deprecated !== undefined ? { deprecated: column.deprecated } : {}),
      };
    }
    metadata.set(ref, columns);
  }
  return metadata;
}

export async function loadEntityGraphProjectContext(
  options: EntityGraphProjectOptions = {}
): Promise<EntityGraphProjectContext> {
  assertResolutionMode(options);

  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];
  const index = resolveProjectIndex(cwd);
  const { config: projectConfig } = loadProjectConfig(cwd, { index });
  const baseConfig = resolveConfig({}, projectConfig);

  let integration: ResolvedIntegration | undefined;
  let resolvedConfig: ResolvedProjectConfig;

  if (options.resolvedIntegration) {
    // Host-injected, pre-resolved integration — use it verbatim and skip the
    // on-disk read + strict validation that `resolveIntegrationByHandle` /
    // `resolveActiveIntegration` would perform. Dialect and target schema come
    // from the injected integration exactly as they would from a disk-loaded
    // one; an explicit `--schema` still overrides the output schema.
    integration = options.resolvedIntegration;
    resolvedConfig = {
      ...baseConfig,
      dialect: integration.dialect,
      schema: options.schema ?? integration.targetSchema,
    };
  } else if (options.integration) {
    integration = resolveIndexedIntegrationByHandle(index, options.integration);
    resolvedConfig = {
      ...baseConfig,
      dialect: integration.dialect,
      schema: options.schema ?? integration.targetSchema,
    };
  } else if (!options.dialect) {
    if (loadIndexedIntegrations(index).size > 0) {
      integration = selectActiveIntegration(resolveIndexedIntegrations(index), undefined);
    }
    resolvedConfig = integration
      ? {
          ...baseConfig,
          dialect: integration.dialect,
          schema: options.schema ?? integration.targetSchema,
        }
      : resolveConfig({ schema: options.schema }, projectConfig);
  } else {
    resolvedConfig = resolveConfig(
      {
        dialect: options.dialect as SupportedDialect | undefined,
        schema: options.schema,
      },
      projectConfig
    );
  }

  const { sourceRegistry, columnRegistry, fieldMetadataRegistry } = loadSourceRegistry(index);

  const entityGraphDir = path.resolve(cwd, resolvedConfig.entityGraphDir);
  const relativeToCwd = path.relative(cwd, entityGraphDir);
  if (relativeToCwd.startsWith('..') || path.isAbsolute(relativeToCwd)) {
    throw new CommandError(
      `Invalid entity_graph_dir: ${resolvedConfig.entityGraphDir}. Path must stay within the project root.`,
      2
    );
  }
  if (!fs.existsSync(entityGraphDir) || !fs.statSync(entityGraphDir).isDirectory()) {
    throw new CommandError(
      `No ${resolvedConfig.entityGraphDir}/ directory found. Create it with resolution spec YAML files.`,
      2
    );
  }

  const parsedSpecs = discoverResolutionSpecs(entityGraphDir);
  if (parsedSpecs.length === 0) {
    throw new CommandError(`No resolution specs found in ${resolvedConfig.entityGraphDir}/.`, 2);
  }
  for (const parsed of parsedSpecs) {
    warnings.push(...(parsed.warnings ?? []));
  }

  const entityNames = options.entityNames ?? [];
  let specs = parsedSpecs.map((parsed) =>
    resolveResolutionSpec(
      parsed,
      sourceRegistry,
      resolvedConfig.dialect,
      resolvedConfig.schema,
      columnRegistry,
      fieldMetadataRegistry
    )
  );

  if (entityNames.length > 0) {
    specs = specs.filter(
      (spec) => entityNames.includes(spec.entity) || entityNames.includes(spec.name)
    );
    if (specs.length === 0) {
      throw new CommandError(`No resolution specs found matching: ${entityNames.join(', ')}`, 2);
    }
  }

  return {
    cwd,
    config: resolvedConfig,
    specs,
    dialect: resolvedConfig.dialect,
    targetSchema: resolvedConfig.schema,
    entityGraphDir,
    mdmDir: entityGraphDir,
    verbose: options.verbose ?? false,
    quiet: options.quiet ?? false,
    warnings,
    ...(integration ? { integration } : {}),
  };
}
