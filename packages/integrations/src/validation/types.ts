/**
 * Compact, generated metadata used by Bobsled Core's project validation path.
 *
 * This is intentionally independent of the discovery/probe catalog: it keeps
 * concrete resource specs instead of merging transport variants, and contains
 * no extractor runtime types.
 */

export const INTEGRATION_VALIDATION_CATALOG_SCHEMA_VERSION = 1;

export interface IntegrationValidationAuthSetup {
  env: string;
  description: string;
  docs_url?: string;
}

export interface IntegrationValidationForEach {
  /** Authored resource spec name, not a canonical entity alias. */
  resource: string;
  /** Every `extract.for_each` target input, in authored declaration order. */
  bound_inputs: string[];
}

export interface IntegrationValidationResource {
  /** Concrete YAML `name:` used by the extractor. */
  name: string;
  /** Canonical YAML `entity:`, or `name` when it is omitted. */
  entity: string;
  /** Authored YAML `via:`. Omitted when the resource relies on the source default. */
  via?: string;
  input_names: string[];
  output_fields: string[];
  embedding_candidates: string[];
  incremental: boolean;
  replication_method?: string;
  for_each?: IntegrationValidationForEach;
}

export interface IntegrationValidationSource {
  name: string;
  auth_setup: IntegrationValidationAuthSetup[];
  transports: string[];
  default_transport: string;
  warehouses?: Record<string, string>;
  resources: IntegrationValidationResource[];
}

export interface IntegrationValidationCatalog {
  schema_version: typeof INTEGRATION_VALIDATION_CATALOG_SCHEMA_VERSION;
  sources: IntegrationValidationSource[];
}
