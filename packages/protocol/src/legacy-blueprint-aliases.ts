import {
  BLUEPRINT_KEY_SPELLINGS,
  MANAGED_DESTINATION_TYPE_SPELLINGS,
  RETIRED_DESTINATION_TYPES,
} from './legacy-names.js';

export const BOBSLED_CORE_LEGACY_BLUEPRINT_KEY = 'BOBSLED_CORE_LEGACY_BLUEPRINT_KEY';
export const LEGACY_KEY_CONFLICT = 'LEGACY_KEY_CONFLICT';

export const BLUEPRINT_CONNECTION_REF_KEY = 'bobsled_connection_ref';
export const BLUEPRINT_SOURCE_KIND_KEY = 'bobsled_source_kind';
export const MANAGED_DESTINATION_TYPE = 'bobsled_managed';

function aliasesTo(spellings: readonly string[], current: string): Record<string, string> {
  if (!spellings.includes(current)) {
    throw new Error(`Blueprint spelling ${current} is missing from legacy-names.ts.`);
  }
  return Object.fromEntries(
    spellings.filter((spelling) => spelling !== current).map((spelling) => [spelling, current])
  );
}

function keyAliases(): Readonly<Record<string, string>> {
  const current = [BLUEPRINT_CONNECTION_REF_KEY, BLUEPRINT_SOURCE_KIND_KEY];
  return Object.freeze(
    Object.assign(
      {},
      ...current.map((key) => {
        const spellings = BLUEPRINT_KEY_SPELLINGS.find((group) => group.includes(key));
        if (!spellings) throw new Error(`Blueprint key ${key} is missing from legacy-names.ts.`);
        return aliasesTo(spellings, key);
      })
    )
  );
}

/** Other spellings of the Blueprint keys, each mapped to the current one. Accepted without a warning. */
export const LEGACY_BLUEPRINT_KEY_ALIASES: Readonly<Record<string, string>> = keyAliases();

/** Other spellings of the managed destination type, mapped to the current one. */
export const LEGACY_DESTINATION_TYPE_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  aliasesTo(MANAGED_DESTINATION_TYPE_SPELLINGS, MANAGED_DESTINATION_TYPE)
);

export const REJECTED_LEGACY_DESTINATION_TYPES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(RETIRED_DESTINATION_TYPES.map((type) => [type, MANAGED_DESTINATION_TYPE]))
);

/** True for every accepted spelling of the managed destination type (an exact list, not a prefix). */
export function isManagedDestinationType(type: unknown): boolean {
  return typeof type === 'string' && MANAGED_DESTINATION_TYPE_SPELLINGS.includes(type);
}

export interface LegacyBlueprintDeprecation {
  readonly code: typeof BOBSLED_CORE_LEGACY_BLUEPRINT_KEY;
  readonly path: string;
  readonly oldKey: string;
  readonly newKey: string;
}

export interface NormalizeLegacyBlueprintOptions {
  readonly path?: string;
  readonly kind: 'integration' | 'source' | 'pipeline_config' | 'destination';
}

export interface NormalizeLegacyBlueprintResult {
  readonly document: unknown;
  readonly deprecations: readonly LegacyBlueprintDeprecation[];
}

export class LegacyBlueprintKeyConflictError extends Error {
  readonly code = LEGACY_KEY_CONFLICT;

  constructor(
    readonly path: string,
    readonly oldKey: string,
    readonly newKey: string
  ) {
    super(`${LEGACY_KEY_CONFLICT}${path ? `: ${path}` : ''}: ${oldKey} conflicts with ${newKey}`);
    this.name = 'LegacyBlueprintKeyConflictError';
  }
}

export function formatLegacyBlueprintDeprecation(deprecation: LegacyBlueprintDeprecation): string {
  return `${deprecation.code}${deprecation.path ? `: ${deprecation.path}` : ''}: ${deprecation.oldKey} is deprecated; use ${deprecation.newKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equalValues(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    if (seen.has(left)) return seen.get(left) === right;
    seen.set(left, right);
    return left.every((value, index) => equalValues(value, right[index], seen));
  }
  if (seen.has(left)) return seen.get(left) === right;
  seen.set(left, right);
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalValues(left[key], right[key], seen))
  );
}

export function normalizeLegacyBlueprintKeys(
  document: unknown,
  options: NormalizeLegacyBlueprintOptions
): NormalizeLegacyBlueprintResult {
  const path = options.path ?? '';
  const deprecations: LegacyBlueprintDeprecation[] = [];
  const kind = options.kind;

  function rename(input: unknown, destination: boolean): unknown {
    if (!isRecord(input)) return input;
    const result = { ...input };
    for (const [oldKey, newKey] of Object.entries(LEGACY_BLUEPRINT_KEY_ALIASES)) {
      if (destination && newKey !== BLUEPRINT_CONNECTION_REF_KEY) continue;
      if (!Object.hasOwn(input, oldKey)) continue;
      if (Object.hasOwn(input, newKey) && !equalValues(input[oldKey], input[newKey])) {
        throw new LegacyBlueprintKeyConflictError(path, oldKey, newKey);
      }
      result[newKey] = input[oldKey];
      delete result[oldKey];
    }
    const type = input['type'];
    if (
      destination &&
      typeof type === 'string' &&
      Object.hasOwn(LEGACY_DESTINATION_TYPE_ALIASES, type)
    ) {
      result['type'] = LEGACY_DESTINATION_TYPE_ALIASES[type];
    }
    return result;
  }

  if (kind !== 'pipeline_config') {
    return { document: rename(document, kind === 'destination'), deprecations };
  }
  if (!isRecord(document) || !isRecord(document['destinations'])) {
    return { document, deprecations };
  }
  const destinations = Object.fromEntries(
    Object.entries(document['destinations']).map(([name, destination]) => [
      name,
      rename(destination, true),
    ])
  );
  return { document: { ...document, destinations }, deprecations };
}
