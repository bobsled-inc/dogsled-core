import { isPlainObject } from '@bobsled-inc/protocol';
import type { JsonObject, JsonValue } from '@bobsled-inc/protocol';

export function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (isPlainObject(value)) {
    return normalizeJsonObject(value);
  }

  return null;
}

export function normalizeJsonObject(value: Record<string, unknown>): JsonObject {
  const normalized: JsonObject = Object.create(null) as JsonObject;

  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = normalizeJsonValue(entry);
  }

  return normalized;
}
