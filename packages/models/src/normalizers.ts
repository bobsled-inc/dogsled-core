import { singularizeName } from './utils.js';

import type {
  ModelColumnSpec,
  ResourceOutputField,
  SemanticRole,
  SourceColumnSpec,
} from './types.js';

const FINANCIAL_NAME_REGEX =
  /(amount|price|cost|revenue|subtotal|total|tax|fee|net|balance|spend|budget|value)/;
const MEASURE_NAME_REGEX =
  /(count|quantity|size|progress|estimate|score|rate|percentage|number_of|position|available|inventory|weight|attempts?|additions|deletions|commits|comments)/;
const DATE_STRING_REGEX = /(yyyy-mm-dd|date string)/i;
const UNIX_TIMESTAMP_REGEX = /unix timestamp/i;
const NUMERIC_STRING_REGEX = /numeric string|stored as a numeric string/i;

interface StagingExpression {
  expr: string;
  type?: string;
  businessRule?: string;
}

export function mapWarehouseColumnType(fieldType: string): SourceColumnSpec['type'] {
  switch (fieldType) {
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'NUMERIC';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'array':
    case 'object':
      return 'JSON';
    default:
      return 'VARCHAR';
  }
}

export function renameStagingColumn(
  resourceName: string,
  fieldName: string,
  fieldType: string,
  description: string | undefined
): string {
  const desc = (description ?? '').toLowerCase();

  if (fieldName === 'id') return `${singularizeName(resourceName)}_id`;
  if (fieldName === 'token') return 'token';
  if (fieldName === 'created') return 'created_at';
  if (fieldName === 'updated') return 'updated_at';
  if (fieldName === 'deleted') return 'deleted_at';
  if (fieldName.endsWith('_id') || fieldName.endsWith('_token') || fieldName.endsWith('_uuid')) {
    return fieldName;
  }

  const isIdentifierLike =
    (fieldType === 'string' || fieldType === 'integer') &&
    (desc.includes(' id ') ||
      desc.startsWith('id of') ||
      desc.includes('uuid of') ||
      desc.endsWith(' id'));

  if (isIdentifierLike) return `${fieldName}_id`;
  return fieldName;
}

export function buildStagingExpression(
  sourceFieldName: string,
  targetFieldName: string,
  field: ResourceOutputField
): StagingExpression {
  const fieldRef = `t0.${sourceFieldName}`;
  const description = field.description ?? '';

  if (field.type === 'integer' && UNIX_TIMESTAMP_REGEX.test(description)) {
    return {
      expr: `TO_TIMESTAMP(${fieldRef})`,
      type: 'TIMESTAMP',
      businessRule: 'Converted from Unix epoch seconds into a warehouse timestamp.',
    };
  }

  if (
    (field.type === 'integer' || field.type === 'number') &&
    isMinorUnitCurrency(targetFieldName, description)
  ) {
    return {
      expr: `CAST(${fieldRef} / 100.0 AS NUMERIC(16, 2))`,
      type: 'NUMERIC(16, 2)',
      businessRule: 'Normalized from the smallest currency unit into standard currency units.',
    };
  }

  if (
    field.type === 'string' &&
    looksNumericMeasure(targetFieldName) &&
    NUMERIC_STRING_REGEX.test(description)
  ) {
    return {
      expr: `CAST(NULLIF(${fieldRef}, '') AS NUMERIC(16, 2))`,
      type: 'NUMERIC(16, 2)',
      businessRule: 'Casted a numeric string field into NUMERIC for downstream aggregations.',
    };
  }

  if (
    field.type === 'string' &&
    DATE_STRING_REGEX.test(description) &&
    targetFieldName.endsWith('_date')
  ) {
    return {
      expr: `CAST(${fieldRef} AS DATE)`,
      type: 'DATE',
      businessRule: 'Casted a YYYY-MM-DD string into a DATE value for time-based analysis.',
    };
  }

  return { expr: fieldRef };
}

export function deriveSemanticRole(
  fieldName: string,
  fieldType: string,
  description: string | undefined,
  isPrimaryKey: boolean
): SemanticRole {
  if (isPrimaryKey || fieldName.endsWith('_id') || fieldName.endsWith('_token')) {
    return 'entity_id';
  }

  if (fieldType === 'timestamp' || fieldName.endsWith('_at') || fieldName.endsWith('_timestamp')) {
    return 'event_timestamp';
  }

  if (fieldName.endsWith('_date') || DATE_STRING_REGEX.test(description ?? '')) {
    return 'time_dimension';
  }

  if (
    fieldType === 'integer' ||
    fieldType === 'number' ||
    FINANCIAL_NAME_REGEX.test(fieldName) ||
    MEASURE_NAME_REGEX.test(fieldName)
  ) {
    return 'measure';
  }

  return 'categorical';
}

export function deriveColumnTags(fieldName: string): string[] | undefined {
  const tags: string[] = [];

  if (
    fieldName.includes('email') ||
    fieldName.includes('phone') ||
    ['first_name', 'last_name', 'lead_name', 'customer_name'].includes(fieldName)
  ) {
    tags.push('pii');
  }

  if (FINANCIAL_NAME_REGEX.test(fieldName)) {
    tags.push('financial');
  }

  return tags.length > 0 ? tags : undefined;
}

export function buildSourceColumn(name: string, field: ResourceOutputField): SourceColumnSpec {
  return {
    name,
    type: mapWarehouseColumnType(field.type),
    description: field.description,
    unit: field.unit,
  };
}

export function buildStagingColumn(
  sourceFieldName: string,
  targetFieldName: string,
  field: ResourceOutputField,
  isPrimaryKey: boolean,
  reference?: string
): ModelColumnSpec {
  const normalized = buildStagingExpression(sourceFieldName, targetFieldName, field);

  return {
    name: targetFieldName,
    expr: normalized.expr,
    description: field.description,
    unit: field.unit,
    type: normalized.type,
    primary_key: isPrimaryKey,
    not_null: isPrimaryKey,
    semantic_role: deriveSemanticRole(targetFieldName, field.type, field.description, isPrimaryKey),
    references: reference,
    tags: deriveColumnTags(targetFieldName),
    business_rule: normalized.businessRule,
  };
}

function isMinorUnitCurrency(fieldName: string, description: string): boolean {
  return FINANCIAL_NAME_REGEX.test(fieldName) && /smallest currency unit|cents/i.test(description);
}

function looksNumericMeasure(fieldName: string): boolean {
  return FINANCIAL_NAME_REGEX.test(fieldName) || MEASURE_NAME_REGEX.test(fieldName);
}
