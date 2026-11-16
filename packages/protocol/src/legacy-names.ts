/**
 * Every Blueprint spelling Core reads, old and new.
 *
 * The Dogsled -> Bobsled rename never rewrites this file (COMPAT_PATHS in the
 * rename tooling), so stored Blueprints keep validating whichever spelling
 * they use. The spelling Core treats as current lives in
 * legacy-blueprint-aliases.ts and follows the rename.
 */
export const BLUEPRINT_KEY_SPELLINGS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['dogsled_connection_ref', 'bobsled_connection_ref']),
  Object.freeze(['dogsled_source_kind', 'bobsled_source_kind']),
]);

/** Exact managed destination types; never a prefix (`bobsled_managed_snowflake` is a value). */
export const MANAGED_DESTINATION_TYPE_SPELLINGS: readonly string[] = Object.freeze([
  'dogsled_managed',
  'bobsled_managed',
]);

/** Prefixes of host extension keys that Core ignores in sources and destinations. */
export const BLUEPRINT_EXTENSION_KEY_PREFIXES: readonly string[] = Object.freeze([
  'dogsled_',
  'bobsled_',
]);

/** Destination types that are retired and stay rejected. */
export const RETIRED_DESTINATION_TYPES: readonly string[] = Object.freeze(['bobsled_lakehouse']);
