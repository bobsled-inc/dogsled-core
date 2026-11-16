import { INTEGRATION_VALIDATION_CATALOG } from '@bobsled-inc/integrations/validation';

export interface ValidationCatalogAuthSetup {
  env: string;
  description: string;
  docs_url?: string;
}

export interface ValidationCatalogForEach {
  resource: string;
  bound_inputs: string[];
}

export interface ValidationCatalogResourceSnapshot {
  name: string;
  entity: string;
  via?: string;
  input_names: string[];
  output_fields: string[];
  embedding_candidates: string[];
  incremental: boolean;
  replication_method?: string;
  for_each?: ValidationCatalogForEach;
}

export interface ValidationCatalogSourceSnapshot {
  name: string;
  auth_setup: ValidationCatalogAuthSetup[];
  transports: string[];
  default_transport: string;
  warehouses?: Record<string, string>;
  resources: ValidationCatalogResourceSnapshot[];
}

export interface ValidationCatalogSnapshot {
  schema_version: number;
  sources: ValidationCatalogSourceSnapshot[];
}

export interface ValidationCatalogResourceSpec {
  name: string;
  input?: Record<string, unknown>;
  extract?: {
    incremental?: boolean;
    for_each?: {
      resource: string;
      bindings: Array<{ input: string }>;
    };
  };
  replication?: { method?: string };
  output?: Record<string, { embedding_candidate?: boolean }>;
}

export interface ValidationEntityVariant {
  name: string;
  via: string | undefined;
}

/**
 * The metadata-only integration surface consumed by Bobsled Core project validation.
 * Implementations must throw from `getIntegration`/`getResources` for an
 * unknown source and return empty arrays for unknown entities.
 */
export interface ValidationCatalog {
  getIntegration: (name: string) => {
    meta: { auth_setup?: ValidationCatalogAuthSetup[] };
    resource_names: string[];
    transports: Array<{ id: string }>;
    default_transport?: string;
    warehouses?: Record<string, string>;
  };
  getResources: (name: string) => Array<{ resource: ValidationCatalogResourceSpec }>;
  listEntities: (sourceName: string) => string[];
  getEntityVariants: (sourceName: string, entity: string) => ValidationEntityVariant[];
}

function normalizeSnapshot(
  snapshot: ValidationCatalogSnapshot | readonly ValidationCatalogSourceSnapshot[]
): readonly ValidationCatalogSourceSnapshot[] {
  return Array.isArray(snapshot) ? snapshot : (snapshot as ValidationCatalogSnapshot).sources;
}

function resourceSpecFromSnapshot(
  resource: ValidationCatalogResourceSnapshot
): ValidationCatalogResourceSpec {
  const embeddingCandidates = new Set(resource.embedding_candidates);
  return {
    name: resource.name,
    input: Object.fromEntries(resource.input_names.map((name) => [name, {}])),
    output: Object.fromEntries(
      resource.output_fields.map((name) => [
        name,
        embeddingCandidates.has(name) ? { embedding_candidate: true } : {},
      ])
    ),
    ...(resource.incremental || resource.for_each
      ? {
          extract: {
            ...(resource.incremental ? { incremental: true } : {}),
            ...(resource.for_each
              ? {
                  for_each: {
                    resource: resource.for_each.resource,
                    bindings: resource.for_each.bound_inputs.map((input) => ({ input })),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(resource.replication_method
      ? { replication: { method: resource.replication_method } }
      : {}),
  };
}

/** Build Bobsled Core's legacy narrow validation interface from a generated snapshot. */
export function createValidationCatalog(
  snapshot: ValidationCatalogSnapshot | readonly ValidationCatalogSourceSnapshot[]
): ValidationCatalog {
  const sources = normalizeSnapshot(snapshot);
  const byName = new Map(sources.map((source) => [source.name, source]));
  const requireSource = (name: string): ValidationCatalogSourceSnapshot => {
    const source = byName.get(name);
    if (!source) throw new Error(`Source "${name}" not found`);
    return source;
  };

  return {
    getIntegration(name) {
      const source = requireSource(name);
      return {
        meta: { auth_setup: source.auth_setup },
        resource_names: source.resources.map((resource) => resource.name),
        transports: source.transports.map((transport) => ({ id: transport })),
        default_transport: source.default_transport,
        warehouses: source.warehouses,
      };
    },
    getResources(name) {
      return requireSource(name).resources.map((resource) => ({
        resource: resourceSpecFromSnapshot(resource),
      }));
    },
    listEntities(sourceName) {
      const source = requireSource(sourceName);
      return [...new Set(source.resources.map((resource) => resource.entity))].sort((a, b) =>
        a.localeCompare(b)
      );
    },
    getEntityVariants(sourceName, entity) {
      const source = byName.get(sourceName);
      if (!source) return [];
      return source.resources
        .filter((resource) => resource.entity === entity)
        .map((resource) => ({ name: resource.name, via: resource.via }));
    },
  };
}

/** Bundler-safe built-in validation metadata generated from integration YAML. */
export const BUILT_IN_VALIDATION_CATALOG: ValidationCatalog = createValidationCatalog(
  INTEGRATION_VALIDATION_CATALOG
);

/** @deprecated Use {@link ValidationCatalog}. */
export type IntegrationsLib = ValidationCatalog;
