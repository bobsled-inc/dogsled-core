/**
 * Postgres / Snowflake / BigQuery candidate-retrieval SQL builders.
 *
 * Each dialect uses its native fuzzy-match
 * function. All builders:
 *  - validate the table identifier via `assertSafeIdentifier` before
 *    interpolation;
 *  - compute the similarity expression once in a CTE/subquery so SELECT
 *    and WHERE share the same value (single-evaluation.
 */

import { CommandError } from '@bobsled-inc/protocol';

import { assertSafeIdentifier, buildEntityTypeFilterSql } from './sql-utils.js';

const BIGQUERY_PROJECT_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const BIGQUERY_SEGMENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function buildBigQueryTableIdentifier(identifier: string, context: string): string {
  const parts = identifier.split('.');
  if (parts.length === 3 && parts[0]!.includes('-')) {
    const [project, dataset, table] = parts as [string, string, string];
    if (
      !BIGQUERY_PROJECT_PATTERN.test(project) ||
      !BIGQUERY_SEGMENT_PATTERN.test(dataset) ||
      !BIGQUERY_SEGMENT_PATTERN.test(table)
    ) {
      throw new CommandError(`Invalid SQL identifier '${identifier}' for ${context}.`, 2);
    }
    return `\`${project}\`.${dataset}.${table}`;
  }
  return assertSafeIdentifier(identifier, context);
}

export function buildPostgresCandidateSql(
  profileTable: string,
  entityTypes: readonly string[] = []
): string {
  const safeTable = assertSafeIdentifier(profileTable, 'Postgres candidate-retrieval profileTable');
  const entityFilter = buildEntityTypeFilterSql(entityTypes, 'p.entity_type', 'postgres');
  const mentionEligibleFilter =
    "AND LOWER(COALESCE(p.profile_attrs::jsonb ->> 'mention_eligible', 'true')) <> 'false'";
  // pg_trgm `%` operator with GIN index on lower(canonical_name) gin_trgm_ops.
  return `WITH candidate_surfaces AS (
            SELECT
              p.entity_id,
              p.entity_type,
              p.canonical_name,
              p.profile_attrs::text AS profile_attrs,
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
              p.profile_attrs::text AS profile_attrs,
              alias_value AS matched_text,
              'profile_attrs.aliases_json' AS match_source
            FROM ${safeTable} p
            CROSS JOIN LATERAL jsonb_array_elements_text(
              COALESCE((p.profile_attrs::jsonb ->> 'aliases_json')::jsonb, '[]'::jsonb)
            ) alias_rows(alias_value)
            WHERE alias_value IS NOT NULL
              AND length(trim(alias_value)) > 0
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
              similarity(LOWER(matched_text), LOWER($1)) AS sim
            FROM candidate_surfaces
            WHERE LOWER(matched_text) % LOWER($1)
          ),
          ranked AS (
            SELECT
              *,
              ROW_NUMBER() OVER (
                PARTITION BY entity_type, entity_id
                ORDER BY sim DESC, match_source ASC, matched_text ASC
              ) AS rn
            FROM computed
            WHERE sim >= $2
          )
          SELECT entity_id, entity_type, canonical_name, matched_text, match_source, profile_attrs, sim
          FROM ranked
          WHERE rn = 1
          ORDER BY sim DESC, entity_type ASC, entity_id ASC
          LIMIT $3`;
}

export function buildSnowflakeCandidateSql(
  profileTable: string,
  entityTypes: readonly string[] = []
): string {
  const safeTable = assertSafeIdentifier(
    profileTable,
    'Snowflake candidate-retrieval profileTable'
  );
  const entityFilter = buildEntityTypeFilterSql(entityTypes, 'p.entity_type', 'snowflake');
  const mentionEligibleFilter =
    "AND LOWER(COALESCE(TRY_PARSE_JSON(TO_VARCHAR(p.profile_attrs)):mention_eligible::STRING, 'true')) <> 'false'";
  // JAROWINKLER_SIMILARITY returns 0-100; normalize to 0-1 once.
  return `WITH candidate_surfaces AS (
            SELECT
              p.entity_id,
              p.entity_type,
              p.canonical_name,
              TO_VARCHAR(p.profile_attrs) AS profile_attrs,
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
              TO_VARCHAR(p.profile_attrs) AS profile_attrs,
              alias_item.value::STRING AS matched_text,
              'profile_attrs.aliases_json' AS match_source
            FROM ${safeTable} p,
                 LATERAL FLATTEN(
                   input => COALESCE(TRY_PARSE_JSON(TRY_PARSE_JSON(TO_VARCHAR(p.profile_attrs)):aliases_json::STRING), ARRAY_CONSTRUCT())
                 ) alias_item
            WHERE alias_item.value::STRING IS NOT NULL
              AND length(trim(alias_item.value::STRING)) > 0
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
              JAROWINKLER_SIMILARITY(LOWER(matched_text), LOWER(?)) / 100.0 AS sim
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

export function buildBigQueryCandidateSql(
  profileTable: string,
  shinglesTable: string,
  entityTypes: readonly string[] = []
): string {
  const safeProfile = buildBigQueryTableIdentifier(
    profileTable,
    'BigQuery candidate-retrieval profileTable'
  );
  const safeShingles = buildBigQueryTableIdentifier(
    shinglesTable,
    'BigQuery candidate-retrieval shinglesTable'
  );
  const entityFilter = buildEntityTypeFilterSql(entityTypes, 'e.entity_type', 'bigquery');
  const mentionEligibleFilter =
    "AND LOWER(COALESCE(JSON_VALUE(e.profile_attrs, '$.mention_eligible'), 'true')) <> 'false'";
  // BigQuery has no native n-gram generator; we shingle on the client side
  // using ML.NGRAMS for 3-grams. ML.NGRAMS
  // with [3, 3] returns no rows for 1- and 2-character mentions, so a
  // candidate like 'AI' or 'UK' would never join. Fall back to single-
  // character shingles when LENGTH(@mention) <= 2 so short exact-string
  // mentions still find candidates whose shingles table indexes single
  // characters at extract time.
  return `WITH q AS (
            SELECT shingle FROM UNNEST(
              IF(
                LENGTH(@mention) <= 2,
                SPLIT(LOWER(@mention), ''),
                ML.NGRAMS(SPLIT(LOWER(@mention), ''), [3, 3], '')
              )
            ) AS shingle
            WHERE shingle IS NOT NULL AND shingle != ''
          ),
          candidate_surfaces AS (
            SELECT
              e.entity_id,
              e.entity_type,
              e.canonical_name,
              TO_JSON_STRING(e.profile_attrs) AS profile_attrs,
              e.canonical_name AS matched_text,
              'canonical_name' AS match_source
            FROM ${safeProfile} e
            WHERE e.canonical_name IS NOT NULL
              AND LENGTH(TRIM(e.canonical_name)) > 0
              ${mentionEligibleFilter}
              ${entityFilter}

            UNION ALL

            SELECT
              e.entity_id,
              e.entity_type,
              e.canonical_name,
              TO_JSON_STRING(e.profile_attrs) AS profile_attrs,
              alias_value AS matched_text,
              'profile_attrs.aliases_json' AS match_source
            FROM ${safeProfile} e,
                 UNNEST(COALESCE(JSON_VALUE_ARRAY(JSON_VALUE(e.profile_attrs, '$.aliases_json')), JSON_VALUE_ARRAY(e.profile_attrs, '$.aliases_json'), [])) AS alias_value
            WHERE alias_value IS NOT NULL
              AND LENGTH(TRIM(alias_value)) > 0
              ${mentionEligibleFilter}
              ${entityFilter}
          ),
          counted AS (
            SELECT s.entity_id,
                   e.entity_type,
                   e.canonical_name,
                   e.matched_text,
                   e.match_source,
                   e.profile_attrs,
                   COUNT(*) / GREATEST(ARRAY_LENGTH(ARRAY(SELECT shingle FROM q)), 1) AS sim
            FROM ${safeShingles} s
            JOIN q USING (shingle)
            JOIN candidate_surfaces e ON e.entity_id = s.entity_id
            GROUP BY s.entity_id, e.entity_type, e.canonical_name, e.matched_text, e.match_source, e.profile_attrs
          ),
          ranked AS (
            SELECT
              *,
              ROW_NUMBER() OVER (
                PARTITION BY entity_type, entity_id
                ORDER BY sim DESC, match_source ASC, matched_text ASC
              ) AS rn
            FROM counted
            WHERE sim >= @min_sim
          )
          SELECT entity_id, entity_type, canonical_name, matched_text, match_source, profile_attrs, sim
          FROM ranked
          WHERE rn = 1
          ORDER BY sim DESC, entity_type ASC, entity_id ASC
          LIMIT @k`;
}
