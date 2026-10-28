import { getCanonicalDialect, quoteLiteral, type SupportedDialect } from '@bobsled-inc/model-spec';

import { assertSafeIdentifier } from '../../runtime/candidate-retrieval/sql-utils.js';
import { nullOfType } from '../identity/sql.js';

function freshnessAgeSecondsExpressionForDialect(dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
      return 'GREATEST(0, TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), a.latest_recorded_at, SECOND))';
    case 'postgres':
      return 'GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - a.latest_recorded_at))))';
    case 'mysql':
      return 'GREATEST(0, TIMESTAMPDIFF(SECOND, a.latest_recorded_at, CURRENT_TIMESTAMP))';
    case 'snowflake':
      return 'GREATEST(0, DATEDIFF(second, a.latest_recorded_at, CURRENT_TIMESTAMP))';
    case 'databricks':
      return 'GREATEST(0, CAST(unix_timestamp(current_timestamp()) - unix_timestamp(a.latest_recorded_at) AS BIGINT))';
    case 'duckdb':
      return "GREATEST(0, DATE_DIFF('second', CAST(a.latest_recorded_at AS TIMESTAMP), CURRENT_TIMESTAMP))";
    case 'clickhouse':
      return "greatest(0, dateDiff('second', a.latest_recorded_at, CURRENT_TIMESTAMP))";
  }
}

/** A directed exclusivity edge from the relationship ontology. */
export type RelationshipExclusivityPair = readonly [relationA: string, relationB: string];

function emitExclusivityCte(
  pairs: readonly RelationshipExclusivityPair[],
  dialect: SupportedDialect
): string {
  // SELECT … UNION ALL form is portable across DuckDB, Postgres, Snowflake,
  // and BigQuery, unlike `VALUES (...) AS t(a,b)` which differs by dialect.
  // quoteLiteral applies dialect-correct escaping (BigQuery rejects '' doubling).
  const rows = pairs.map(
    ([a, b], i) =>
      `  SELECT ${quoteLiteral(a, dialect)} AS relation_a, ${quoteLiteral(b, dialect)} AS relation_b${
        i < pairs.length - 1 ? ' UNION ALL' : ''
      }`
  );
  return ['exclusivity_pairs AS (', ...rows, ')'].join('\n');
}

function evidenceDiversityExpression(dialect: SupportedDialect): string {
  const source = "COALESCE(source_document_id, '<none>')";
  const key =
    getCanonicalDialect(dialect) === 'mysql'
      ? `CONCAT(${source}, ':', evidence_kind)`
      : `${source} || ':' || evidence_kind`;
  return `COUNT(DISTINCT ${key}) AS evidence_diversity`;
}

export function buildCompactionSelect(
  options: {
    evidenceTable?: string;
    decisionsTable?: string;
    lineageRunIdExpression?: string;
    dialect?: SupportedDialect;
    /**
     * Directed `(relation_a, relation_b)` pairs from the ontology's
     * `exclusive_with` declarations. When non-empty, the SQL emits an
     * `exclusivity_pairs` CTE and downgrades the weaker side of every
     * conflict on the same `(left_entity_id, right_entity_id)` pair to
     * `rank='conflicted'`. Ties break deterministically on
     * `relationship_id` lexicographic order.
     *
     * Omitted/empty preserves the prior behavior (only manual decisions
     * trigger `rank='conflicted'`), so callers without ontology context
     * — e.g. dry-runs outside a project — are unaffected.
     */
    exclusivityPairs?: readonly RelationshipExclusivityPair[];
  } = {}
): string {
  const evidenceTable = assertSafeIdentifier(
    options.evidenceTable ?? '__entity_relationship_evidence',
    'relationship evidence table'
  );
  const decisionsTable = assertSafeIdentifier(
    options.decisionsTable ?? '__entity_relationship_decisions',
    'relationship decisions table'
  );
  const lineageRunId = options.lineageRunIdExpression ?? 'CAST(CURRENT_TIMESTAMP AS VARCHAR)';
  const dialect = options.dialect ?? 'duckdb';
  const freshnessAgeSeconds = freshnessAgeSecondsExpressionForDialect(dialect);
  const exclusivityPairs = options.exclusivityPairs ?? [];
  const hasExclusivity = exclusivityPairs.length > 0;

  const ctes: string[] = [
    'WITH per_row AS (',
    '  SELECT',
    '    e.relationship_id,',
    '    e.left_entity_id,',
    '    e.right_entity_id,',
    '    e.relation_type,',
    '    e.confidence,',
    '    e.source_document_id,',
    '    e.evidence_kind,',
    '    e.observed_at,',
    '    e.recorded_at,',
    '    ROW_NUMBER() OVER (',
    '      PARTITION BY e.relationship_id, COALESCE(e.source_document_id, e.evidence_id)',
    '      ORDER BY e.confidence DESC, e.recorded_at DESC',
    '    ) AS dedup_rank',
    `  FROM ${evidenceTable} e`,
    '  WHERE NOT EXISTS (',
    `    SELECT 1 FROM ${decisionsTable} d`,
    '    WHERE d.evidence_id = e.evidence_id',
    "      AND d.decision = 'reject'",
    '  )',
    '),',
    'capped AS (',
    '  SELECT * FROM per_row WHERE dedup_rank = 1',
    '),',
    'aggregated AS (',
    '  SELECT',
    '    relationship_id,',
    '    left_entity_id,',
    '    right_entity_id,',
    '    relation_type,',
    '    1.0 / (1.0 + EXP(-SUM(LN(GREATEST(confidence, 0.001) / GREATEST(1 - confidence, 0.001))))) AS confidence,',
    '    COUNT(*) AS evidence_count,',
    `    ${evidenceDiversityExpression(dialect)},`,
    '    MIN(observed_at) AS valid_from,',
    `    ${nullOfType('TIMESTAMP', dialect)} AS valid_to,`,
    '    MAX(recorded_at) AS latest_recorded_at',
    '  FROM capped',
    '  GROUP BY relationship_id, left_entity_id, right_entity_id, relation_type',
    '),',
  ];

  if (hasExclusivity) {
    ctes.push(`${emitExclusivityCte(exclusivityPairs, dialect)},`);
    ctes.push(
      // For each aggregated row, count exclusive-conflict rows on the same
      // entity pair that strictly beat it on (confidence DESC,
      // relationship_id ASC). >0 ⇒ this row is the weaker side and the
      // outer SELECT marks it `conflicted`. The relationship_id tie-break
      // is what gives the SQL path a deterministic answer where the
      // in-memory `reduce()` would silently depend on insertion order.
      'conflict_candidates AS (',
      '  SELECT',
      '    a1.relationship_id,',
      '    SUM(CASE',
      '      WHEN a2.relationship_id IS NULL THEN 0',
      '      WHEN a2.confidence > a1.confidence THEN 1',
      '      WHEN a2.confidence = a1.confidence AND a2.relationship_id < a1.relationship_id THEN 1',
      '      ELSE 0',
      '    END) AS stronger_conflict_count',
      '  FROM aggregated a1',
      '  LEFT JOIN exclusivity_pairs ex ON ex.relation_a = a1.relation_type',
      '  LEFT JOIN aggregated a2',
      '    ON a2.left_entity_id = a1.left_entity_id',
      '   AND a2.right_entity_id = a1.right_entity_id',
      '   AND a2.relation_type = ex.relation_b',
      '   AND a2.relationship_id <> a1.relationship_id',
      '  GROUP BY a1.relationship_id',
      '),'
    );
  }

  ctes.push(
    'decision_flags AS (',
    '  SELECT',
    '    relationship_id,',
    "    MAX(CASE WHEN decision = 'supersede' THEN 1 ELSE 0 END) AS has_supersede,",
    "    MAX(CASE WHEN decision = 'conflicted' THEN 1 ELSE 0 END) AS has_conflict",
    `  FROM ${decisionsTable}`,
    "  WHERE decision IN ('supersede', 'conflicted')",
    '  GROUP BY relationship_id',
    ')'
  );

  const rankCases = [
    "    WHEN COALESCE(d.has_supersede, 0) = 1 THEN 'deprecated'",
    "    WHEN COALESCE(d.has_conflict, 0) = 1 THEN 'conflicted'",
  ];
  if (hasExclusivity) {
    rankCases.push("    WHEN COALESCE(c.stronger_conflict_count, 0) > 0 THEN 'conflicted'");
  }
  rankCases.push("    ELSE 'preferred'");

  return [
    ...ctes,
    'SELECT',
    '  a.relationship_id,',
    '  a.left_entity_id,',
    '  a.right_entity_id,',
    '  a.relation_type,',
    '  a.confidence,',
    '  CASE',
    ...rankCases,
    '  END AS rank,',
    '  a.valid_from,',
    '  CASE',
    '    WHEN COALESCE(d.has_supersede, 0) = 1 THEN a.latest_recorded_at',
    '    ELSE a.valid_to',
    '  END AS valid_to,',
    '  a.evidence_count,',
    '  a.evidence_diversity,',
    `  ${freshnessAgeSeconds} AS freshness_age_seconds,`,
    `  ${lineageRunId} AS lineage_run_id`,
    'FROM aggregated a',
    'LEFT JOIN decision_flags d ON d.relationship_id = a.relationship_id',
    ...(hasExclusivity
      ? ['LEFT JOIN conflict_candidates c ON c.relationship_id = a.relationship_id']
      : []),
  ].join('\n');
}

/**
 * Flatten a resolved relationship ontology into the directed
 * `(relation_a, relation_b)` pairs consumed by {@link buildCompactionSelect}.
 * Each pair is emitted exactly as declared in
 * `relation.exclusive_with`; callers that need symmetric semantics must
 * declare both directions in the ontology spec.
 */
export function relationshipExclusivityPairs(relations: {
  readonly relations: ReadonlyArray<{
    readonly relation_type: string;
    readonly exclusive_with: readonly string[];
  }>;
}): RelationshipExclusivityPair[] {
  const out: RelationshipExclusivityPair[] = [];
  for (const relation of relations.relations) {
    for (const other of relation.exclusive_with) {
      out.push([relation.relation_type, other]);
    }
  }
  return out;
}
