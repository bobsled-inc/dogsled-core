/**
 * Dialect-aware factory for `CandidateRetrievalStrategy` instances.
 *
 * Today only DuckDB ships a runtime executor; Postgres / Snowflake / BigQuery
 * have tested pure SQL builders (`buildPostgresCandidateSql`,
 * `buildSnowflakeCandidateSql`, `buildBigQueryCandidateSql`) that runner
 * integration consumes when warehouse credentials reach CI. The factory
 * picks the right SQL builder per dialect and pairs it with the caller's
 * `query` runner — the runner keeps responsibility for execution.
 *
 * The dispatch layer lets callers write
 * `createCandidateRetrieval('snowflake', {...})` and expect identical
 * top-K behaviour gated by the cross-warehouse parity tolerance
 * (`topKEquivalent`).
 */

import { CommandError } from '@bobsled-inc/protocol';

import type {
  Candidate,
  CandidateRetrievalInput,
  CandidateRetrievalRow,
  CandidateRetrievalStrategy,
} from './interface.js';
import { validateCandidateRetrievalRow } from './interface.js';
import { DuckDbCandidateRetrieval, type DuckDbCandidateOptions } from './duckdb.js';
import {
  buildPostgresCandidateSql,
  buildSnowflakeCandidateSql,
  buildBigQueryCandidateSql,
} from './dialects.js';

export type SupportedRetrievalDialect = 'duckdb' | 'postgres' | 'snowflake' | 'bigquery';

export interface CandidateRetrievalQuery {
  /**
   * Run parameterised SQL and return rows shaped like {@link CandidateRetrievalRow}.
   * Adapters are responsible for projecting `entity_id / canonical_name / sim`
   * from the dialect-specific SQL; the strategy validates each row before
   * trusting it.
   */
  query: (sql: string, params: unknown[]) => Promise<readonly CandidateRetrievalRow[]>;
}

export interface CandidateRetrievalRegistryOptions {
  dialect: SupportedRetrievalDialect;
  /** Fully qualified `__entity_profile` table name. */
  profileTable: string;
  /** BigQuery only — pre-computed shingles table. Required for `dialect: 'bigquery'`. */
  shinglesTable?: string;
  /** Runner that executes the dialect-correct SQL. */
  runner: CandidateRetrievalQuery;
}

class GenericSqlCandidateRetrieval implements CandidateRetrievalStrategy {
  constructor(
    public readonly dialect: SupportedRetrievalDialect,
    private readonly buildSql: (entityTypes?: readonly string[]) => string,
    private readonly runner: CandidateRetrievalQuery
  ) {}

  async retrieve(input: CandidateRetrievalInput): Promise<Candidate[]> {
    // Canonical positional order: [mention_text, min_sim, k]. BigQuery's
    // runner adapter rebinds these to its named-parameter shape
    // (`@mention`/`@min_sim`/`@k`); other dialects bind positionally.
    const params: unknown[] = [input.mention_text, input.min_sim, input.k];
    const sql = this.buildSql(input.entity_types);
    const rows = await this.runner.query(sql, params);
    return rows.map((row, index) => validateCandidateRetrievalRow(row, index));
  }
}

/**
 * Factory: pick the right dialect strategy. Throws `CommandError(2)` for
 * unsupported dialects or missing dialect-specific options (e.g. BigQuery
 * `shinglesTable`).
 */
export function createCandidateRetrieval(
  options: CandidateRetrievalRegistryOptions
): CandidateRetrievalStrategy {
  switch (options.dialect) {
    case 'duckdb': {
      const opts: DuckDbCandidateOptions = {
        profileTable: options.profileTable,
        query: (sql, params) => options.runner.query(sql, params),
      };
      return new DuckDbCandidateRetrieval(opts);
    }
    case 'postgres':
      return new GenericSqlCandidateRetrieval(
        'postgres',
        (entityTypes) => buildPostgresCandidateSql(options.profileTable, entityTypes ?? []),
        options.runner
      );
    case 'snowflake':
      return new GenericSqlCandidateRetrieval(
        'snowflake',
        (entityTypes) => buildSnowflakeCandidateSql(options.profileTable, entityTypes ?? []),
        options.runner
      );
    case 'bigquery': {
      if (!options.shinglesTable) {
        throw new CommandError(
          `dialect: 'bigquery' requires a shinglesTable option (pre-computed at extract time).`,
          2
        );
      }
      return new GenericSqlCandidateRetrieval(
        'bigquery',
        (entityTypes) =>
          buildBigQueryCandidateSql(
            options.profileTable,
            options.shinglesTable!,
            entityTypes ?? []
          ),
        options.runner
      );
    }
    default: {
      const exhaustive: never = options.dialect;
      throw new CommandError(`Unsupported candidate-retrieval dialect: ${String(exhaustive)}`, 2);
    }
  }
}
