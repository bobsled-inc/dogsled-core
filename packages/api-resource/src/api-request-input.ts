import type { ApiRequestInputFieldDefinition } from './api-request-types.js';

interface ResolveInputParams {
  schema: Record<string, ApiRequestInputFieldDefinition>;
  provided?: Record<string, unknown>;
  rejectUnknownNestedProperties?: boolean;
  inputMode?: 'coerce' | 'strict';
}

function parseBoolean(value: string, path: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  throw new Error(`Invalid boolean value for ${path}`);
}

function parseJson(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON value for ${path}`);
  }
}

function ensureObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object for ${path}`);
  }
  return value as Record<string, unknown>;
}

/** Reject patterns with nested quantifiers that can cause catastrophic backtracking. */
function hasDangerousQuantifiers(pattern: string): boolean {
  return /[+*?}]\)?[)]\s*[+*?{]/.test(pattern);
}

function validateBounds(
  value: ApiRequestInputFieldDefinition,
  resolved: unknown,
  path: string
): void {
  if (typeof resolved === 'string') {
    if (value.minLength !== undefined && resolved.length < value.minLength) {
      throw new Error(`${path} must be at least ${value.minLength} characters`);
    }
    if (value.maxLength !== undefined && resolved.length > value.maxLength) {
      throw new Error(`${path} must be at most ${value.maxLength} characters`);
    }
    if (value.pattern) {
      if (value.pattern.length > 500) {
        throw new Error(`${path} pattern exceeds maximum length of 500 characters`);
      }
      if (hasDangerousQuantifiers(value.pattern)) {
        throw new Error(
          `${path} pattern contains nested quantifiers which could cause excessive backtracking`
        );
      }
      let regex: RegExp;
      try {
        regex = new RegExp(value.pattern, 'u');
      } catch {
        throw new Error(`${path} has invalid pattern`);
      }
      const start = Date.now();
      const result = regex.test(resolved);
      if (Date.now() - start > 100) {
        throw new Error(`${path} pattern took too long to evaluate — simplify the regex`);
      }
      if (!result) {
        throw new Error(`${path} does not match required pattern`);
      }
    }
    if (value.enum && !value.enum.includes(resolved)) {
      throw new Error(`${path} must be one of: ${value.enum.join(', ')}`);
    }
  }

  if (typeof resolved === 'number') {
    if (value.minimum !== undefined && resolved < value.minimum) {
      throw new Error(`${path} must be at least ${value.minimum}`);
    }
    if (value.maximum !== undefined && resolved > value.maximum) {
      throw new Error(`${path} must be at most ${value.maximum}`);
    }
  }

  if (Array.isArray(resolved)) {
    if (value.minItems !== undefined && resolved.length < value.minItems) {
      throw new Error(`${path} must contain at least ${value.minItems} item(s)`);
    }
    if (value.maxItems !== undefined && resolved.length > value.maxItems) {
      throw new Error(`${path} must contain at most ${value.maxItems} item(s)`);
    }
  }
}

function resolveInputField(
  field: ApiRequestInputFieldDefinition,
  rawValue: unknown,
  path: string,
  rejectUnknownNestedProperties: boolean,
  inputMode: 'coerce' | 'strict'
): unknown {
  let resolved = rawValue;
  const coerce = inputMode === 'coerce';

  switch (field.type) {
    case 'string':
      if (typeof rawValue !== 'string') {
        if (!coerce) throw new Error(`Expected string for ${path}`);
        resolved = String(rawValue);
      }
      break;
    case 'timestamp':
      if (rawValue instanceof Date) {
        if (!coerce) throw new Error(`Expected timestamp string for ${path}`);
        resolved = rawValue.toISOString();
      } else if (typeof rawValue === 'string') {
        resolved = rawValue;
      } else {
        if (!coerce) throw new Error(`Expected timestamp string for ${path}`);
        resolved = String(rawValue);
      }
      break;
    case 'number': {
      const numericValue = coerce
        ? typeof rawValue === 'number'
          ? rawValue
          : Number(String(rawValue).trim())
        : rawValue;
      if (!coerce && typeof numericValue !== 'number') {
        throw new Error(`Expected number for ${path}`);
      }
      if (!Number.isFinite(numericValue)) {
        throw new Error(`Invalid number value for ${path}`);
      }
      resolved = numericValue;
      break;
    }
    case 'integer': {
      const numericValue = coerce
        ? typeof rawValue === 'number'
          ? rawValue
          : Number(String(rawValue).trim())
        : rawValue;
      if (!coerce && typeof numericValue !== 'number') {
        throw new Error(`Expected integer for ${path}`);
      }
      if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
        throw new Error(`Invalid integer value for ${path}`);
      }
      resolved = numericValue;
      break;
    }
    case 'boolean':
      if (typeof rawValue === 'boolean') {
        resolved = rawValue;
      } else {
        if (!coerce) throw new Error(`Expected boolean for ${path}`);
        resolved = parseBoolean(String(rawValue), path);
      }
      break;
    case 'array': {
      const arrayValue = Array.isArray(rawValue)
        ? rawValue
        : coerce && typeof rawValue === 'string'
          ? parseJson(rawValue, path)
          : rawValue;
      if (!Array.isArray(arrayValue)) {
        throw new Error(`Expected array for ${path}`);
      }
      resolved = field.items
        ? arrayValue.map((entry, index) =>
            resolveInputField(
              field.items as ApiRequestInputFieldDefinition,
              entry,
              `${path}[${index}]`,
              rejectUnknownNestedProperties,
              inputMode
            )
          )
        : arrayValue;
      break;
    }
    case 'object': {
      const objectValue =
        coerce && typeof rawValue === 'string' ? parseJson(rawValue, path) : rawValue;
      const recordValue = ensureObject(objectValue, path);
      if (!field.properties) {
        resolved = recordValue;
        break;
      }

      if (rejectUnknownNestedProperties) {
        for (const key of Object.keys(recordValue)) {
          if (!Object.hasOwn(field.properties, key)) {
            throw new Error(`Unknown input "${path}.${key}"`);
          }
        }
      }

      const nextValue: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, schema] of Object.entries(field.properties)) {
        const propertyPath = `${path}.${key}`;
        const propertyRaw = Object.hasOwn(recordValue, key) ? recordValue[key] : schema.default;
        if (propertyRaw === undefined) {
          if (schema.required) {
            throw new Error(`Missing required input ${propertyPath}`);
          }
          continue;
        }
        nextValue[key] = resolveInputField(
          schema,
          propertyRaw,
          propertyPath,
          rejectUnknownNestedProperties,
          inputMode
        );
      }
      resolved = nextValue;
      break;
    }
  }

  validateBounds(field, resolved, path);
  return resolved;
}

export function resolveOperationInput({
  schema,
  provided = {},
  rejectUnknownNestedProperties = false,
  inputMode = 'coerce',
}: ResolveInputParams): Record<string, unknown> {
  for (const key of Object.keys(provided)) {
    if (!Object.hasOwn(schema, key)) {
      throw new Error(`Unknown input "${key}"`);
    }
  }

  const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const [key, field] of Object.entries(schema)) {
    const path = `input.${key}`;
    const rawValue = Object.hasOwn(provided, key) ? provided[key] : field.default;

    if (rawValue === undefined) {
      if (field.required) {
        throw new Error(`Missing required input ${path}`);
      }
      continue;
    }

    resolved[key] = resolveInputField(
      field,
      rawValue,
      path,
      rejectUnknownNestedProperties,
      inputMode
    );
  }

  return resolved;
}
