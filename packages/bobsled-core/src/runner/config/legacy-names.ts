/**
 * Old and new spellings that pipeline config readers keep accepting. The
 * Dogsled -> Bobsled rename never rewrites this file (COMPAT_PATHS).
 */

/** Every prefix of the loader's staging tables (same list as the loader's legacy-names.ts). */
export const RESERVED_STAGING_TABLE_PREFIXES: readonly string[] = Object.freeze([
  '_dogsled_stg_',
  '_bobsled_stg_',
]);
