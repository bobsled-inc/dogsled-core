import type { SqlStatement } from '../identity/types.js';

export interface LineageRow {
  entity_type: string;
  /** null = schema-level lineage (not bound to a specific entity instance) */
  entity_id: string | null;
  attribute: string;
  profile_table: string;
  profile_column: string;
  source_system: string | null;
  /**
   * Fully-qualified upstream table name. Empty string when is_complete=false
   * (alias unresolvable). Kept non-nullable so callers always test is_complete
   * rather than null-checking this field.
   */
  source_table: string;
  source_column: string;
  field_path: string | null;
  /** Comma-separated list of applied standardize/transform function names */
  transform_ref: string | null;
  /** Pipeline step that applied the transform (e.g. 'standardize', 'clean') */
  transform_step: string | null;
  /** false when lineage could not be fully traced (e.g. raw_sql, opaque transforms) */
  is_complete: boolean;
}

export interface LineageCompileResult {
  entity_type: string;
  rows: LineageRow[];
  warnings: string[];
  statements: SqlStatement[];
}
