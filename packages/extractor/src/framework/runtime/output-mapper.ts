import { JSONPath } from 'jsonpath-plus';
import type { JsonObject, JsonValue } from '@bobsled-inc/protocol';

import type { FieldType, OutputFieldDefinition } from '../core/index.js';
import { type JsonPathToken, parseJsonPathTokens, resolveArrayIndex } from '../core/json-path.js';
import { isObject } from '../core/shared.js';
import { normalizeJsonObject, normalizeJsonValue } from '../../runtime/json-normalization.js';
import { getFanOutContextOutput, type FanOutContext } from '../../runtime/for-each.js';

const SIMPLE_PATH_RE = /^\$\.([A-Za-z_][A-Za-z0-9_]*)$/;

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function walkSupportedPath(source: unknown, tokens: JsonPathToken[]): unknown {
  let current: unknown = source;
  for (const token of tokens) {
    if (token.type === 'prop') {
      if (BLOCKED_KEYS.has(token.value) || !isObject(current)) {
        return undefined;
      }
      current = current[token.value];
      continue;
    }

    if (!Array.isArray(current)) {
      return undefined;
    }

    const resolvedIndex = resolveArrayIndex(token.value, current.length);
    if (resolvedIndex < 0 || resolvedIndex >= current.length) {
      return undefined;
    }
    current = current[resolvedIndex];
  }

  return current;
}

export function extractJsonPath(source: unknown, path: string): unknown {
  if (source === null || source === undefined) {
    return undefined;
  }

  // Fast path: simple `$.fieldName` property access bypasses JSONPath library
  const simple = SIMPLE_PATH_RE.exec(path);
  if (simple?.[1] && isObject(source)) {
    const value = source[simple[1]];
    return value === undefined ? undefined : value;
  }

  // Fast path: dotted paths with optional array indexes like `$.data[-1].id`
  const supportedTokens = parseJsonPathTokens(path);
  if (supportedTokens) {
    const value = walkSupportedPath(source, supportedTokens);
    return value === undefined ? undefined : value;
  }

  const results = JSONPath<unknown[]>({
    json: source as boolean | number | string | object | unknown[],
    path,
    wrap: true,
  });

  if (!results || results.length === 0) {
    return undefined;
  }

  return results.length === 1 ? results[0] : results;
}

function coerceValue(expectedType: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  switch (expectedType) {
    case 'string':
    case 'timestamp':
      return typeof value === 'string' ? value : String(value);
    case 'integer': {
      const numericValue = typeof value === 'number' ? value : Number(value);
      return Number.isInteger(numericValue) ? numericValue : null;
    }
    case 'number': {
      const numericValue = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numericValue) ? numericValue : null;
    }
    case 'boolean':
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
          return true;
        }
        if (
          normalized === 'false' ||
          normalized === '0' ||
          normalized === 'no' ||
          normalized === ''
        ) {
          return false;
        }
      }
      return Boolean(value);
    case 'array':
      return Array.isArray(value) ? value : [value];
    case 'object':
      return isObject(value) ? value : null;
  }
}

/**
 * Per-output-field match telemetry sink. `mapOutput` reports, for each
 * top-level output field of every record, whether any configured JSONPath
 * resolved to a value (`matched: true`) or the field fell through to its
 * `default`/null (`matched: false`). Lets the extract summary surface
 * "matched N of M records" so a path that silently matches zero elements is an
 * instant signal instead of a 5-minute deploy-extract probe.
 */
export interface FieldMatchCollector {
  record(field: string, matched: boolean): void;
}

interface FieldTelemetry {
  name: string;
  collector: FieldMatchCollector;
}

/**
 * Resolve an output field's value against the source record. Honors the
 * ordered `paths` fallback (first non-`undefined` wins) and falls back to the
 * static `default`. `matched` is true when a configured path resolved.
 */
function resolveFieldValue(
  source: unknown,
  field: OutputFieldDefinition,
  context?: FanOutContext
): { resolved: unknown; matched: boolean } {
  if (field.from) {
    if ('input' in field.from) {
      const inputContext = isObject(source) ? source.__input__ : undefined;
      const extracted = isObject(inputContext) ? inputContext[field.from.input] : undefined;
      if (extracted === undefined || extracted === null) {
        throw new Error(
          `Missing extraction input value for contextual output from "${field.from.input}"`
        );
      }
      return { resolved: extracted, matched: extracted !== undefined };
    }
    const ancestor = context ? getFanOutContextOutput(context, field.from.resource) : undefined;
    if (!ancestor) {
      throw new Error(
        `Missing fan-out context for contextual output from "${field.from.resource}${field.from.path.slice(1)}"`
      );
    }
    const extracted = extractJsonPath(ancestor, field.from.path);
    if (extracted === undefined || extracted === null) {
      throw new Error(
        `Missing fan-out context value for contextual output from "${field.from.resource}${field.from.path.slice(1)}"`
      );
    }
    return { resolved: extracted, matched: extracted !== undefined };
  }
  const candidates =
    field.paths && field.paths.length > 0
      ? field.paths
      : field.path !== undefined
        ? [field.path]
        : [];

  for (const candidate of candidates) {
    const extracted = extractJsonPath(source, candidate);
    if (extracted !== undefined) {
      return { resolved: extracted, matched: true };
    }
  }

  return { resolved: field.default, matched: false };
}

function mapOutputField(
  source: unknown,
  field: OutputFieldDefinition,
  telemetry?: FieldTelemetry,
  context?: FanOutContext
): JsonValue | undefined {
  const { resolved, matched } = resolveFieldValue(source, field, context);
  telemetry?.collector.record(telemetry.name, matched);

  if (resolved === undefined) {
    return undefined;
  }

  if (field.type === 'object' && field.properties) {
    const nestedSource = isObject(resolved) ? resolved : {};
    return mapOutput(nestedSource, field.properties, undefined, context);
  }

  if (field.type === 'array' && field.items) {
    const arrayValue = Array.isArray(resolved) ? resolved : [resolved];
    const items = field.items;
    return arrayValue.map((entry) => {
      if (items.type === 'object' && items.properties) {
        return mapOutput(entry, items.properties, undefined, context);
      }
      return mapOutputField(entry, items, undefined, context) ?? null;
    });
  }

  if (field.type === 'array') {
    const arrayValue = Array.isArray(resolved) ? resolved : [resolved];
    return arrayValue.map((entry) => normalizeJsonValue(entry));
  }

  if (field.type === 'object') {
    return isObject(resolved) ? normalizeJsonObject(resolved) : null;
  }

  return coerceValue(field.type, resolved) as JsonValue;
}

export function mapOutput(
  source: unknown,
  output: Record<string, OutputFieldDefinition>,
  collector?: FieldMatchCollector,
  context?: FanOutContext
): JsonObject {
  const result: JsonObject = Object.create(null) as JsonObject;

  for (const [name, field] of Object.entries(output)) {
    if (BLOCKED_KEYS.has(name)) continue;
    const mapped = mapOutputField(
      source,
      field,
      collector ? { name, collector } : undefined,
      context
    );
    if (mapped !== undefined) {
      result[name] = mapped;
    }
  }

  return result;
}
