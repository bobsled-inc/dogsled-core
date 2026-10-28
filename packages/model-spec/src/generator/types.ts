/**
 * Public types for the Model Spec model generator (SQL → Model Spec YAML).
 *
 * The generator is the inverse of the compiler: it accepts a SQL statement
 * (currently Snowflake views only) plus a set of pre-parsed source specs, and
 * returns one or more `TransformSpec` objects ready to be persisted as YAML.
 *
 * Failure mode is strict: any construct that cannot be losslessly mapped onto
 * Model Spec YAML throws a `ModelSpecGenerationError`. There is no implicit `raw_sql()`
 * fallback in v1 — round-trip fidelity is the contract.
 */

import type { SourceSpec, TransformSpec } from '../compiler/schemas.js';

export type ModelSpecSqlDialect = 'snowflake';

export interface ModelSpecGenerationOptions {
  /** SQL dialect of the input statement. Currently only `'snowflake'`. */
  dialect: ModelSpecSqlDialect;

  /**
   * Pre-parsed source specs the input SQL can reference. The generator resolves
   * `FROM` / `JOIN` table references against this set; an unmatched table is a
   * `ModelSpecGenerationError(UNRESOLVED_SOURCE)`.
   */
  sources: SourceSpec[];

  /** Name for the head model (the `SELECT` outside any CTE). Default: `generated_model`. */
  modelName?: string;

  /** Description on the head model. Default: `'Generated from SQL'`. */
  description?: string;

  /**
   * Prefix applied to ephemeral models lifted from `WITH` clauses.
   * Default: `<modelName>__`.
   */
  cteNamePrefix?: string;

  /** Default `connection` value when source `table` matches by short name only. */
  defaultConnection?: string;
}

export interface ModelSpecGenerationResult {
  /**
   * Models in topological order: ephemeral CTEs first, then the head model.
   * Each entry is a fully-validated `TransformSpec` (passed through
   * `TransformSpecSchema.parse` before return).
   */
  models: TransformSpec[];

  /** Non-fatal observations (e.g. defaulted descriptions, picked grain). */
  warnings: string[];
}

export type ModelSpecGenerationErrorCode =
  | 'PARSE_ERROR'
  | 'UNSUPPORTED_DIALECT'
  | 'UNSUPPORTED_STATEMENT'
  | 'UNSUPPORTED_CONSTRUCT'
  | 'UNRESOLVED_SOURCE'
  | 'AMBIGUOUS_SOURCE'
  | 'AMBIGUOUS_COLUMN'
  | 'UNNAMED_COLUMN'
  | 'UNRESOLVED_TABLE_ALIAS';

export class ModelSpecGenerationError extends Error {
  readonly code: ModelSpecGenerationErrorCode;
  readonly sqlSnippet: string | undefined;

  constructor(code: ModelSpecGenerationErrorCode, message: string, sqlSnippet?: string) {
    super(message);
    this.name = 'ModelSpecGenerationError';
    this.code = code;
    this.sqlSnippet = sqlSnippet;
  }
}
