/**
 * Every generation of Core's agentic names that saved runs, executors and
 * warehouses may still carry. The Dogsled -> Bobsled rename never rewrites
 * this file (COMPAT_PATHS); the names Core writes today live next to the code
 * that writes them and follow the rename.
 */

/**
 * Spellings of each agentic metadata column, oldest first. The first spelling
 * is the canonical one inside saved digests (run identity, publication
 * identity), so a run's digests do not change when Core's column names do.
 */
export const AGENTIC_METADATA_SPELLINGS = Object.freeze({
  run_id: Object.freeze(['_dogsled_run_id', '_bobsled_run_id']),
  evidence: Object.freeze(['_dogsled_evidence', '_bobsled_evidence']),
  confidence: Object.freeze(['_dogsled_confidence', '_bobsled_confidence']),
  reason: Object.freeze(['_dogsled_reason', '_bobsled_reason']),
} as const);

/** Prefixes a user's agentic output column may not use. */
export const RESERVED_AGENTIC_COLUMN_PREFIXES: readonly string[] = Object.freeze([
  '_dogsled_',
  '_bobsled_',
  '_track_',
]);

/** Earlier prefix of the row store's tables (`<prefix>runs`, `<prefix>rows`, `<prefix>cursors`). */
export const LEGACY_AGENTIC_TABLE_PREFIXES: readonly string[] = Object.freeze([
  '__dogsled_agentic_',
]);

/** Earlier names of the warehouse store's cursor table. */
export const LEGACY_WAREHOUSE_CURSOR_TABLES: readonly string[] = Object.freeze([
  '__dogsled_cursors',
]);

/** Earlier prefix of the warehouse checkpoint tables (`<prefix><hash>_c`, `<prefix><hash>_p`). */
export const LEGACY_CHECKPOINT_TABLE_PREFIXES: readonly string[] = Object.freeze(['__dogsled_cp_']);

/** Earlier prefix of the publication metadata tables; reserved together with the current one. */
export const LEGACY_PUBLICATION_TABLE_PREFIXES: readonly string[] = Object.freeze([
  '_dogsled_pub_',
]);

/** Earlier name of the DuckDB publication schema. */
export const LEGACY_DUCKDB_PUBLICATION_SCHEMAS: readonly string[] = Object.freeze([
  '_dogsled_agentic_publication',
]);
