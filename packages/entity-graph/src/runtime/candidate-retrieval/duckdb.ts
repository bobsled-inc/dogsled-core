/**
 * DuckDB candidate retrieval — `jaro_winkler_similarity` on
 * `__entity_profile` canonical names and profile aliases. The default for
 * `dogsled init --local`.
 *
 * `profileTable` is validated by `assertSafeIdentifier` before
 * interpolation; the similarity expression is computed once in a CTE so
 * SELECT and WHERE share the same value.
 */

import type {
  Candidate,
  CandidateRetrievalInput,
  CandidateRetrievalRow,
  CandidateRetrievalStrategy,
} from './interface.js';
import { validateCandidateRetrievalRow } from './interface.js';
import { assertSafeIdentifier, buildEntityTypeFilterSql } from './sql-utils.js';

export interface DuckDbCandidateOptions {
  /**
   * The fully-qualified `__entity_profile` table name (e.g.
   * `entity_graph.entity_profile_customer`).
   */
  profileTable: string;
  /**
   * Function the runner provides to execute parameterised SQL and return
   * rows. Kept abstract so tests can inject in-memory DuckDB or a stub.
   * Adapters MAY return loosely-typed rows; the strategy validates each
   * one via `validateCandidateRetrievalRow` before trusting it.
   */
  query: (sql: string, params: unknown[]) => Promise<readonly CandidateRetrievalRow[]>;
}

export function buildDuckDbCandidateSql(
  profileTable: string,
  entityTypes: readonly string[] = []
): string {
  const safeTable = assertSafeIdentifier(profileTable, 'DuckDB candidate-retrieval profileTable');
  const entityFilter = buildEntityTypeFilterSql(entityTypes, 'p.entity_type', 'duckdb');
  const mentionEligibleFilter =
    "AND LOWER(COALESCE(json_extract_string(p.profile_attrs, '$.mention_eligible'), 'true')) <> 'false'";
  return `WITH candidate_surfaces AS (
            SELECT
              p.entity_id,
              p.entity_type,
              p.canonical_name,
              CAST(p.profile_attrs AS VARCHAR) AS profile_attrs,
              p.canonical_name AS matched_text,
              'canonical_name' AS match_source
            FROM ${safeTable} p
            WHERE p.canonical_name IS NOT NULL
              AND length(trim(p.canonical_name)) > 0
              ${mentionEligibleFilter}
              ${entityFilter}

            UNION ALL

            SELECT
              p.entity_id,
              p.entity_type,
              p.canonical_name,
              CAST(p.profile_attrs AS VARCHAR) AS profile_attrs,
              json_extract_string(alias_item.value, '$') AS matched_text,
              'profile_attrs.aliases_json' AS match_source
            FROM ${safeTable} p,
                 json_each(
                   CASE
                     WHEN json_valid(json_extract_string(p.profile_attrs, '$.aliases_json'))
                       THEN json_extract_string(p.profile_attrs, '$.aliases_json')
                     ELSE '[]'
                   END
                 ) AS alias_item
            WHERE json_extract_string(alias_item.value, '$') IS NOT NULL
              AND length(trim(json_extract_string(alias_item.value, '$'))) > 0
              ${mentionEligibleFilter}
              ${entityFilter}
          ),
          computed AS (
            SELECT
              entity_id,
              entity_type,
              canonical_name,
              matched_text,
              match_source,
              profile_attrs,
              jaro_winkler_similarity(LOWER(matched_text), LOWER(?)) AS sim
            FROM candidate_surfaces
          ),
          ranked AS (
            SELECT
              *,
              ROW_NUMBER() OVER (
                PARTITION BY entity_type, entity_id
                ORDER BY sim DESC, match_source ASC, matched_text ASC
              ) AS rn
            FROM computed
            WHERE sim >= ?
          )
          SELECT entity_id, entity_type, canonical_name, matched_text, match_source, profile_attrs, sim
          FROM ranked
          WHERE rn = 1
          ORDER BY sim DESC, entity_type ASC, entity_id ASC
          LIMIT ?`;
}

export class DuckDbCandidateRetrieval implements CandidateRetrievalStrategy {
  readonly dialect = 'duckdb' as const;

  constructor(private readonly options: DuckDbCandidateOptions) {}

  async retrieve(input: CandidateRetrievalInput): Promise<Candidate[]> {
    const sql = buildDuckDbCandidateSql(this.options.profileTable, input.entity_types ?? []);
    const rows = await this.options.query(sql, [input.mention_text, input.min_sim, input.k]);
    return rows.map((row, index) => validateCandidateRetrievalRow(row, index));
  }
}
