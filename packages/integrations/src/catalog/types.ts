/**
 * Catalog manifest — types, schema version, and JSON Schema constant.
 *
 * Lives alongside `manifest.ts` (build logic). Kept in its own module so the
 * build-logic file stays comfortably under Dogsled's per-file size guideline.
 */

import type { CatalogProbeApi, CatalogProbeAuth, CatalogProbeInputField } from './probe-types.js';

export type {
  CatalogProbeApi,
  CatalogProbeAuth,
  CatalogProbeDefinition,
  CatalogProbeFieldType,
  CatalogProbeHttpMethod,
  CatalogProbeInputField,
  CatalogProbeJsonValue,
  CatalogProbeResource,
  CatalogProbeSource,
  CatalogProbeTransport,
} from './probe-types.js';

export const CATALOG_MANIFEST_SCHEMA_VERSION = 4;

export type CatalogSourceType = 'api' | 'mcp' | 'db';
export type CatalogColumnType =
  'string' | 'integer' | 'number' | 'boolean' | 'timestamp' | 'array' | 'object';
export type CatalogIncrementalStrategy = 'cursor' | 'server_filter' | 'full_refresh';

export interface CatalogColumn {
  name: string;
  type: CatalogColumnType;
  description?: string;
}

export interface CatalogAuthSetupEntry {
  env: string;
  description: string;
  docs_url?: string;
}

export interface CatalogTransportConfig {
  id: string;
  base_url?: string;
  headers?: Record<string, string>;
  /**
   * Headers sent only when every `${{ env.* }}` / `${{ secrets.* }}` reference
   * resolves to a non-empty value. (catalog manifest schema_version 4+)
   */
  optional_headers?: Record<string, string>;
  auth?: CatalogProbeAuth;
  timeout_ms?: number;
}

/**
 * Request input metadata is shared with the probe definition. Keeping this
 * alias means the runtime catalog and external probe definitions validate the
 * same typed constraints.
 */
export type CatalogInputField = CatalogProbeInputField;

/** One transport variant of a resource. Multi-transport resources (e.g.
 * Linear's `issues` ships `graphql` + `mcp`) emit one variant per `.yml`
 * file under `resources/<entity>/`. Single-file resources emit a single
 * variant using the source's `default_transport`. */
export interface CatalogResourceTransportVariant {
  via: string;
  /** HTTP-style transports (graphql, rest). Omitted for `mcp` / `db`. */
  api?: CatalogProbeApi;
  /** MCP-style transports. Omitted for HTTP / db. */
  tool?: { tool_name: string };
  /** Typed request inputs for this transport variant, when declared. */
  input?: Record<string, CatalogInputField>;
  columns: CatalogColumn[];
}

export interface CatalogResource {
  /** Canonical entity name (deduped across transports). For multi-transport
   * resources, this is the YAML `entity:` field, not the `name:` field
   * (which is per-transport: `issues_graphql`, `issues_mcp`). */
  name: string;
  description?: string;
  transports: string[];
  default_transport: string;
  primary_key: string[];
  health_check?: { preferred?: boolean };
  input?: Record<string, CatalogInputField>;
  incremental?: {
    strategy: CatalogIncrementalStrategy;
    cursor_field?: string;
  };
  /**
   * Canonical entity name of the sibling resource this one fans out over via
   * `extract.for_each.resource` (resolved from the parent's per-transport spec
   * name to its catalog entity name). Lets consumers validate and schedule a
   * bundled-catalog child alongside its parent when the resource YAML is not
   * present in the user's project. Set from whichever transport variant
   * declares for_each; absent on resources without for_each.
   * (catalog manifest schema_version 2+)
   */
  for_each_parent?: string;
  variants: CatalogResourceTransportVariant[];
}

export interface CatalogSource {
  name: string;
  display_name: string;
  category: string;
  source_type: CatalogSourceType;
  tags: string[];
  transports: string[];
  default_transport: string;
  transport_configs: CatalogTransportConfig[];
  /** Pulled from the default transport's auth block. */
  auth_type: string;
  /**
   * Pulled from the default transport's `base_url` field. Present for HTTP-style
   * transports (rest, graphql); undefined for `mcp` / `db` sources whose
   * transports address their target via `tool:` / `connection:` blocks instead.
   *
   * May contain `${{ ... }}` template placeholders (e.g. Shopify's
   * `https://${{ input.shop }}.myshopify.com`); downstream consumers are
   * responsible for substitution.
   */
  base_url?: string;
  /** Direct passthrough of `meta.yml.auth_setup`. */
  auth_setup: CatalogAuthSetupEntry[];
  /**
   * Env var names a self-describing `custom_api` source declares inline via
   * `source.yml` `auth_env_vars`. Present (non-empty) only for sources that use
   * the inline declaration instead of a `meta.yml` auth_setup block.
   */
  auth_env_vars?: string[];
  docs_url: string;
  resource_count: number;
  resources: CatalogResource[];
}

export interface CatalogManifestSummary {
  source_count: number;
  resource_count: number;
  api_source_count: number;
  mcp_source_count: number;
  db_source_count: number;
}

export interface CatalogManifest {
  schema_version: typeof CATALOG_MANIFEST_SCHEMA_VERSION;
  summary: CatalogManifestSummary;
  sources: CatalogSource[];
}

export const CATALOG_MANIFEST_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Dogsled Catalog Manifest',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'summary', 'sources'],
  properties: {
    schema_version: { const: CATALOG_MANIFEST_SCHEMA_VERSION },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source_count',
        'resource_count',
        'api_source_count',
        'mcp_source_count',
        'db_source_count',
      ],
      properties: {
        source_count: { type: 'integer', minimum: 0 },
        resource_count: { type: 'integer', minimum: 0 },
        api_source_count: { type: 'integer', minimum: 0 },
        mcp_source_count: { type: 'integer', minimum: 0 },
        db_source_count: { type: 'integer', minimum: 0 },
      },
    },
    sources: {
      type: 'array',
      items: { $ref: '#/$defs/source' },
    },
  },
  $defs: {
    source: {
      type: 'object',
      additionalProperties: false,
      required: [
        'name',
        'display_name',
        'category',
        'source_type',
        'tags',
        'transports',
        'default_transport',
        'transport_configs',
        'auth_type',
        'auth_setup',
        'docs_url',
        'resource_count',
        'resources',
      ],
      properties: {
        name: { type: 'string', minLength: 1 },
        display_name: { type: 'string', minLength: 1 },
        category: { type: 'string', minLength: 1 },
        source_type: { enum: ['api', 'mcp', 'db'] },
        tags: { type: 'array', items: { type: 'string' } },
        transports: { type: 'array', items: { type: 'string' } },
        default_transport: { type: 'string', minLength: 1 },
        transport_configs: { type: 'array', items: { $ref: '#/$defs/transport_config' } },
        auth_type: { type: 'string', minLength: 1 },
        base_url: { type: 'string', minLength: 1 },
        auth_setup: { type: 'array', items: { $ref: '#/$defs/auth_setup_entry' } },
        auth_env_vars: {
          type: 'array',
          items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        },
        docs_url: { type: 'string', minLength: 1 },
        resource_count: { type: 'integer', minimum: 0 },
        resources: { type: 'array', items: { $ref: '#/$defs/resource' } },
      },
    },
    transport_config: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        base_url: { type: 'string', minLength: 1 },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        optional_headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        auth: {
          $ref: '#/$defs/probe_auth',
        },
        timeout_ms: { type: 'integer', minimum: 1 },
      },
    },
    auth_setup_entry: {
      type: 'object',
      additionalProperties: false,
      required: ['env', 'description'],
      properties: {
        env: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        docs_url: { type: 'string' },
      },
    },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'transports', 'default_transport', 'primary_key', 'variants'],
      properties: {
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        transports: { type: 'array', items: { type: 'string' } },
        default_transport: { type: 'string', minLength: 1 },
        primary_key: { type: 'array', items: { type: 'string' } },
        health_check: {
          type: 'object',
          additionalProperties: false,
          properties: {
            preferred: { type: 'boolean' },
          },
        },
        input: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/probe_input' },
        },
        incremental: { $ref: '#/$defs/incremental' },
        for_each_parent: { type: 'string', minLength: 1 },
        variants: { type: 'array', items: { $ref: '#/$defs/variant' } },
      },
    },
    incremental: {
      type: 'object',
      additionalProperties: false,
      required: ['strategy'],
      properties: {
        strategy: { enum: ['cursor', 'server_filter', 'full_refresh'] },
        cursor_field: { type: 'string' },
      },
    },
    variant: {
      type: 'object',
      additionalProperties: false,
      required: ['via', 'columns'],
      properties: {
        via: { type: 'string', minLength: 1 },
        api: { $ref: '#/$defs/probe_api' },
        tool: {
          type: 'object',
          additionalProperties: false,
          required: ['tool_name'],
          properties: {
            tool_name: { type: 'string', minLength: 1 },
          },
        },
        input: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/probe_input' },
        },
        columns: { type: 'array', items: { $ref: '#/$defs/column' } },
      },
    },
    column: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'type'],
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { enum: ['string', 'integer', 'number', 'boolean', 'timestamp', 'array', 'object'] },
        description: { type: 'string' },
      },
    },
    probe_api: {
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'method'],
      properties: {
        endpoint: { type: 'string', minLength: 1 },
        method: { enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        timeout_ms: { type: 'integer', minimum: 1 },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        query_params: { type: 'object', additionalProperties: { type: 'string' } },
        request_body: { $ref: '#/$defs/probe_json' },
        auth: { $ref: '#/$defs/probe_auth' },
      },
    },
    probe_input: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: {
          enum: ['string', 'number', 'integer', 'boolean', 'timestamp', 'array', 'object'],
        },
        required: { type: 'boolean' },
        description: { type: 'string' },
        default: { $ref: '#/$defs/probe_json' },
        enum: { type: 'array', items: { type: 'string' } },
        minimum: { type: 'number' },
        maximum: { type: 'number' },
        minLength: { type: 'integer', minimum: 0 },
        maxLength: { type: 'integer', minimum: 0 },
        minItems: { type: 'integer', minimum: 0 },
        maxItems: { type: 'integer', minimum: 0 },
        pattern: { type: 'string' },
        items: { $ref: '#/$defs/probe_input' },
        properties: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/probe_input' },
        },
      },
    },
    probe_json: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        { type: 'array', items: { $ref: '#/$defs/probe_json' } },
        { type: 'object', additionalProperties: { $ref: '#/$defs/probe_json' } },
      ],
    },
    probe_auth: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          enum: ['none', 'bearer', 'api-key', 'basic', 'oauth2', 'custom-token', 'aws-sigv4'],
        },
      },
      additionalProperties: true,
    },
  },
} as const;
