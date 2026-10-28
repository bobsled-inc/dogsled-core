/**
 * Schema inference for extractor resources.
 */

import YAML from 'yaml';

import { extractJsonPath } from './response-mapper.js';

export interface InferredField {
  name: string;
  type: 'integer' | 'string' | 'timestamp' | 'boolean' | 'number' | 'array' | 'object';
  path: string;
  primary_key?: boolean;
  cursor_candidate?: boolean;
}

export interface DriftReport {
  newFields: string[];
  removedFields: string[];
  typeChanges: Array<{ field: string; declared: string; observed: string }>;
}

interface DeclaredField {
  name: string;
  type: string;
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;
const MAX_SAMPLE_SIZE = 10;

type InferredType = InferredField['type'];

function inferFieldType(value: unknown): InferredType {
  if (value === null || value === undefined) {
    return 'string';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  if (typeof value === 'string') {
    return ISO_8601_RE.test(value) ? 'timestamp' : 'string';
  }
  return 'string';
}

function widenType(left: InferredType, right: InferredType): InferredType {
  if (left === right) {
    return left;
  }
  if ((left === 'integer' && right === 'number') || (left === 'number' && right === 'integer')) {
    return 'number';
  }
  if (
    (left === 'string' && right === 'timestamp') ||
    (left === 'timestamp' && right === 'string')
  ) {
    return 'string';
  }
  return 'string';
}

export function inferColumns(data: unknown, recordPath: string): InferredField[] {
  const extracted = extractJsonPath(data, recordPath);
  const records = Array.isArray(extracted) ? extracted : extracted != null ? [extracted] : [];
  const sample = records.slice(0, MAX_SAMPLE_SIZE);

  if (sample.length === 0) {
    return [];
  }

  const fieldTypes = new Map<string, InferredType>();
  const fieldValues = new Map<string, Set<unknown>>();

  for (const record of sample) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      continue;
    }

    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      const nextType = inferFieldType(value);
      const currentType = fieldTypes.get(key);
      fieldTypes.set(key, currentType ? widenType(currentType, nextType) : nextType);

      if (!fieldValues.has(key)) {
        fieldValues.set(key, new Set());
      }
      fieldValues.get(key)!.add(value);
    }
  }

  const fields: InferredField[] = [];
  for (const [name, type] of fieldTypes) {
    const field: InferredField = {
      name,
      type,
      path: `$.${name}`,
    };

    if ((name === 'id' || name.endsWith('_id')) && (type === 'integer' || type === 'string')) {
      const values = fieldValues.get(name);
      if (values && values.size === sample.length) {
        field.primary_key = true;
      }
    }

    if (type === 'timestamp' && (name.endsWith('_at') || name.endsWith('_date'))) {
      field.cursor_candidate = true;
    }

    fields.push(field);
  }

  return fields;
}

export function generateResourceSkeleton(
  fields: InferredField[],
  integrationName: string,
  resourceName: string,
  endpoint: string
): string {
  const primaryKeys = fields.filter((field) => field.primary_key).map((field) => field.name);
  const cursorField = fields.find((field) => field.cursor_candidate)?.name;

  const output: Record<string, unknown> = {};
  for (const field of fields) {
    output[field.name] = {
      type: field.type,
      path: field.path,
    };
  }

  const spec: Record<string, unknown> = {
    spec_version: '1',
    type: 'resource',
    name: resourceName,
    integration: integrationName,
    description: `Extract ${resourceName} from ${integrationName}`,
    api: {
      endpoint,
      method: 'GET',
    },
    input: {},
    output,
    extract: {
      record_path: '$',
      ...(primaryKeys.length > 0
        ? {
            table: {
              primary_key: primaryKeys,
            },
          }
        : {}),
      ...(cursorField
        ? {
            incremental: {
              cursor_field: cursorField,
              cursor_param: 'since',
            },
          }
        : {}),
    },
  };

  return YAML.stringify(spec);
}

export function detectDrift(inferred: InferredField[], declared: DeclaredField[]): DriftReport {
  const declaredMap = new Map(declared.map((field) => [field.name, field.type]));
  const inferredMap = new Map(inferred.map((field) => [field.name, field.type]));

  const newFields: string[] = [];
  const typeChanges: DriftReport['typeChanges'] = [];

  for (const [name, type] of inferredMap) {
    const declaredType = declaredMap.get(name);
    if (!declaredType) {
      newFields.push(name);
      continue;
    }
    if (declaredType !== type) {
      typeChanges.push({ field: name, declared: declaredType, observed: type });
    }
  }

  const removedFields = [...declaredMap.keys()].filter((name) => !inferredMap.has(name));
  return {
    newFields,
    removedFields,
    typeChanges,
  };
}
