/**
 * Shared constants for warehouse/lakehouse client config validation.
 * Kept in a separate module to avoid pulling in native duckdb bindings.
 */

/** Maximum statement timeout (24 hours). Shared across DB client config parsers. */
export const MAX_STATEMENT_TIMEOUT_MS = 86_400_000;
