/**
 * Earlier names of a project's local state folder and its DuckDB file. The
 * Dogsled -> Bobsled rename never rewrites this file (COMPAT_PATHS); the
 * current names live in local-state-dir.ts and follow the rename.
 */
export const LEGACY_LOCAL_STATE_DIRS: readonly string[] = Object.freeze(['.dogsled']);

/** Earlier name of the default local DuckDB file inside the state folder. */
export const LEGACY_LOCAL_DATABASE_FILES: readonly string[] = Object.freeze(['dogsled.duckdb']);
