/**
 * Clustering codegen — connected components via recursive CTE.
 *
 * Consumes __review_decisions + auto-merge pairs from __pair_scores
 * to produce __components. Uses recursive CTE for connected components
 * (works up to ~100K edges).
 *
 * BigQuery only permits UNION ALL inside recursive CTEs, while the
 * propagation below relies on UNION's dedup for termination — so for
 * BigQuery the same min-label propagation is emitted as a procedural
 * script (single multi-statement query job) looping to a fixpoint.
 */

import {
  quoteIdentifier,
  buildFqName,
  createOrReplaceTableAs,
  quoteLiteral,
  getCanonicalDialect,
  supportsDialectCapability,
  unsupportedDialectFeatureError,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { hasFlagForReviewRules } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { unionDistinct } from './sql.js';

interface ComponentsSqlContext {
  spec: ResolvedResolutionSpec;
  dialect: SupportedDialect;
  scoresTable: string;
  semanticScoresTable?: string;
  decisionsTable: string;
  componentsTable: string;
  standardizedTable: string;
}

/**
 * CTE definitions feeding merge_edges: latest_decisions (+ semantic_pairs).
 * Returned without a leading WITH so callers can prepend WITH or
 * WITH RECURSIVE as the dialect requires.
 */
function mergeEdgesCtes(ctx: ComponentsSqlContext): string[] {
  const { spec, dialect, scoresTable, semanticScoresTable, decisionsTable } = ctx;
  const t = spec.thresholds;
  const semanticTriage = spec.semanticTriage;

  const pairId = quoteIdentifier('pair_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const compositeScore = quoteIdentifier('composite_score', dialect);
  const decision = quoteIdentifier('decision', dialect);
  const reviewConfidence = quoteIdentifier('confidence', dialect);
  const status = quoteIdentifier('status', dialect);
  const decidedAt = quoteIdentifier('decided_at', dialect);
  const appliedAt = quoteIdentifier('applied_at', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);

  return [
    `latest_decisions AS (`,
    `  SELECT ${pairId}, ${decision}, ${reviewConfidence}, ${status}`,
    `  FROM (`,
    `    SELECT`,
    `      ${pairId},`,
    `      ${decision},`,
    `      ${reviewConfidence},`,
    `      ${status},`,
    `      ROW_NUMBER() OVER (`,
    `        PARTITION BY ${pairId}`,
    `        ORDER BY ${decidedAt} DESC, ${appliedAt} DESC`,
    `      ) AS rn`,
    `    FROM ${decisionsTable}`,
    `  ) ranked`,
    `  WHERE ranked.rn = 1`,
    `),`,
    ...(semanticTriage && semanticScoresTable
      ? [
          `semantic_pairs AS (`,
          `  SELECT`,
          `    ${pairId},`,
          `    AVG(${quoteIdentifier('semantic_score', dialect)}) AS ${quoteIdentifier('semantic_score', dialect)}`,
          `  FROM ${semanticScoresTable}`,
          `  GROUP BY ${pairId}`,
          `),`,
        ]
      : []),
    `merge_edges AS (`,
    `  -- Auto-merge pairs above threshold`,
    `  SELECT`,
    `    ${recordAId},`,
    `    ${recordBId},`,
    `    ${compositeScore},`,
    `    ld.${reviewConfidence} AS ${quoteIdentifier('review_confidence', dialect)},`,
    `    GREATEST(${compositeScore}, COALESCE(ld.${reviewConfidence}, 0)) AS ${confidenceScore}`,
    `  FROM ${scoresTable} ps`,
    `  LEFT JOIN latest_decisions ld ON ps.${pairId} = ld.${pairId}`,
    ...(semanticTriage ? [`  LEFT JOIN semantic_pairs sp ON ps.${pairId} = sp.${pairId}`] : []),
    // auto_merge: null disables score-driven auto-merge — only
    // deterministic-rule pairs become merge edges. flag_for_review pairs
    // (match_type 'deterministic_review') never merge on score alone, no
    // matter how high the rule's confidence — only an applied review
    // decision (the branch below) merges them.
    t.autoMerge === null
      ? `  WHERE ps.${quoteIdentifier('match_type', dialect)} = ${quoteLiteral('deterministic', dialect)}`
      : `  WHERE ${compositeScore} >= ${t.autoMerge}` +
        (hasFlagForReviewRules(spec)
          ? `\n    AND ps.${quoteIdentifier('match_type', dialect)} <> ${quoteLiteral('deterministic_review', dialect)}`
          : ''),
    `    AND (ld.${pairId} IS NULL OR ld.${status} = ${quoteLiteral('proposed', dialect)})`,
    ...(semanticTriage
      ? [
          `    AND (sp.${quoteIdentifier('semantic_score', dialect)} IS NULL OR sp.${quoteIdentifier('semantic_score', dialect)} > ${semanticTriage.promoteToRejectThreshold})`,
        ]
      : []),
    ...(semanticTriage
      ? [
          `  ${unionDistinct(dialect)}`,
          `  -- Semantic triage promoted review-band pairs to merge`,
          `  SELECT`,
          `    ps.${recordAId},`,
          `    ps.${recordBId},`,
          `    ps.${compositeScore},`,
          `    ld.${reviewConfidence} AS ${quoteIdentifier('review_confidence', dialect)},`,
          `    GREATEST(ps.${compositeScore}, sp.${quoteIdentifier('semantic_score', dialect)}, COALESCE(ld.${reviewConfidence}, 0)) AS ${confidenceScore}`,
          `  FROM ${scoresTable} ps`,
          `  JOIN semantic_pairs sp ON ps.${pairId} = sp.${pairId}`,
          `  LEFT JOIN latest_decisions ld ON ps.${pairId} = ld.${pairId}`,
          `  WHERE ps.${compositeScore} >= ${t.review}`,
          // Promotion is governed by its own explicit promote_to_merge
          // threshold; the auto-merge upper bound only applies when set.
          ...(t.autoMerge === null ? [] : [`    AND ps.${compositeScore} < ${t.autoMerge}`]),
          `    AND sp.${quoteIdentifier('semantic_score', dialect)} >= ${semanticTriage.promoteToMergeThreshold}`,
          `    AND (ld.${pairId} IS NULL OR ld.${status} = ${quoteLiteral('proposed', dialect)})`,
        ]
      : []),
    `  ${unionDistinct(dialect)}`,
    `  -- Reviewed pairs with merge decision (latest decision per pair_id)`,
    `  SELECT`,
    `    ps.${recordAId},`,
    `    ps.${recordBId},`,
    `    ps.${compositeScore},`,
    `    ld.${reviewConfidence} AS ${quoteIdentifier('review_confidence', dialect)},`,
    `    GREATEST(ps.${compositeScore}, COALESCE(ld.${reviewConfidence}, 0)) AS ${confidenceScore}`,
    `  FROM ${scoresTable} ps`,
    `  JOIN latest_decisions ld`,
    `    ON ps.${pairId} = ld.${pairId}`,
    `   AND ld.${decision} = ${quoteLiteral('merge', dialect)}`,
    `   AND COALESCE(ld.${status}, ${quoteLiteral('applied', dialect)}) = ${quoteLiteral('applied', dialect)}`,
    `)`,
  ];
}

/** Final projection from resolved components into the __components table. */
function componentsProjection(ctx: ComponentsSqlContext, componentsAlias: string): string[] {
  const { dialect, standardizedTable } = ctx;
  const componentId = quoteIdentifier('component_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const clusteredAt = quoteIdentifier('clustered_at', dialect);

  return [
    `SELECT`,
    `  fc.component_id AS ${componentId},`,
    `  fc.node_id AS ${recordId},`,
    `  s.${sourceRef} AS ${sourceRef},`,
    `  s.${sourcePkJson} AS ${sourcePkJson},`,
    `  s.${quoteIdentifier('_source_entity_id', dialect)} AS ${sourceEntityId},`,
    `  s.${quoteIdentifier('_source_system', dialect)} AS ${sourceSystem},`,
    `  COALESCE(nc.${confidenceScore}, 1.0) AS ${confidenceScore},`,
    `  CURRENT_TIMESTAMP AS ${clusteredAt}`,
    `FROM ${componentsAlias} fc`,
    `JOIN ${standardizedTable} s`,
    `  ON fc.node_id = s.${recordId}`,
    `LEFT JOIN node_confidence nc`,
    `  ON fc.node_id = nc.node_id`,
  ];
}

/** node_confidence CTE body computed from a merge-edges relation. */
function nodeConfidenceCte(ctx: ComponentsSqlContext, mergeEdgesRelation: string): string[] {
  const { dialect } = ctx;
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);

  return [
    `node_confidence AS (`,
    `  SELECT`,
    `    node_id,`,
    `    MAX(${confidenceScore}) AS ${confidenceScore}`,
    `  FROM (`,
    `    SELECT ${recordAId} AS node_id, ${confidenceScore} FROM ${mergeEdgesRelation}`,
    `    UNION ALL`,
    `    SELECT ${recordBId} AS node_id, ${confidenceScore} FROM ${mergeEdgesRelation}`,
    `  ) edge_confidence`,
    `  GROUP BY node_id`,
    `)`,
  ];
}

/** Recursive-CTE implementation for dialects that allow UNION in the recursive term. */
function generateRecursiveComponentsSql(ctx: ComponentsSqlContext): string {
  const { dialect, componentsTable, standardizedTable } = ctx;
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);

  return [
    createOrReplaceTableAs(componentsTable, dialect),
    `WITH RECURSIVE ${mergeEdgesCtes(ctx).join('\n')},`,
    `-- Bidirectional edges for traversal`,
    `all_edges AS (`,
    `  SELECT ${recordAId} AS node_a, ${recordBId} AS node_b FROM merge_edges`,
    `  UNION ALL`,
    `  SELECT ${recordBId} AS node_a, ${recordAId} AS node_b FROM merge_edges`,
    `),`,
    `-- All unique nodes`,
    `all_nodes AS (`,
    `  SELECT DISTINCT ${recordId} AS node_id FROM ${standardizedTable}`,
    `),`,
    `${nodeConfidenceCte(ctx, 'merge_edges').join('\n')},`,
    `-- Recursive connected components: propagate minimum node_id`,
    `components(node_id, component_id) AS (`,
    `  SELECT node_id, node_id AS component_id`,
    `  FROM all_nodes`,
    `  ${unionDistinct(dialect)}`,
    `  SELECT e.node_b, LEAST(c.component_id, e.node_b)`,
    `  FROM components c`,
    `  JOIN all_edges e ON c.node_id = e.node_a`,
    `  WHERE c.component_id < e.node_b`,
    `),`,
    `-- Take minimum component_id per node`,
    `final_components AS (`,
    `  SELECT node_id, MIN(component_id) AS component_id`,
    `  FROM components`,
    `  GROUP BY node_id`,
    `)`,
    ...componentsProjection(ctx, 'final_components'),
  ].join('\n');
}

/**
 * BigQuery implementation: a multi-statement script (one query job) that
 * materializes edges into temp tables and loops min-label propagation to
 * a fixpoint. BigQuery recursive CTEs only allow UNION ALL, under which
 * the recursive form above never terminates.
 */
function generateBigQueryComponentsSql(ctx: ComponentsSqlContext): string {
  const { dialect, componentsTable, standardizedTable } = ctx;
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);

  return [
    `BEGIN`,
    `DECLARE _eg_changed INT64 DEFAULT 1;`,
    `DECLARE _eg_iterations INT64 DEFAULT 0;`,
    `DECLARE _eg_max_iterations INT64 DEFAULT 0;`,
    ``,
    `CREATE OR REPLACE TEMP TABLE _eg_merge_edges AS`,
    `WITH ${mergeEdgesCtes(ctx).join('\n')}`,
    `SELECT * FROM merge_edges;`,
    ``,
    `-- Bidirectional edges for traversal`,
    `CREATE OR REPLACE TEMP TABLE _eg_edges AS`,
    `SELECT ${recordAId} AS node_a, ${recordBId} AS node_b FROM _eg_merge_edges`,
    `UNION ALL`,
    `SELECT ${recordBId} AS node_a, ${recordAId} AS node_b FROM _eg_merge_edges;`,
    ``,
    `-- Seed: every node is its own component`,
    `CREATE OR REPLACE TEMP TABLE _eg_components AS`,
    `SELECT DISTINCT ${recordId} AS node_id, ${recordId} AS component_id FROM ${standardizedTable};`,
    ``,
    `-- Min-label propagation converges within graph-diameter iterations,`,
    `-- which is bounded by the node count — a data-derived guard that can`,
    `-- never reject a valid graph, only true non-convergence (a bug).`,
    `SET _eg_max_iterations = (SELECT COUNT(*) + 1 FROM _eg_components);`,
    ``,
    `-- Min-label propagation until no component_id improves`,
    `LOOP`,
    `  SET _eg_iterations = _eg_iterations + 1;`,
    `  CREATE OR REPLACE TEMP TABLE _eg_components_next AS`,
    `  SELECT node_id, MIN(component_id) AS component_id`,
    `  FROM (`,
    `    SELECT node_id, component_id FROM _eg_components`,
    `    UNION ALL`,
    `    SELECT e.node_b AS node_id, c.component_id`,
    `    FROM _eg_components c`,
    `    JOIN _eg_edges e ON c.node_id = e.node_a`,
    `  ) candidates`,
    `  GROUP BY node_id;`,
    `  SET _eg_changed = (`,
    `    SELECT COUNT(*)`,
    `    FROM _eg_components_next n`,
    `    JOIN _eg_components c ON n.node_id = c.node_id`,
    `    WHERE n.component_id < c.component_id`,
    `  );`,
    `  CREATE OR REPLACE TEMP TABLE _eg_components AS`,
    `  SELECT node_id, component_id FROM _eg_components_next;`,
    `  IF _eg_changed = 0 THEN`,
    `    LEAVE;`,
    `  ELSEIF _eg_iterations > _eg_max_iterations THEN`,
    `    -- Leaving silently here would persist incomplete clusters.`,
    `    RAISE USING MESSAGE = ${quoteLiteral(
      'entity-graph components did not converge within the node-count iteration bound',
      dialect
    )};`,
    `  END IF;`,
    `END LOOP;`,
    ``,
    `${createOrReplaceTableAs(componentsTable, dialect)}`,
    `WITH ${nodeConfidenceCte(ctx, '_eg_merge_edges').join('\n')}`,
    ...componentsProjection(ctx, '_eg_components'),
    `;`,
    `END;`,
  ].join('\n');
}

/**
 * Generate SQL for the __components table using connected components.
 *
 * Edges come from two sources:
 * 1. Auto-merge pairs (composite_score >= auto_merge threshold)
 * 2. Review decisions with decision = 'merge'
 *
 * The algorithm assigns component_id = MIN(record_id) in each connected
 * component via recursive CTE (or a fixpoint loop on BigQuery). Stable
 * entity IDs are assigned in the next stage.
 */
export function generateComponentsSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const semanticTriage = spec.semanticTriage;

  const ctx: ComponentsSqlContext = {
    spec,
    dialect,
    scoresTable: buildFqName(targetSchema, outputTableName(entity, '__pair_scores'), dialect),
    semanticScoresTable: semanticTriage
      ? buildFqName(targetSchema, outputTableName(entity, '__pair_semantic_scores'), dialect)
      : undefined,
    decisionsTable: buildFqName(
      targetSchema,
      outputTableName(entity, '__review_decisions'),
      dialect
    ),
    componentsTable: buildFqName(targetSchema, outputTableName(entity, '__components'), dialect),
    standardizedTable: buildFqName(
      targetSchema,
      outputTableName(entity, '__standardized'),
      dialect
    ),
  };

  const canonicalDialect = getCanonicalDialect(dialect);

  // Apart from BigQuery's procedural script, a recursive CTE is the only
  // connected-components strategy here, so a dialect whose profile declares
  // `recursiveCte: false` cannot cluster. Only ClickHouse is gated: Databricks
  // declares the capability false too but has always taken the recursive path,
  // so failing it here would be a behaviour change of its own.
  if (canonicalDialect === 'clickhouse' && !supportsDialectCapability(dialect, 'recursiveCte')) {
    throw unsupportedDialectFeatureError(
      dialect,
      'recursiveCte',
      `Entity graph does not support connected-components clustering for compiler target "${dialect}": it is built on a recursive CTE, which that dialect's profile declares unsupported. BigQuery uses a dedicated procedural fixpoint script instead, so supporting this target needs its own per-dialect clustering implementation rather than a flag.`
    );
  }

  const sql =
    canonicalDialect === 'bigquery'
      ? generateBigQueryComponentsSql(ctx)
      : generateRecursiveComponentsSql(ctx);

  return {
    name: 'components',
    sql,
    tableCreated: outputTableName(entity, '__components'),
  };
}
