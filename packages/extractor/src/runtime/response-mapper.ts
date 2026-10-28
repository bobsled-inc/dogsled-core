import { hasFanOutOutputOrigin, isObject } from '../framework/core/index.js';
import { extractJsonPath, mapOutput } from '../framework/runtime/index.js';

import { DEFAULT_RECORD_PATH } from '../constants.js';

import type { FieldMatchCollector } from '../framework/runtime/index.js';
import type { ApiResourceSpec } from '../types/index.js';
import {
  EMPTY_FAN_OUT_CONTEXT,
  buildTargetedFanOutContext,
  normalizeForEachConfig,
  type FanOutContext,
} from './for-each.js';

export { extractJsonPath };

export { mapOutput };

export type { FieldMatchCollector };

export function withOutputContext(
  record: unknown,
  input?: Record<string, unknown>
): Record<string, unknown> | unknown {
  if (!input || Object.keys(input).length === 0) {
    return record;
  }

  if (isObject(record)) {
    return {
      ...record,
      __input__: input,
    };
  }

  return {
    __value__: record,
    __input__: input,
  };
}

export function extractRecords(
  data: unknown,
  recordPathOrResource: ApiResourceSpec | string
): unknown[] {
  const recordPath =
    typeof recordPathOrResource === 'string'
      ? recordPathOrResource
      : (recordPathOrResource.extract?.record_path ?? DEFAULT_RECORD_PATH);
  const extracted = extractJsonPath(data, recordPath);

  if (Array.isArray(extracted)) {
    return extracted.filter((item) => isObject(item));
  }
  if (isObject(extracted)) {
    return [extracted];
  }
  return [];
}

export interface MapResponseOptions {
  /** Inputs available to legacy `$.__input__` mappings and exact targeted context proof. */
  input?: Record<string, unknown>;
  /** Pre-built immutable mapped-output lineage for non-targeted/nested ancestry. */
  fanOutContext?: FanOutContext;
}

export function mapResponse(
  data: unknown,
  resource: ApiResourceSpec,
  options: MapResponseOptions = {}
): Record<string, unknown>[] {
  let fanOutContext = options.fanOutContext ?? EMPTY_FAN_OUT_CONTEXT;
  if (!options.fanOutContext && hasFanOutOutputOrigin(resource.output)) {
    const forEach = normalizeForEachConfig(resource.extract.for_each);
    if (!forEach) {
      throw new Error(
        `mapResponse() cannot resolve contextual outputs for "${resource.name}" without extract.for_each`
      );
    }
    try {
      fanOutContext = buildTargetedFanOutContext(
        resource,
        forEach,
        options.input ?? Object.create(null)
      );
    } catch (error) {
      throw new Error(
        `mapResponse() cannot prove fan-out context for "${resource.name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return extractRecords(data, resource).map((raw) =>
    mapOutput(withOutputContext(raw, options.input), resource.output, undefined, fanOutContext)
  );
}

export function extractCursorValue(data: unknown, path: string): string | null {
  const value = extractJsonPath(data, path);
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value);
  return str.trim() === '' ? null : str;
}

export function extractNumberValue(data: unknown, path: string): number | undefined {
  const value = extractJsonPath(data, path);
  if (value === null || value === undefined) {
    return undefined;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}
