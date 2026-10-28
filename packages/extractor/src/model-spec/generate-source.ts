/**
 * Model Spec integration — auto-generate Model Spec source spec from extractor resource metadata.
 *
 * Type mapping: integer → NUMBER, string → VARCHAR, timestamp → TIMESTAMP,
 * boolean → BOOLEAN, number → FLOAT, array → VARIANT, object → VARIANT, vector → VECTOR.
 *
 * When the optional `embedConfig` is provided, embedding columns are appended
 * to the schema with `type: VECTOR`, `dimension`, and `embedded_from` provenance
 * pulled from the pipeline's `embed:` block. The model-spec compiler maps the
 * VECTOR type per-dialect at compile time (Snowflake VECTOR(FLOAT,N), BigQuery
 * ARRAY<FLOAT64>, DuckDB FLOAT[N], pgvector vector(N)).
 */

import YAML from 'yaml';

import type { ColumnType, ResourceSpec } from '../types/index.js';
import type { EmbeddedFrom, FieldMetadata, SemanticRole } from '@bobsled-inc/protocol';

const TYPE_MAP: Record<ColumnType, string> = {
  integer: 'NUMBER',
  string: 'VARCHAR',
  timestamp: 'TIMESTAMP',
  boolean: 'BOOLEAN',
  number: 'FLOAT',
  array: 'VARIANT',
  object: 'VARIANT',
  vector: 'VECTOR',
};

/**
 * Per-resource embed config resolved by the pipeline orchestrator from the
 * `embed:` block in `dogsled.yml`. Mirrors the shape carried in the runtime
 * SCHEMA message but flattened so the scaffold generator does not need to
 * know about the discriminated union over provider auth.
 */
export interface ResolvedResourceEmbedConfig {
  provider: string;
  model: string;
  dimension: number;
  distance_metric?: EmbeddedFrom['distance_metric'];
  fields: Array<{ field: string; as?: string }>;
}

/**
 * Embedder's output-column naming rule. Kept inline (rather than imported from
 * `@bobsled-inc/embedder`) so the extractor's build remains independent of the
 * embedder package — the rule is one line and the two locations are covered
 * by tests that share the same fixtures.
 */
function embeddingColumnName(field: string, alias?: string): string {
  return alias ?? `${field}_embedding`;
}

// ---------------------------------------------------------------------------
// Semantic role inference
// ---------------------------------------------------------------------------

type OutputMetadataKey = Exclude<keyof FieldMetadata, 'name' | 'type' | 'description'>;
type ResourceOutputField = ResourceSpec['output'][string];

interface ModelSpecColumnSpec extends Omit<Partial<FieldMetadata>, 'type'> {
  name: string;
  type: string;
  description: string;
  primary_key?: boolean;
  dimension?: number;
  embedded_from?: EmbeddedFrom;
}

const FIELD_METADATA_KEYS = [
  'semantic_role',
  'tags',
  'unit',
  'format',
  'pii',
  'enum_values',
  'examples',
  'references',
  'business_rule',
  'quality_notes',
  'owner',
  'deprecated',
  'embedding_candidate',
] satisfies OutputMetadataKey[];

const STRING_TYPES = new Set<ColumnType>(['string']);
const NUMERIC_TYPES = new Set<ColumnType>(['integer', 'number']);
const ID_NAMES = new Set(['id']);
const IDENTIFIER_NAMES = new Set([
  'uuid',
  'guid',
  'key',
  'code',
  'slug',
  'sku',
  'handle',
  'external_id',
  'external_key',
  'external_ref',
  'reference_id',
  'reference',
]);
const NAME_NAMES = new Set([
  'name',
  'full_name',
  'display_name',
  'first_name',
  'last_name',
  'company_name',
  'customer_name',
  'account_name',
]);
const ADDRESS_NAMES = new Set([
  'address',
  'address_1',
  'address_2',
  'street',
  'street_address',
  'city',
  'state',
  'province',
  'postal_code',
  'postcode',
  'zip',
  'zip_code',
  'country',
  'country_code',
]);
const EMAIL_NAMES = new Set(['email', 'email_address', 'primary_email']);
const PHONE_NAMES = new Set([
  'phone',
  'phone_number',
  'mobile',
  'mobile_phone',
  'cell_phone',
  'telephone',
  'fax',
]);
const URL_NAMES = new Set(['url', 'uri', 'website', 'site_url', 'homepage', 'web_url']);
const CURRENCY_NAMES = new Set([
  'currency',
  'currency_code',
  'iso_currency',
  'price',
  'amount',
  'total_amount',
  'revenue',
  'mrr',
  'arr',
]);
const COUNT_NAMES = new Set(['count', 'quantity', 'qty', 'num', 'number']);
const RATE_NAMES = new Set(['rate', 'ratio', 'percent', 'percentage', 'pct']);
const CATEGORICAL_NAMES = new Set(['title', 'label', 'description', 'status', 'type', 'category']);
const MEASURE_SUFFIXES = ['_amount', '_total', '_sum', '_score', '_value'];

function normalizeColumnName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasAnyToken(name: string, tokens: Set<string>): boolean {
  return name.split('_').some((token) => tokens.has(token));
}

/** Infer a semantic role from a column's name and type. */
export function inferSemanticRole(name: string, type: ColumnType): SemanticRole | undefined {
  const normalizedName = normalizeColumnName(name);

  if (
    (ID_NAMES.has(normalizedName) || normalizedName.endsWith('_id')) &&
    (type === 'integer' || type === 'string')
  ) {
    return 'entity_id';
  }

  if (
    (normalizedName.endsWith('_at') ||
      normalizedName.endsWith('_date') ||
      normalizedName.endsWith('_time') ||
      normalizedName === 'timestamp') &&
    type === 'timestamp'
  ) {
    return 'event_timestamp';
  }

  if (STRING_TYPES.has(type) && EMAIL_NAMES.has(normalizedName)) {
    return 'email';
  }

  if (STRING_TYPES.has(type) && PHONE_NAMES.has(normalizedName)) {
    return 'phone';
  }

  if (
    STRING_TYPES.has(type) &&
    (URL_NAMES.has(normalizedName) ||
      normalizedName.endsWith('_url') ||
      normalizedName.endsWith('_uri') ||
      normalizedName.endsWith('_website'))
  ) {
    return 'url';
  }

  if (
    STRING_TYPES.has(type) &&
    (ADDRESS_NAMES.has(normalizedName) ||
      normalizedName.endsWith('_address') ||
      normalizedName.endsWith('_city') ||
      normalizedName.endsWith('_state') ||
      normalizedName.endsWith('_country') ||
      normalizedName.endsWith('_postal_code') ||
      normalizedName.endsWith('_zip'))
  ) {
    return 'address';
  }

  if (STRING_TYPES.has(type) && NAME_NAMES.has(normalizedName)) {
    return 'name';
  }

  if (
    (STRING_TYPES.has(type) || NUMERIC_TYPES.has(type)) &&
    (CURRENCY_NAMES.has(normalizedName) ||
      normalizedName.endsWith('_currency') ||
      normalizedName.endsWith('_currency_code') ||
      normalizedName.endsWith('_price') ||
      normalizedName.endsWith('_amount'))
  ) {
    return 'currency';
  }

  if (
    NUMERIC_TYPES.has(type) &&
    (COUNT_NAMES.has(normalizedName) ||
      normalizedName.endsWith('_count') ||
      normalizedName.startsWith('num_') ||
      normalizedName.endsWith('_num') ||
      normalizedName.endsWith('_quantity') ||
      normalizedName.endsWith('_qty'))
  ) {
    return 'count';
  }

  if (
    NUMERIC_TYPES.has(type) &&
    (RATE_NAMES.has(normalizedName) ||
      normalizedName.endsWith('_rate') ||
      normalizedName.endsWith('_ratio') ||
      normalizedName.endsWith('_percent') ||
      normalizedName.endsWith('_percentage') ||
      normalizedName.endsWith('_pct'))
  ) {
    return 'rate';
  }

  if (
    type === 'string' &&
    (IDENTIFIER_NAMES.has(normalizedName) ||
      normalizedName.endsWith('_uuid') ||
      normalizedName.endsWith('_guid') ||
      normalizedName.endsWith('_key') ||
      normalizedName.endsWith('_code') ||
      normalizedName.endsWith('_number') ||
      normalizedName.endsWith('_ref'))
  ) {
    return 'identifier';
  }

  if (
    MEASURE_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix)) &&
    NUMERIC_TYPES.has(type)
  ) {
    return 'measure';
  }

  if (
    type === 'string' &&
    (CATEGORICAL_NAMES.has(normalizedName) || hasAnyToken(normalizedName, CATEGORICAL_NAMES))
  ) {
    return 'categorical';
  }

  return undefined;
}

/** Convert `snake_case_name` to `"Snake case name"`. */
export function humanize(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function collectFieldMetadata(field: ResourceOutputField): Partial<FieldMetadata> {
  const metadata: Partial<FieldMetadata> = {};
  for (const key of FIELD_METADATA_KEYS) {
    const value = field[key];
    if (value !== undefined) {
      (metadata as Record<string, unknown>)[key] = value;
    }
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Model Spec source generation
// ---------------------------------------------------------------------------

/**
 * Generate a Model Spec source spec YAML string from a resource spec.
 *
 * When `embedConfig` is provided, one VECTOR column per configured embed field
 * is appended to the schema with `embedded_from` provenance. Callers that have
 * no pipeline context (e.g. standalone `dogsled extract run --emit-model-spec-source`
 * outside `dogsled pipeline`) omit the argument and the scaffold behaves
 * exactly as before.
 */
export function generateModelSpecSource(
  resource: ResourceSpec,
  connectionName: string,
  embedConfig?: ResolvedResourceEmbedConfig
): string {
  const sourceName = `${connectionName}_${resource.name}`;
  const table = `raw.${sourceName}`;
  const primaryKeys = new Set(resource.extract?.table?.primary_key ?? []);

  const columns: ModelSpecColumnSpec[] = Object.entries(resource.output)
    .map(([name, field]) => ({
      name,
      field,
    }))
    .map(({ name, field }) => {
      const base: ModelSpecColumnSpec = {
        name,
        type: TYPE_MAP[field.type],
        description: field.description ?? humanize(name),
        ...collectFieldMetadata(field),
      };
      if (primaryKeys.has(name)) base.primary_key = true;
      const role = field.semantic_role ?? inferSemanticRole(name, field.type);
      if (role) base.semantic_role = role;
      return base;
    });

  if (embedConfig) {
    const existingNames = new Set(columns.map((c) => c.name));
    for (const field of embedConfig.fields) {
      // Skip silently when the embed binding references a field the resource
      // never emits — likely a typo in `dogsled.yml`. Producing a synthetic
      // VECTOR column whose `embedded_from.column` doesn't exist on the
      // source would leave the scaffold internally inconsistent.
      if (!(field.field in resource.output)) {
        continue;
      }
      const columnName = embeddingColumnName(field.field, field.as);
      if (existingNames.has(columnName)) {
        continue;
      }
      existingNames.add(columnName);
      columns.push({
        name: columnName,
        type: TYPE_MAP.vector,
        dimension: embedConfig.dimension,
        description: `Vector embedding of ${field.field} (${embedConfig.provider}/${embedConfig.model})`,
        embedded_from: {
          column: field.field,
          provider: embedConfig.provider,
          model: embedConfig.model,
          ...(embedConfig.distance_metric ? { distance_metric: embedConfig.distance_metric } : {}),
        },
      });
    }
  }

  const spec = {
    spec_version: '0.2',
    name: sourceName,
    type: 'source',
    source_type: 'warehouse_table',
    connection: connectionName,
    table,
    ...(resource.extract?.table?.trust_tier
      ? {
          trust_tier: resource.extract.table.trust_tier,
        }
      : {}),
    schema: { columns },
  };

  return YAML.stringify(spec);
}
