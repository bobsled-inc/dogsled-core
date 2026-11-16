import { assertDeclaredEnv } from '@bobsled-inc/protocol';
/**
 * Deep-walk object interpolation for `${{ env.VAR }}` and legacy `<field>_env`.
 *
 * Two token shapes resolve to env-var lookups; both hit the same injected
 * `SecretResolver`:
 *
 *   1. Whole-string `${{ env.NAME }}` on any string leaf:
 *        { account_identifier: "${{ env.SNOWFLAKE_ACCOUNT }}" }
 *      → { account_identifier: "<resolver.resolve('SNOWFLAKE_ACCOUNT')>" }
 *
 *   2. Legacy `<field>_env` suffix (e.g. `account_identifier_env`). The
 *      field's VALUE names the env var; the resolved value is written back
 *      under the stripped-suffix key and the `*_env` field is removed:
 *        { account_identifier_env: "SNOWFLAKE_ACCOUNT" }
 *      → { account_identifier: "<resolver.resolve('SNOWFLAKE_ACCOUNT')>" }
 *
 * If both shapes name the same logical field, the new-shape value wins; the
 * `*_env` key is dropped without a secret lookup.
 *
 * Non-string leaves are copied through unchanged. Arrays and nested objects
 * are walked recursively.
 *
 * Implementation notes:
 *   - The walker is async because the `SecretResolver` contract is async.
 *   - We resolve all tokens in parallel at each level for minimum latency
 *     when a managed-mode resolver calls out to a network-backed store.
 */

import type { SecretResolver } from './types.js';

/**
 * Whole-string env-token pattern. Mirrors the syntax already established by
 * Bobsled Core's extractor/loader (see
 * `packages/extractor/src/runtime/warehouse-extractor.ts`).
 */
const WHOLE_ENV_TEMPLATE_RE = /^\s*\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

const LEGACY_ENV_SUFFIX = '_env';

/**
 * Keys that would mutate an object's prototype chain if assigned directly.
 * We skip them during interpolation so a hostile YAML can't slip a polluted
 * `__proto__` mapping into the resolved integration object.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Callback invoked once per interpolation run when a legacy `*_env` field is
 * encountered. Receives the offending field name; the message text is up to
 * the caller so the library layer stays free of IO.
 */
export type LegacyFieldCallback = (fieldName: string) => void;

export interface InterpolateOptions {
  /**
   * Optional callback invoked on the first legacy `*_env` field encountered
   * during this interpolation run. Callers wanting a deprecation warning can
   * wire this into their own logger. When omitted, legacy usage is silent —
   * the library layer does not do IO of its own.
   */
  onLegacyField?: LegacyFieldCallback;
  authEnvVars?: readonly string[];
}

/**
 * Deep-interpolate a parsed object, resolving all `${{ env.X }}` tokens and
 * legacy `*_env` fields via the supplied resolver.
 */
export async function interpolateSecrets<T>(
  value: T,
  resolver: SecretResolver,
  options: InterpolateOptions = {}
): Promise<T> {
  const declared =
    value &&
    typeof value === 'object' &&
    'auth_env_vars' in value &&
    Array.isArray(value.auth_env_vars)
      ? value.auth_env_vars
      : [];
  const state: WalkState = {
    onLegacyField: options.onLegacyField,
    legacyFired: false,
    declared: [...(options.authEnvVars ?? declared), ...(resolver.declaredSecretNames ?? [])],
  };
  return (await interpolateValue(value, resolver, state)) as T;
}

interface WalkState {
  onLegacyField: LegacyFieldCallback | undefined;
  legacyFired: boolean;
  declared: readonly string[];
}

async function interpolateValue(
  value: unknown,
  resolver: SecretResolver,
  state: WalkState
): Promise<unknown> {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const match = value.match(WHOLE_ENV_TEMPLATE_RE);
    if (match) {
      const envName = match[1];
      if (!envName) return value;
      assertDeclaredEnv(envName, state.declared);
      return await resolver.resolve(envName);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => interpolateValue(item, resolver, state)));
  }

  if (typeof value === 'object') {
    return interpolateObject(value as Record<string, unknown>, resolver, state);
  }

  return value;
}

async function interpolateObject(
  obj: Record<string, unknown>,
  resolver: SecretResolver,
  state: WalkState
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = Object.create(null);

  // First pass: split keys into legacy-`_env` and regular, and identify the
  // logical field name for each legacy key so we know whether the new-shape
  // winner should suppress the legacy lookup. Prototype-polluting keys are
  // dropped entirely — no legitimate integration spec uses them, and
  // propagating them would let a hostile YAML mutate every object's prototype.
  const legacyKeys: { key: string; field: string }[] = [];
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (key.endsWith(LEGACY_ENV_SUFFIX) && typeof obj[key] === 'string') {
      const field = key.slice(0, -LEGACY_ENV_SUFFIX.length);
      if (FORBIDDEN_KEYS.has(field)) continue;
      legacyKeys.push({ key, field });
    }
  }

  // Second pass: resolve every non-legacy value first (including new-shape
  // whole-string tokens) so we know which logical fields already have values.
  await Promise.all(
    Object.entries(obj).map(async ([key, rawValue]) => {
      if (FORBIDDEN_KEYS.has(key)) return;
      if (key.endsWith(LEGACY_ENV_SUFFIX) && typeof rawValue === 'string') return;
      result[key] = await interpolateValue(rawValue, resolver, state);
    })
  );

  // Third pass: resolve legacy `*_env` fields *in parallel* — but only when
  // the stripped-field has not already been set by the new-shape path. The
  // deprecation callback fires for every legacy key we see (subject to the
  // one-shot guard) so users migrating field-by-field still get the warning
  // even when a new-shape value wins and suppresses the lookup.
  await Promise.all(
    legacyKeys.map(async ({ key, field }) => {
      if (state.onLegacyField && !state.legacyFired) {
        state.legacyFired = true;
        state.onLegacyField(key);
      }
      if (result[field] !== undefined) {
        // New-shape won; drop the `*_env` field without a lookup.
        return;
      }
      const envVarName = obj[key] as string;
      assertDeclaredEnv(envVarName, state.declared);
      result[field] = await resolver.resolve(envVarName);
    })
  );

  return result;
}
