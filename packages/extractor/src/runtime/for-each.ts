import type { Predicate } from '../framework/extractor/predicate.js';
import type { ApiResourceSpec } from '../types/index.js';
import type { JsonObject, JsonValue } from '@bobsled-inc/protocol';
import type { OutputFieldDefinition } from '../framework/core/fields.js';
import { extractJsonPath } from '../framework/runtime/output-mapper.js';

declare const FanOutContextBrand: unique symbol;

/** Opaque immutable lineage handle. Construct with `createFanOutContext()`. */
export interface FanOutContext {
  readonly [FanOutContextBrand]: true;
}

const fanOutOutputs = new WeakMap<FanOutContext, ReadonlyMap<string, Readonly<JsonObject>>>();

function makeFanOutContext(
  outputsByResource: ReadonlyMap<string, Readonly<JsonObject>>
): FanOutContext {
  const context = Object.freeze({}) as FanOutContext;
  fanOutOutputs.set(context, outputsByResource);
  return context;
}

function requireFanOutOutputs(context: FanOutContext): ReadonlyMap<string, Readonly<JsonObject>> {
  const outputs = fanOutOutputs.get(context);
  if (!outputs) throw new Error('Invalid FanOutContext; use createFanOutContext()');
  return outputs;
}

export function getFanOutContextOutput(
  context: FanOutContext,
  resource: string
): Readonly<JsonObject> | undefined {
  return requireFanOutOutputs(context).get(resource);
}

export interface FanOutWorkItem {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly context: FanOutContext;
}

export const MAX_FAN_OUT_PRIMARY_KEYS = 100_000;

export interface FanOutPrimaryKeyReport {
  observed: number;
  collisions: number;
  truncated: boolean;
}

/** Bounded detector for child key tuples reused under different ancestry. */
export class FanOutPrimaryKeyTracker {
  readonly #primaryKey: readonly string[];
  readonly #output: Record<string, OutputFieldDefinition>;
  readonly #limit: number;
  readonly #contextsByKey = new Map<string, string>();
  readonly #collidingKeys = new Set<string>();
  #observed = 0;
  #truncated = false;

  constructor(resource: ApiResourceSpec, limit = MAX_FAN_OUT_PRIMARY_KEYS) {
    this.#primaryKey = resource.extract.table?.primary_key ?? [];
    this.#output = resource.output;
    this.#limit = Math.max(0, limit);
  }

  get enabled(): boolean {
    return (
      this.#primaryKey.length > 0 &&
      Object.values(this.#output).some((field) => field.from && 'resource' in field.from)
    );
  }

  observe(record: Record<string, unknown>, context: FanOutContext): void {
    if (!this.enabled) return;
    const tuple = this.#primaryKey.map((name) => record[name]);
    if (tuple.some((value) => value === undefined || value === null)) return;
    this.#observed += 1;

    const keyIdentity = JSON.stringify(tuple);
    const contextIdentity = JSON.stringify(getContextProjectionValues(this.#output, context));
    const priorContext = this.#contextsByKey.get(keyIdentity);
    if (priorContext !== undefined) {
      if (priorContext !== contextIdentity) this.#collidingKeys.add(keyIdentity);
      return;
    }
    if (this.#contextsByKey.size >= this.#limit) {
      this.#truncated = true;
      return;
    }
    this.#contextsByKey.set(keyIdentity, contextIdentity);
  }

  report(): FanOutPrimaryKeyReport {
    return {
      observed: this.#observed,
      collisions: this.#collidingKeys.size,
      truncated: this.#truncated,
    };
  }
}

export const EMPTY_FAN_OUT_CONTEXT: FanOutContext = makeFanOutContext(new Map());

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson)) as unknown as JsonValue;
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = Object.create(null) as JsonObject;
    for (const [key, entry] of Object.entries(value)) result[key] = freezeJson(entry);
    return Object.freeze(result);
  }
  return value;
}

export function extendFanOutContext(
  context: FanOutContext,
  resource: string,
  output: Record<string, unknown>
): FanOutContext {
  const snapshot = freezeJson(output as JsonObject) as Readonly<JsonObject>;
  const outputsByResource = new Map(requireFanOutOutputs(context));
  outputsByResource.set(resource, snapshot);
  return makeFanOutContext(outputsByResource);
}

/**
 * Construct a defensive, immutable lineage context for public mapping APIs.
 * Input objects are deep-copied and frozen; callers never receive a mutable
 * reference to the stored ancestor outputs.
 */
export function createFanOutContext(outputs: Readonly<Record<string, JsonObject>>): FanOutContext {
  let context = EMPTY_FAN_OUT_CONTEXT;
  for (const [resource, output] of Object.entries(outputs)) {
    context = extendFanOutContext(context, resource, output);
  }
  return context;
}

export function getContextProjectionValues(
  output: Record<string, OutputFieldDefinition>,
  context: FanOutContext
): unknown[] {
  const values: unknown[] = [];
  for (const field of Object.values(output)) {
    if (!field.from || !('resource' in field.from)) continue;
    const ancestor = getFanOutContextOutput(context, field.from.resource);
    values.push(extractJsonPath(ancestor, field.from.path));
  }
  return values;
}

export function assertCompleteFanOutContext(
  resourceName: string,
  output: Record<string, OutputFieldDefinition>,
  context: FanOutContext
): void {
  for (const [name, field] of Object.entries(output)) {
    if (!field.from || !('resource' in field.from)) continue;
    const ancestor = getFanOutContextOutput(context, field.from.resource);
    const value = extractJsonPath(ancestor, field.from.path);
    if (value === undefined || value === null) {
      throw new Error(
        `Incomplete fan-out context for "${resourceName}.${name}": ` +
          `"${field.from.resource}${field.from.path.slice(1)}" is missing`
      );
    }
  }
}

/**
 * Build the only safe context available to a targeted child extraction: a
 * direct-parent output value (or a declared descendant of that value) that is
 * carried by a supplied child input. No other ancestor value is inferred.
 */
export function buildTargetedFanOutContext(
  resource: ApiResourceSpec,
  forEach: NormalizedForEachConfig,
  inputs: Record<string, unknown>,
  output: Record<string, OutputFieldDefinition> = resource.output
): FanOutContext {
  const contextualFields = Object.values(output).filter(
    (field) => field.from && 'resource' in field.from
  );
  if (contextualFields.length === 0) return EMPTY_FAN_OUT_CONTEXT;

  const parentOutput: JsonObject = Object.create(null) as JsonObject;
  for (const field of contextualFields) {
    if (!field.from || !('resource' in field.from)) continue;
    const origin = field.from;
    const binding = forEach.bindings.find((candidate) => {
      if (candidate.source !== 'output' || origin.resource !== forEach.resource) return false;
      const boundPath = `$.${candidate.field}`;
      return (
        origin.path === boundPath ||
        origin.path.startsWith(`${boundPath}.`) ||
        origin.path.startsWith(`${boundPath}[`)
      );
    });
    if (!binding || !Object.hasOwn(inputs, binding.input)) {
      throw new Error(
        `Targeted extraction of "${resource.name}" cannot prove contextual output ` +
          `from "${origin.resource}${origin.path.slice(1)}"; co-schedule its fan-out ancestors`
      );
    }
    parentOutput[binding.field] = inputs[binding.input] as JsonValue;
  }
  return extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, forEach.resource, parentOutput);
}

export interface NormalizedForEachBinding {
  field: string;
  input: string;
  source: 'input' | 'output';
}

export interface NormalizedForEachConfig {
  resource: string;
  bindings: NormalizedForEachBinding[];
  concurrency: number;
  /** Optional predicates that filter the parent record set before iteration. */
  where?: Predicate[];
}

export function normalizeForEachConfig(
  forEach: ApiResourceSpec['extract']['for_each'] | undefined
): NormalizedForEachConfig | undefined {
  if (!forEach) {
    return undefined;
  }

  const concurrency = forEach.concurrency ?? 1;
  // Both for_each shapes (legacy field/input and bindings) optionally carry a
  // `where` filter list. Surface it verbatim — the extract loop materializes
  // and applies it per-parent before building iteration inputs.
  const where = forEach.where as Predicate[] | undefined;

  if ('bindings' in forEach) {
    return {
      resource: forEach.resource,
      bindings: forEach.bindings.map((binding) => ({
        field: binding.field,
        input: binding.input,
        source: binding.source ?? 'output',
      })),
      concurrency,
      ...(where ? { where } : {}),
    };
  }

  return {
    resource: forEach.resource,
    bindings: [
      {
        field: forEach.field,
        input: forEach.input,
        source: 'output',
      },
    ],
    concurrency,
    ...(where ? { where } : {}),
  };
}

export function getForEachBoundInputs(
  forEach: ApiResourceSpec['extract']['for_each'] | undefined
): Set<string> {
  return new Set(normalizeForEachConfig(forEach)?.bindings.map((binding) => binding.input) ?? []);
}

/**
 * Return true when the caller supplied every input normally populated by
 * `for_each`. In that case the request is an explicit targeted lookup and must
 * not be widened or overwritten with values from the parent resource.
 */
export function hasExplicitForEachInputs(
  forEach: NormalizedForEachConfig,
  inputs: Record<string, unknown>
): boolean {
  return forEach.bindings.every((binding) => Object.hasOwn(inputs, binding.input));
}

/**
 * Project the iteration's `mergedInputs` map down to just the keys that the
 * `for_each.bindings` actually drive. The result is suitable for passing to
 * `buildBookmarkPartition` so the resource's bookmark slot is scoped to that
 * one iteration.
 */
export function pickForEachBindingValues(
  bindings: ReadonlyArray<{ input: string }>,
  mergedInputs: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(bindings.map((b) => [b.input, mergedInputs[b.input]]));
}

/**
 * Dispatch `worker(item)` over `items` with at most `concurrency` invocations
 * in flight at a time. Returns when every worker loop has settled — an
 * uncaught throw from one iteration never cancels in-flight siblings or stops
 * scheduling. If any iteration threw, the first such error is rethrown after
 * all loops complete. Callers that want fully silent best-effort semantics
 * (the extract loop does this) should wrap their per-iteration work in
 * try/catch inside `worker` so nothing propagates.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  let firstError: unknown;
  const runOne = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await worker(items[index]!);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, runOne));
  if (firstError !== undefined) {
    throw firstError;
  }
}
