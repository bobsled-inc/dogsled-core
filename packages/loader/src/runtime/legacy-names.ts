/**
 * Older names of Core's own warehouse objects that existing tables may still
 * carry. The Dogsled -> Bobsled rename never rewrites this file (COMPAT_PATHS
 * in the rename tooling); the names Core writes today live next to the code
 * that writes them and follow the rename.
 */

/** Earlier names of the loaded-at system column. Core takes them over in place. */
export const LEGACY_LOADED_AT_COLUMNS: readonly string[] = Object.freeze(['_dogsled_loaded_at']);

/** Every prefix of the loader's staging tables, old and new; user tables may use none of them. */
export const RESERVED_STAGING_TABLE_PREFIXES: readonly string[] = Object.freeze([
  '_dogsled_stg_',
  '_bobsled_stg_',
]);

/** Earlier prefixes of the loader's unique merge index (`<prefix><table>`). */
export const LEGACY_UNIQUE_INDEX_PREFIXES: readonly string[] = Object.freeze(['_dogsled_uq_']);

/** Earlier label (BigQuery) and table property (Databricks) that prove Core owns a reserved table. */
export const LEGACY_OWNERSHIP_LABELS: readonly string[] = Object.freeze(['dogsled_temp_dataset']);
