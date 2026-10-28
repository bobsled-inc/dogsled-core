/**
 * Quality view SQL emission for `__document_mentions__quality` and per-relationship-edge
 * evidence-diversity aggregation.
 *
 * The mentions backing table contract is registered in
 * `packages/entity-graph/src/compiler/output-tables/mention.ts`. This
 * module emits SELECT generators that compiler/runtime callers wrap in
 * dialect-appropriate `CREATE VIEW` / `CREATE OR REPLACE VIEW`.
 *
 * `mention_confidence` mirrors the LLM resolution confidence directly.
 * `freshness_age_seconds` is computed from `extracted_at` via the
 * dialect-aware `timestampDiffSeconds` helper. `source_diversity` counts
 * the number of distinct documents in the corpus that mention the same
 * resolved entity. `profile_coverage` is read from the entity profile
 * when available; defaulting to 0.0 when no profile is joined.
 */

import { assertSafeIdentifier } from '../candidate-retrieval/sql-utils.js';
import { getCanonicalDialect, type SupportedDialect } from '@bobsled-inc/model-spec';

export type QualityViewDialect = SupportedDialect;

/**
 * Dialect-aware "seconds between two timestamps" expression. Centralized
 * here so both `__document_mentions__quality` and
 * `__entity_relationship_evidence` aggregations stay in lockstep when a
 * new dialect lands.
 *
 *  - DuckDB / Postgres: `EXTRACT(EPOCH FROM (later - earlier))`
 *  - Snowflake: `EXTRACT(epoch_second FROM later) - EXTRACT(epoch_second FROM earlier)`
 *  - BigQuery: `TIMESTAMP_DIFF(later, earlier, SECOND)`
 */
function timestampDiffSeconds(dialect: QualityViewDialect, later: string, earlier: string): string {
  const canonical = getCanonicalDialect(dialect);
  switch (canonical) {
    case 'duckdb':
    case 'postgres':
      return `CAST(EXTRACT(EPOCH FROM (${later} - ${earlier})) AS INTEGER)`;
    case 'snowflake':
      return `CAST(EXTRACT(epoch_second FROM ${later}) - EXTRACT(epoch_second FROM ${earlier}) AS INTEGER)`;
    case 'bigquery':
      return `TIMESTAMP_DIFF(${later}, ${earlier}, SECOND)`;
    case 'mysql':
      return `CAST(TIMESTAMPDIFF(SECOND, ${earlier}, ${later}) AS INTEGER)`;
    case 'databricks':
      return `CAST(UNIX_TIMESTAMP(${later}) - UNIX_TIMESTAMP(${earlier}) AS INTEGER)`;
    case 'clickhouse':
      return `dateDiff('second', ${earlier}, ${later})`;
    default: {
      const exhaustive: never = canonical;
      throw new Error(`Unsupported dialect: ${exhaustive}`);
    }
  }
}

export interface MentionQualityViewOptions {
  /** Fully qualified `__document_mentions` table name. */
  mentionsTable: string;
  /**
   * Optional fully qualified `__entity_profile` table. When supplied the
   * view's `profile_coverage` column is read from `entity_profile`;
   * otherwise it defaults to 0.0 so the column type stays stable.
   */
  profileTable?: string;
  /**
   * SQL dialect to emit timestamp-diff expressions for. Defaults to
   * `duckdb` (which shares the Postgres `EXTRACT(EPOCH ...)` shape) so
   * existing callers continue to work without adopting the dialect
   * argument explicitly.
   */
  dialect?: QualityViewDialect;
}

/**
 * Emit the SELECT for the `__document_mentions__quality` view.
 *
 * One row per non-superseded mention. Quality columns follow the
 * quality-scoring contract.
 */
export function buildMentionQualityViewSelect(options: MentionQualityViewOptions): string {
  const dialect = options.dialect ?? 'duckdb';
  const mentionsTable = assertSafeIdentifier(options.mentionsTable, 'mentionsTable');
  const profileTable = options.profileTable
    ? assertSafeIdentifier(options.profileTable, 'profileTable')
    : null;
  // Portable numeric literal — `CAST(0.0 AS DOUBLE)` would break on
  // Postgres (needs `DOUBLE PRECISION`) and BigQuery (needs `FLOAT64`).
  // The bare `0.0` literal is accepted by every dialect we target.
  const profileCoverageExpr = profileTable ? 'COALESCE(p.profile_coverage, 0.0)' : '0.0';
  const profileJoin = profileTable
    ? `LEFT JOIN ${profileTable} p ON p.entity_id = m.resolved_entity_id`
    : '';
  const freshness = timestampDiffSeconds(dialect, 'CURRENT_TIMESTAMP', 'm.extracted_at');
  return `WITH entity_corpus_diversity AS (
  SELECT
    resolved_entity_id,
    COUNT(DISTINCT document_id) AS source_diversity
  FROM ${mentionsTable}
  WHERE resolved_entity_id IS NOT NULL
    AND superseded_at IS NULL
  GROUP BY resolved_entity_id
)
SELECT
  m.mention_id,
  m.resolution_confidence AS mention_confidence,
  ${freshness} AS freshness_age_seconds,
  COALESCE(d.source_diversity, 0) AS source_diversity,
  ${profileCoverageExpr} AS profile_coverage
FROM ${mentionsTable} m
LEFT JOIN entity_corpus_diversity d ON d.resolved_entity_id = m.resolved_entity_id
${profileJoin}
WHERE m.superseded_at IS NULL`.trim();
}

export interface RelationshipEvidenceDiversityOptions {
  /** Fully qualified `__entity_relationship_evidence` table name. */
  evidenceTable: string;
  /** SQL dialect for timestamp-diff (defaults to `duckdb`). */
  dialect?: QualityViewDialect;
}

/**
 * Per-edge evidence-diversity aggregation.
 *
 * Returns one row per `relationship_id` with the count of *distinct*
 * `evidence_kind` values backing it (mentions vs. crosswalks vs.
 * truthsets — the more kinds, the more independently corroborated).
 * Wraps cleanly into a UPDATE / MERGE against `__entity_relationship_edge`
 * so the canonical edge row always carries `evidence_diversity_kinds`
 * alongside the raw `evidence_count`.
 */
export function buildRelationshipEvidenceDiversitySelect(
  options: RelationshipEvidenceDiversityOptions
): string {
  const dialect = options.dialect ?? 'duckdb';
  const evidenceTable = assertSafeIdentifier(options.evidenceTable, 'evidenceTable');
  const freshness = timestampDiffSeconds(dialect, 'CURRENT_TIMESTAMP', 'MAX(recorded_at)');
  return `SELECT
  relationship_id,
  COUNT(*) AS evidence_count,
  COUNT(DISTINCT evidence_kind) AS evidence_diversity_kinds,
  ${freshness} AS freshness_age_seconds
FROM ${evidenceTable}
GROUP BY relationship_id`;
}
