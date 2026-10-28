import { CommandError } from '@bobsled-inc/protocol';

import type { ApiResourceSpec } from '../types/index.js';

/**
 * Per-resource input overrides, keyed by resource spec name. Values mirror the
 * `--input key=value` value space: every input is a string by the time it
 * reaches the extraction runtime, and array inputs remain JSON strings so the
 * declared `type: array` resolver can parse them without losing delimiters.
 */
export type ResourceInputsMap = Record<string, Record<string, string>>;

export type ResourceInputMatricesMap = Record<
  string,
  Array<Record<string, string | number | boolean>>
>;
export type ResourceInputMatrixConcurrencyMap = Record<string, number>;

export const MAX_RESOURCE_INPUT_MATRIX_COMBINATIONS = 10_000;

/**
 * WIRE FORMAT — why JSON instead of `<resource>:<key>=<value>`:
 *
 * `--resource-via` can use colon-delimited pairs because both halves come from
 * closed value spaces (resource names and transport ids). Input VALUES are
 * arbitrary user data: they can contain `:`, `=`, `,`, spaces, and newlines, so
 * a delimited pair format would be ambiguous and could silently corrupt data.
 * This flag therefore takes one JSON object, matching the existing precedent
 * for structured payloads (`--destinations-json`, `--embed-config-json`).
 *
 * Shape:
 *   {"<resource>": {"<input>": "value" | 3 | true | ["a","b"], ...}, ...}
 *
 * Arrays use JSON encoding because declared array inputs are decoded with
 * `JSON.parse` at the request/MCP boundary.
 */
export function parseResourceInputsJson(value: string): ResourceInputsMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CommandError(
      `--resource-inputs-json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CommandError(
      '--resource-inputs-json must be a JSON object mapping resource name to an input object.'
    );
  }

  // JSON controls both key levels. Null-prototype maps make special keys such
  // as `__proto__` inert data rather than prototype setters.
  const result = Object.create(null) as ResourceInputsMap;
  for (const [resource, inputs] of Object.entries(parsed)) {
    if (resource.length === 0) {
      throw new CommandError('--resource-inputs-json contains an empty resource name.');
    }
    if (!isPlainObject(inputs)) {
      throw new CommandError(
        `--resource-inputs-json entry "${resource}" must be an object of input values.`
      );
    }
    const serialized = Object.create(null) as Record<string, string>;
    for (const [key, raw] of Object.entries(inputs)) {
      if (key.length === 0) {
        throw new CommandError(
          `--resource-inputs-json entry "${resource}" contains an empty input name.`
        );
      }
      serialized[key] = serializeInputValue(resource, key, raw);
    }
    result[resource] = serialized;
  }
  return result;
}

export function parseResourceInputMatricesJson(value: string): ResourceInputMatricesMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CommandError(
      `--resource-input-matrices-json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CommandError(
      '--resource-input-matrices-json must be a JSON object mapping resource names to input tuples.'
    );
  }
  const result = Object.create(null) as ResourceInputMatricesMap;
  for (const [resource, tuples] of Object.entries(parsed)) {
    if (resource.length === 0) {
      throw new CommandError('--resource-input-matrices-json contains an empty resource name.');
    }
    if (!Array.isArray(tuples) || tuples.length === 0) {
      throw new CommandError(
        `--resource-input-matrices-json entry "${resource}" must be a non-empty array of input tuples.`
      );
    }
    result[resource] = tuples.map((tuple, index) => {
      if (!isPlainObject(tuple)) {
        throw new CommandError(
          `--resource-input-matrices-json entry "${resource}" tuple ${index + 1} must be an object.`
        );
      }
      if (Object.keys(tuple).length === 0) {
        throw new CommandError(
          `--resource-input-matrices-json entry "${resource}" tuple ${index + 1} must declare at least one input.`
        );
      }
      const normalized: Record<string, string | number | boolean> = Object.create(null);
      for (const [key, raw] of Object.entries(tuple)) {
        if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
          throw new CommandError(
            `--resource-input-matrices-json input "${resource}.${key}" must be a string, finite number, or boolean.`
          );
        }
        if (typeof raw === 'number' && !Number.isFinite(raw)) {
          throw new CommandError(
            `--resource-input-matrices-json input "${resource}.${key}" must be finite.`
          );
        }
        normalized[key] = raw;
      }
      return normalized;
    });
  }
  return result;
}

export function parseResourceInputMatrixConcurrencyJson(
  value: string
): ResourceInputMatrixConcurrencyMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CommandError(
      `--resource-input-matrix-concurrency-json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CommandError(
      '--resource-input-matrix-concurrency-json must be a JSON object mapping resource names to positive concurrency values.'
    );
  }
  const result = Object.create(null) as ResourceInputMatrixConcurrencyMap;
  for (const [resource, raw] of Object.entries(parsed)) {
    if (resource.length === 0) {
      throw new CommandError(
        '--resource-input-matrix-concurrency-json contains an empty resource name.'
      );
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 64) {
      throw new CommandError(
        `--resource-input-matrix-concurrency-json value for "${resource}" must be a safe integer between 1 and 64.`
      );
    }
    result[resource] = raw;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeInputValue(resource: string, key: string, value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => serializeJsonScalar(resource, key, entry)));
  }
  return serializeScalar(resource, key, value);
}

function serializeJsonScalar(
  resource: string,
  key: string,
  value: unknown
): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new CommandError(
    `--resource-inputs-json input "${resource}.${key}" array entries must be strings, finite ` +
      `numbers, or booleans; received ${value === null ? 'null' : typeof value}.`
  );
}

function serializeScalar(resource: string, key: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  throw new CommandError(
    `--resource-inputs-json input "${resource}.${key}" must be a string, finite number, boolean, ` +
      `or an array of those; received ${value === null ? 'null' : typeof value}.`
  );
}

/**
 * Validate every entry in a per-resource inputs map against the resources that
 * are actually about to run. Dogsled's cross-validation is the authority for
 * pipelines authored in `dogsled.yml`, but `--resource-inputs-json` is reachable
 * when the extractor is invoked standalone, so the boundary defends itself the
 * way `validateResourceViaOverride` does.
 *
 * Unknown input names fail loud instead of being dropped: the caller named one
 * specific resource, so a value that cannot take effect is a config error, not
 * a default to ignore. (Pipeline-wide `--input` keeps its existing
 * filter-per-resource behaviour — it is a broadcast, not a targeted override.)
 */
export function validateResourceInputsOverride(
  resourceInputs: ResourceInputsMap | undefined,
  specs: Array<{ name: string; input?: ApiResourceSpec['input'] }>
): void {
  if (!resourceInputs || Object.keys(resourceInputs).length === 0) return;
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  for (const [resource, inputs] of Object.entries(resourceInputs)) {
    const spec = byName.get(resource);
    if (!spec) {
      throw new CommandError(
        `--resource-inputs-json targets unknown or unselected resource "${resource}".`
      );
    }
    const schema = spec.input;
    const unknown = Object.keys(inputs).filter((key) => !(schema && Object.hasOwn(schema, key)));
    if (unknown.length === 0) continue;
    const available = schema ? Object.keys(schema) : [];
    throw new CommandError(
      `--resource-inputs-json sets unknown input(s) [${unknown.join(', ')}] on resource ` +
        `"${resource}". ${
          available.length > 0
            ? `Available inputs: ${available.join(', ')}.`
            : 'That resource declares no inputs.'
        }`
    );
  }
}

export function validateResourceInputMatricesOverride(
  matrices: ResourceInputMatricesMap | undefined,
  specs: Array<{
    name: string;
    input?: ApiResourceSpec['input'];
    extract?: unknown;
  }>
): void {
  if (!matrices || Object.keys(matrices).length === 0) return;
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  for (const [resource, tuples] of Object.entries(matrices)) {
    const spec = byName.get(resource);
    if (!spec) {
      throw new CommandError(
        `--resource-input-matrices-json targets unknown or unselected resource "${resource}".`
      );
    }
    if (tuples.length > MAX_RESOURCE_INPUT_MATRIX_COMBINATIONS) {
      throw new CommandError(
        `--resource-input-matrices-json entry "${resource}" contains ${tuples.length} tuples; ` +
          `the maximum is ${MAX_RESOURCE_INPUT_MATRIX_COMBINATIONS}.`
      );
    }
    const extract =
      spec.extract !== null && typeof spec.extract === 'object'
        ? (spec.extract as { incremental?: { strategy?: unknown } })
        : undefined;
    const strategy = extract?.incremental?.strategy;
    if (strategy !== 'full_refresh') {
      throw new CommandError(
        `--resource-input-matrices-json is supported only for full_refresh resources; ` +
          `"${resource}" declares incremental strategy "${String(strategy)}".`
      );
    }
    const schema = spec.input;
    const unknown = new Set<string>();
    const invalid: Array<{ key: string; value: string | number | boolean }> = [];
    const normalizedTuples = new Set<string>();
    for (const [index, tuple] of tuples.entries()) {
      if (Object.keys(tuple).length === 0) {
        throw new CommandError(
          `--resource-input-matrices-json entry "${resource}" tuple ${index + 1} must declare at least one input.`
        );
      }
      for (const key of Object.keys(tuple)) {
        const definition = schema?.[key];
        if (!definition) {
          unknown.add(key);
          continue;
        }
        const value = tuple[key]!;
        if (!matrixValueMatchesInput(value, definition)) invalid.push({ key, value });
      }
      const normalized = Object.fromEntries(
        Object.entries(tuple)
          .filter(([key]) => schema?.[key] !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
      );
      const tupleKey = JSON.stringify(normalized);
      if (normalizedTuples.has(tupleKey)) {
        throw new CommandError(
          `--resource-input-matrices-json contains duplicate normalized tuple ${tupleKey} for resource "${resource}".`
        );
      }
      normalizedTuples.add(tupleKey);
    }
    if (unknown.size > 0) {
      const available = schema ? Object.keys(schema) : [];
      throw new CommandError(
        `--resource-input-matrices-json sets unknown input(s) [${[...unknown].join(', ')}] on resource ` +
          `"${resource}". ${available.length > 0 ? `Available inputs: ${available.join(', ')}.` : 'That resource declares no inputs.'}`
      );
    }
    if (invalid.length > 0) {
      const first = invalid[0]!;
      throw new CommandError(
        `--resource-input-matrices-json value ${JSON.stringify(first.value)} is incompatible with input ` +
          `"${resource}.${first.key}".`
      );
    }
  }
}

export function validateResourceInputMatrixConcurrencyOverride(
  concurrency: ResourceInputMatrixConcurrencyMap | undefined,
  matrices: ResourceInputMatricesMap | undefined,
  specs: Array<{ name: string }>
): void {
  if (!concurrency || Object.keys(concurrency).length === 0) return;
  const selected = new Set(specs.map((spec) => spec.name));
  for (const [resource, value] of Object.entries(concurrency)) {
    if (!selected.has(resource)) {
      throw new CommandError(
        `--resource-input-matrix-concurrency-json targets unknown or unselected resource "${resource}".`
      );
    }
    if (!matrices?.[resource]) {
      throw new CommandError(
        `--resource-input-matrix-concurrency-json targets resource "${resource}" without an input matrix.`
      );
    }
    if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
      throw new CommandError(
        `--resource-input-matrix-concurrency-json value for "${resource}" must be a safe integer between 1 and 64.`
      );
    }
  }
}

function matrixValueMatchesInput(
  value: string | number | boolean,
  definition: NonNullable<ApiResourceSpec['input']>[string]
): boolean {
  const compatible =
    ((definition.type === 'string' || definition.type === 'timestamp') &&
      typeof value === 'string') ||
    (definition.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) ||
    (definition.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (definition.type === 'boolean' && typeof value === 'boolean');
  if (!compatible) return false;

  if (Array.isArray(definition.enum) && !definition.enum.includes(value as string)) return false;
  if (typeof value === 'number') {
    if (typeof definition.minimum === 'number' && value < definition.minimum) return false;
    if (typeof definition.maximum === 'number' && value > definition.maximum) return false;
  }
  if (typeof value === 'string') {
    if (typeof definition.minLength === 'number' && value.length < definition.minLength) {
      return false;
    }
    if (typeof definition.maxLength === 'number' && value.length > definition.maxLength) {
      return false;
    }
    if (typeof definition.pattern === 'string') {
      try {
        if (!new RegExp(definition.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

/**
 * Merge the pipeline-wide `--input` values with this resource's own overrides.
 *
 * Resource-specific values win; the result is filtered to the resource's own
 * input schema so pipeline-wide values keep their existing broadcast semantics
 * (declared keys apply, everything else is ignored for that resource). Values
 * for OTHER resources are never read here, so nothing can leak to a sibling.
 */
export function mergeResourceInputs(
  filteredCliInputs: Record<string, string>,
  resourceInputs: ResourceInputsMap | undefined,
  resourceName: string
): Record<string, string> {
  const overrides = resourceInputs?.[resourceName];
  if (!overrides || Object.keys(overrides).length === 0) return filteredCliInputs;
  return { ...filteredCliInputs, ...overrides };
}
