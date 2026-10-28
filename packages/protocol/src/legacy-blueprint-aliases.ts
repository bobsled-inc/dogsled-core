export const DOGSLED_LEGACY_BLUEPRINT_KEY = 'DOGSLED_LEGACY_BLUEPRINT_KEY';
export const LEGACY_KEY_CONFLICT = 'LEGACY_KEY_CONFLICT';

export const LEGACY_BLUEPRINT_KEY_ALIASES = Object.freeze({
  bobsled_connection_ref: 'dogsled_connection_ref',
  bobsled_source_kind: 'dogsled_source_kind',
} as const);

export const LEGACY_DESTINATION_TYPE_ALIASES = Object.freeze({
  bobsled_managed: 'dogsled_managed',
} as const);

export const REJECTED_LEGACY_DESTINATION_TYPES = Object.freeze({
  bobsled_lakehouse: 'dogsled_managed',
} as const);

export interface LegacyBlueprintDeprecation {
  readonly code: typeof DOGSLED_LEGACY_BLUEPRINT_KEY;
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
      if (destination && newKey !== 'dogsled_connection_ref') continue;
      if (!Object.hasOwn(input, oldKey)) continue;
      if (Object.hasOwn(input, newKey) && !equalValues(input[oldKey], input[newKey])) {
        throw new LegacyBlueprintKeyConflictError(path, oldKey, newKey);
      }
      result[newKey] = input[oldKey];
      delete result[oldKey];
      deprecations.push({ code: DOGSLED_LEGACY_BLUEPRINT_KEY, path, oldKey, newKey });
    }
    const type = input['type'];
    if (
      destination &&
      typeof type === 'string' &&
      Object.hasOwn(LEGACY_DESTINATION_TYPE_ALIASES, type)
    ) {
      const newKey =
        LEGACY_DESTINATION_TYPE_ALIASES[type as keyof typeof LEGACY_DESTINATION_TYPE_ALIASES];
      result['type'] = newKey;
      deprecations.push({ code: DOGSLED_LEGACY_BLUEPRINT_KEY, path, oldKey: type, newKey });
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
