/**
 * Incremental review materialization — make applied human/agent merge
 * decisions visible immediately, without a full re-cluster.
 *
 * `generateApplySql` (review-apply.ts) only appends decision rows; the merged
 * golden entity would otherwise appear on the NEXT full resolve+cluster run.
 * The statements generated here run right after the append and update, scoped
 * to only the touched entities:
 *
 *   - `__clusters`     — the loser entities' records are re-homed under the
 *                        winner entity_id (cluster union),
 *   - `__crosswalks`   — re-projected for the affected records,
 *   - `__golden_record`/`__golden` — recomputed for the winner entity via the
 *                        same survivorship ranking + golden codegen the
 *                        cluster phase uses.
 *
 * Winner selection mirrors `stable_choice_ranked` in `codegen-entity-id.ts`:
 * the affected entity with the earliest birth event in `__entity_id_events`
 * wins, tie-broken by `entity_id ASC`. That is exactly the entity_id a
 * subsequent full resolve+cluster (which turns the just-appended merge
 * decision into a component edge) would keep — so the incremental apply is an
 * early, targeted materialization of what the next resolve produces anyway
 * (self-healing). `__review_decisions` remains the single source of truth;
 * none of the `__entity_id_*` event-log tables are written here — the next
 * full resolve reconciles the event log itself.
 *
 * Idempotency: every statement is guarded so that re-applying the same
 * decision is a no-op — the cluster-union statements are scoped to loser
 * entities (empty once merged), and the crosswalk/golden statements only fire
 * while `__crosswalks` disagrees with `__clusters` for the pair's records.
 *
 * Concurrency contract: all writes are entity-scoped (only rows of the
 * affected entity_ids are touched); nothing here rewrites whole tables or
 * needs a pipeline-wide lock. A concurrently-running full resolve+cluster may
 * transiently clobber the targeted golden update with a rebuild that predates
 * the decision, but because the resolve reconciles from `__review_decisions`,
 * the next run re-derives the identical merged golden — eventual consistency.
 *
 * Known approximations (reconciled by the next full resolve+cluster):
 *   - `not_match` decisions are NOT materialized. The `__not_match_edges`
 *     append (review-apply.ts) prevents a future re-merge, but if the two
 *     records currently share an entity_id they keep sharing it until the
 *     next full resolve+cluster splits them — unmerge-on-not_match is a
 *     deliberate v1 follow-up, surfaced as a warning by the callers.
 *   - pair-record confidence is raised to the merge-edge confidence
 *     (`GREATEST(composite_score, decision confidence)`) but never lowered,
 *     which matches the cluster phase exactly for confidence-1.0 decisions
 *     (what the app sends for human decisions); lower-confidence agent
 *     applies can leave trust_score transiently higher until the next run.
 */

import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { buildGoldenWideParts, goldenRulesFor } from './codegen-golden.js';
import { buildChosenRuleCtes, type GoldenAttributeRule } from './survivorship-ranking.js';
import { unionDistinct } from './sql.js';

export interface GenerateIncrementalMaterializeSqlOptions {
  spec: ResolvedResolutionSpec;
  dialect: SupportedDialect;
  targetSchema: string;
  /**
   * pair_ids of the APPLIED merge decisions to materialize, in application
   * order. Chained merges (a↔b then b↔c) are handled because each pair's
   * statement group reads the state left by the previous group.
   */
  mergePairIds: string[];
  /** Refined survivorship rules (from a co-located survivorship spec), if any. */
  goldenRules?: GoldenAttributeRule[];
  /**
   * Statement name the first materialize statement depends on (typically the
   * caller's final decision-write statement), so materialization is skipped
   * when the decision append itself failed.
   */
  dependsOn?: string;
}

interface MaterializeContext {
  dialect: SupportedDialect;
  clustersTable: string;
  crosswalksTable: string;
  goldenRecordTable: string;
  goldenTable: string;
  pairScoresTable: string;
  eventsTable: string;
  decisionsTable: string;
}

function buildContext(
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string
): MaterializeContext {
  const table = (suffix: Parameters<typeof outputTableName>[1]): string =>
    buildFqName(targetSchema, outputTableName(entity, suffix), dialect);
  return {
    dialect,
    clustersTable: table('__clusters'),
    crosswalksTable: table('__crosswalks'),
    goldenRecordTable: table('__golden_record'),
    goldenTable: table('__golden'),
    pairScoresTable: table('__pair_scores'),
    eventsTable: table('__entity_id_events'),
    decisionsTable: table('__review_decisions'),
  };
}

/** `pair_records` CTE — the two record_ids of one scored pair. */
function pairRecordsCte(ctx: MaterializeContext, pairId: string): string {
  const { dialect } = ctx;
  const recordId = quoteIdentifier('record_id', dialect);
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const pairLiteral = quoteLiteral(pairId, dialect);
  return [
    `pair_records AS (`,
    `  SELECT ${quoteIdentifier('record_a_id', dialect)} AS ${recordId}`,
    `  FROM ${ctx.pairScoresTable}`,
    `  WHERE ${pairIdCol} = ${pairLiteral}`,
    `  ${unionDistinct(dialect)}`,
    `  SELECT ${quoteIdentifier('record_b_id', dialect)} AS ${recordId}`,
    `  FROM ${ctx.pairScoresTable}`,
    `  WHERE ${pairIdCol} = ${pairLiteral}`,
    `)`,
  ].join('\n');
}

/**
 * Winner/loser CTEs for the cluster union. Mirrors `stable_choice_ranked`
 * (codegen-entity-id.ts): earliest entity birth in `__entity_id_events` wins,
 * tie-break `entity_id ASC`. Once the pair's records share an entity_id,
 * `losers` is empty and the union statements are no-ops.
 */
function winnerCtes(ctx: MaterializeContext, pairId: string): string {
  const { dialect } = ctx;
  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const createdAt = quoteIdentifier('created_at', dialect);
  const eventType = quoteIdentifier('event_type', dialect);
  const firstAssignedAt = quoteIdentifier('first_assigned_at', dialect);
  const rn = quoteIdentifier('rn', dialect);
  return [
    pairRecordsCte(ctx, pairId) + ',',
    `affected_entities AS (`,
    `  SELECT DISTINCT c.${entityId}`,
    `  FROM ${ctx.clustersTable} c`,
    `  JOIN pair_records p ON c.${recordId} = p.${recordId}`,
    `),`,
    `entity_births AS (`,
    `  SELECT ${entityId}, MIN(${createdAt}) AS ${firstAssignedAt}`,
    `  FROM ${ctx.eventsTable}`,
    `  WHERE ${eventType} <> ${quoteLiteral('alias', dialect)}`,
    `  GROUP BY ${entityId}`,
    `),`,
    `winner AS (`,
    `  SELECT ${entityId}`,
    `  FROM (`,
    `    SELECT`,
    `      ae.${entityId},`,
    `      ROW_NUMBER() OVER (`,
    `        ORDER BY`,
    `          CASE WHEN eb.${firstAssignedAt} IS NULL THEN 1 ELSE 0 END,`,
    `          eb.${firstAssignedAt} ASC,`,
    `          ae.${entityId} ASC`,
    `      ) AS ${rn}`,
    `    FROM affected_entities ae`,
    `    LEFT JOIN entity_births eb ON ae.${entityId} = eb.${entityId}`,
    `  ) ranked`,
    `  WHERE ranked.${rn} = 1`,
    `),`,
    `losers AS (`,
    `  SELECT ${entityId}`,
    `  FROM affected_entities`,
    `  WHERE ${entityId} NOT IN (SELECT ${entityId} FROM winner)`,
    `)`,
  ].join('\n');
}

/**
 * Scope CTEs for the crosswalk/golden refresh statements.
 *
 * `stale_records` is the change signal: pair records whose `__crosswalks` row
 * is missing or disagrees with `__clusters`. It is non-empty after the
 * cluster-union statements ran (crosswalks not yet re-projected) and empty on
 * a re-apply — the idempotency guard for every statement below.
 */
function scopeCtes(ctx: MaterializeContext, pairId: string): string {
  const { dialect } = ctx;
  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  return [
    pairRecordsCte(ctx, pairId) + ',',
    `scoped_entities AS (`,
    `  SELECT DISTINCT c.${entityId}`,
    `  FROM ${ctx.clustersTable} c`,
    `  JOIN pair_records p ON c.${recordId} = p.${recordId}`,
    `),`,
    `touched_entities AS (`,
    `  SELECT x.${entityId}`,
    `  FROM ${ctx.crosswalksTable} x`,
    `  JOIN pair_records p ON x.${recordId} = p.${recordId}`,
    `  ${unionDistinct(dialect)}`,
    `  SELECT ${entityId} FROM scoped_entities`,
    `),`,
    `stale_records AS (`,
    `  SELECT c.${recordId}`,
    `  FROM ${ctx.clustersTable} c`,
    `  JOIN pair_records p ON c.${recordId} = p.${recordId}`,
    `  LEFT JOIN ${ctx.crosswalksTable} x ON c.${recordId} = x.${recordId}`,
    `  WHERE x.${recordId} IS NULL`,
    `     OR x.${entityId} <> c.${entityId}`,
    // Confidence drift is a refresh signal too: a merge decision on an
    // already-merged pair changes only confidence_score (pair_confidence
    // statement), and the golden trust score must still be recomputed.
    `     OR COALESCE(x.${quoteIdentifier('confidence_score', dialect)}, -1.0) <> COALESCE(c.${quoteIdentifier('confidence_score', dialect)}, -1.0)`,
    `)`,
  ].join('\n');
}

const STALE_GUARD = `EXISTS (SELECT 1 FROM stale_records)`;

/** Cluster-union INSERT: re-home every loser-entity record under the winner. */
function unionClustersInsert(ctx: MaterializeContext, pairId: string, name: string): SqlStatement {
  const { dialect } = ctx;
  const columns = [
    'entity_id',
    'cluster_id',
    'component_id',
    'record_id',
    'source_ref',
    'source_pk_json',
    'source_entity_id',
    'source_system',
    'confidence_score',
    'clustered_at',
  ].map((column) => quoteIdentifier(column, dialect));
  const entityId = quoteIdentifier('entity_id', dialect);
  const passthrough = columns
    .slice(2)
    .map((column) => `  c.${column}`)
    .join(',\n');
  return {
    name,
    sql: [
      `INSERT INTO ${ctx.clustersTable}`,
      `  (${columns.join(', ')})`,
      `WITH ${winnerCtes(ctx, pairId)}`,
      `SELECT`,
      `  w.${entityId},`,
      `  w.${entityId},`,
      passthrough,
      `FROM ${ctx.clustersTable} c`,
      `JOIN losers l ON c.${entityId} = l.${entityId}`,
      `CROSS JOIN winner w`,
    ].join('\n'),
  };
}

/** Cluster-union DELETE: drop the loser-entity rows the INSERT re-homed. */
function unionClustersDelete(ctx: MaterializeContext, pairId: string, name: string): SqlStatement {
  const entityId = quoteIdentifier('entity_id', ctx.dialect);
  return {
    name,
    sql: [
      `DELETE FROM ${ctx.clustersTable}`,
      `WHERE ${entityId} IN (`,
      `WITH ${winnerCtes(ctx, pairId)}`,
      `SELECT ${entityId} FROM losers`,
      `)`,
    ].join('\n'),
  };
}

/**
 * Raise the pair records' confidence_score to the merge-edge confidence —
 * `GREATEST(composite_score, latest applied merge decision confidence)` —
 * mirroring how the cluster phase computes node confidence from merge edges.
 * Never lowers an existing score (see module docblock).
 */
function pairConfidenceUpdate(ctx: MaterializeContext, pairId: string, name: string): SqlStatement {
  const { dialect } = ctx;
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const confidence = quoteIdentifier('confidence', dialect);
  const decision = quoteIdentifier('decision', dialect);
  const status = quoteIdentifier('status', dialect);
  const decidedAt = quoteIdentifier('decided_at', dialect);
  const appliedAt = quoteIdentifier('applied_at', dialect);
  const rn = quoteIdentifier('rn', dialect);
  const pairLiteral = quoteLiteral(pairId, dialect);

  // Both scalar subqueries are uncorrelated, so the expression is portable
  // across DuckDB / Snowflake / BigQuery (no UPDATE ... FROM needed).
  const edgeConfExpr = [
    `GREATEST(`,
    `  COALESCE((`,
    `    SELECT MAX(${quoteIdentifier('composite_score', dialect)})`,
    `    FROM ${ctx.pairScoresTable}`,
    `    WHERE ${pairIdCol} = ${pairLiteral}`,
    `  ), 0),`,
    `  COALESCE((`,
    `    SELECT ${confidence}`,
    `    FROM (`,
    `      SELECT`,
    `        ${confidence},`,
    `        ROW_NUMBER() OVER (ORDER BY ${decidedAt} DESC, ${appliedAt} DESC) AS ${rn}`,
    `      FROM ${ctx.decisionsTable}`,
    `      WHERE ${pairIdCol} = ${pairLiteral}`,
    `        AND ${decision} = ${quoteLiteral('merge', dialect)}`,
    `        AND COALESCE(${status}, ${quoteLiteral('applied', dialect)}) = ${quoteLiteral('applied', dialect)}`,
    `    ) ranked`,
    `    WHERE ranked.${rn} = 1`,
    `  ), 0)`,
    `)`,
  ].join('\n');

  return {
    name,
    sql: [
      `UPDATE ${ctx.clustersTable}`,
      `SET ${confidenceScore} = ${edgeConfExpr}`,
      `WHERE ${recordId} IN (`,
      `  SELECT ${quoteIdentifier('record_a_id', dialect)} FROM ${ctx.pairScoresTable} WHERE ${pairIdCol} = ${pairLiteral}`,
      `  ${unionDistinct(dialect)}`,
      `  SELECT ${quoteIdentifier('record_b_id', dialect)} FROM ${ctx.pairScoresTable} WHERE ${pairIdCol} = ${pairLiteral}`,
      `)`,
      `  AND ${confidenceScore} < ${edgeConfExpr}`,
    ].join('\n'),
  };
}

/** DELETE the touched entities' rows from an entity-keyed output table. */
function touchedEntityDelete(
  ctx: MaterializeContext,
  pairId: string,
  table: string,
  name: string
): SqlStatement {
  const entityId = quoteIdentifier('entity_id', ctx.dialect);
  return {
    name,
    sql: [
      `DELETE FROM ${table}`,
      `WHERE ${entityId} IN (`,
      `WITH ${scopeCtes(ctx, pairId)}`,
      `SELECT ${entityId} FROM touched_entities WHERE ${STALE_GUARD}`,
      `)`,
    ].join('\n'),
  };
}

/** Recompute + INSERT the EAV `__golden_record` rows for the winner entity. */
function goldenRecordInsert(
  ctx: MaterializeContext,
  spec: ResolvedResolutionSpec,
  targetSchema: string,
  rules: GoldenAttributeRule[],
  pairId: string,
  name: string
): SqlStatement {
  const { dialect } = ctx;
  const entityId = quoteIdentifier('entity_id', dialect);
  const ruleCtes = rules.flatMap((rule, index) =>
    buildChosenRuleCtes(spec.entity, targetSchema, rule, index, dialect, 'scoped_clusters')
  );
  const unions = rules
    .map((_rule, index) => `SELECT * FROM rule_${index}_chosen`)
    .join('\nUNION ALL\n');
  const columns = [
    'entity_id',
    'cluster_id',
    'attribute_name',
    'attribute_value',
    'source_system',
    'updated_at',
  ].map((column) => quoteIdentifier(column, dialect));
  return {
    name,
    sql: [
      `INSERT INTO ${ctx.goldenRecordTable}`,
      `  (${columns.join(', ')})`,
      `WITH ${scopeCtes(ctx, pairId)},`,
      `scoped_clusters AS (`,
      `  SELECT * FROM ${ctx.clustersTable}`,
      `  WHERE ${entityId} IN (SELECT ${entityId} FROM scoped_entities)`,
      `),`,
      ruleCtes.join(',\n') + ',',
      `new_golden_record AS (`,
      unions,
      `)`,
      `SELECT`,
      `  ${entityId},`,
      `  ${quoteIdentifier('cluster_id', dialect)},`,
      `  ${quoteIdentifier('attribute_name', dialect)},`,
      `  ${quoteIdentifier('attribute_value', dialect)},`,
      `  ${quoteIdentifier('source_system', dialect)},`,
      `  CURRENT_TIMESTAMP`,
      `FROM new_golden_record`,
      `WHERE ${STALE_GUARD}`,
    ].join('\n'),
  };
}

/** Recompute + INSERT the wide `__golden` row(s) for the winner entity. */
function goldenWideInsert(
  ctx: MaterializeContext,
  spec: ResolvedResolutionSpec,
  targetSchema: string,
  rules: GoldenAttributeRule[],
  pairId: string,
  name: string
): SqlStatement {
  const { dialect } = ctx;
  const entityId = quoteIdentifier('entity_id', dialect);
  const parts = buildGoldenWideParts(spec, dialect, targetSchema, rules, {
    clusters: 'scoped_clusters',
    goldenRecord: 'scoped_golden_record',
  });
  const columns = parts.columnNames.map((column) => quoteIdentifier(column, dialect));
  return {
    name,
    sql: [
      `INSERT INTO ${ctx.goldenTable}`,
      `  (${columns.join(', ')})`,
      `WITH ${scopeCtes(ctx, pairId)},`,
      `scoped_clusters AS (`,
      `  SELECT * FROM ${ctx.clustersTable}`,
      `  WHERE ${entityId} IN (SELECT ${entityId} FROM scoped_entities)`,
      `),`,
      `scoped_golden_record AS (`,
      `  SELECT * FROM ${ctx.goldenRecordTable}`,
      `  WHERE ${entityId} IN (SELECT ${entityId} FROM scoped_entities)`,
      `),`,
      parts.ctes.join('\n'),
      parts.selectSql,
      `WHERE ${STALE_GUARD}`,
    ].join('\n'),
  };
}

/** Re-project `__crosswalks` from `__clusters` for the winner entity. */
function crosswalksInsert(ctx: MaterializeContext, pairId: string, name: string): SqlStatement {
  const { dialect } = ctx;
  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const columns = [
    'record_id',
    'source_ref',
    'source_pk_json',
    'source_system',
    'source_entity_id',
    'entity_id',
    'cluster_id',
    'component_id',
    'confidence_score',
  ].map((column) => quoteIdentifier(column, dialect));
  return {
    name,
    sql: [
      `INSERT INTO ${ctx.crosswalksTable}`,
      `  (${columns.join(', ')}, ${quoteIdentifier('matched_at', dialect)})`,
      `WITH ${pairRecordsCte(ctx, pairId)},`,
      `scoped_entities AS (`,
      `  SELECT DISTINCT c.${entityId}`,
      `  FROM ${ctx.clustersTable} c`,
      `  JOIN pair_records p ON c.${recordId} = p.${recordId}`,
      `)`,
      `SELECT`,
      columns.map((column) => `  c.${column}`).join(',\n') + ',',
      `  c.${quoteIdentifier('clustered_at', dialect)}`,
      `FROM ${ctx.clustersTable} c`,
      `WHERE c.${entityId} IN (SELECT ${entityId} FROM scoped_entities)`,
      `  AND NOT EXISTS (`,
      `    SELECT 1 FROM ${ctx.crosswalksTable} x`,
      `    WHERE x.${recordId} = c.${recordId}`,
      `      AND x.${entityId} = c.${entityId}`,
      // Confidence must match too, so a confidence-only drift (see
      // stale_records) re-projects the row after the delete cleared it.
      `      AND COALESCE(x.${quoteIdentifier('confidence_score', dialect)}, -1.0) = COALESCE(c.${quoteIdentifier('confidence_score', dialect)}, -1.0)`,
      `  )`,
    ].join('\n'),
  };
}

/**
 * Generate the entity-scoped statements that materialize applied merge
 * decisions into `__clusters`, `__crosswalks`, `__golden_record`, and
 * `__golden`. Requires a prior resolve+cluster run (the output tables must
 * exist). Emits one sequential statement group per pair, in order, so chained
 * merges compose. See the module docblock for the full contract.
 */
export function generateIncrementalMaterializeSql(
  options: GenerateIncrementalMaterializeSqlOptions
): SqlStatement[] {
  const { spec, dialect, targetSchema, mergePairIds } = options;
  const ctx = buildContext(spec.entity, dialect, targetSchema);
  const rules = goldenRulesFor(spec, options.goldenRules);

  const statements = mergePairIds.flatMap((pairId, index) => {
    const prefix = `materialize_merge_${index + 1}`;
    return [
      unionClustersInsert(ctx, pairId, `${prefix}_union_clusters`),
      unionClustersDelete(ctx, pairId, `${prefix}_union_clusters_cleanup`),
      pairConfidenceUpdate(ctx, pairId, `${prefix}_pair_confidence`),
      touchedEntityDelete(ctx, pairId, ctx.goldenRecordTable, `${prefix}_golden_record_delete`),
      ...(rules.length > 0
        ? [
            goldenRecordInsert(
              ctx,
              spec,
              targetSchema,
              rules,
              pairId,
              `${prefix}_golden_record_insert`
            ),
          ]
        : []),
      touchedEntityDelete(ctx, pairId, ctx.goldenTable, `${prefix}_golden_delete`),
      goldenWideInsert(ctx, spec, targetSchema, rules, pairId, `${prefix}_golden_insert`),
      touchedEntityDelete(ctx, pairId, ctx.crosswalksTable, `${prefix}_crosswalks_delete`),
      crosswalksInsert(ctx, pairId, `${prefix}_crosswalks_insert`),
    ];
  });

  // Chain every statement on its predecessor (across pair groups too):
  // executors skip dependents of a failed statement, so a mid-chain failure
  // never runs later writes against partial state — the guarded statements
  // stay re-runnable and the retry signal (stale crosswalks) is preserved.
  return statements.map((statement, index) => {
    const upstream = index === 0 ? options.dependsOn : statements[index - 1]!.name;
    return upstream ? { ...statement, deps: [upstream] } : statement;
  });
}

/** Subquery over `__pair_scores` selecting the record_ids of the given pairs. */
function pairRecordIdsSubquery(ctx: MaterializeContext, mergePairIds: string[]): string {
  const { dialect } = ctx;
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const pairList = mergePairIds.map((pairId) => quoteLiteral(pairId, dialect)).join(', ');
  return [
    `    SELECT ${quoteIdentifier('record_a_id', dialect)} AS ${quoteIdentifier('record_id', dialect)}`,
    `    FROM ${ctx.pairScoresTable} WHERE ${pairIdCol} IN (${pairList})`,
    `    ${unionDistinct(dialect)}`,
    `    SELECT ${quoteIdentifier('record_b_id', dialect)} AS ${quoteIdentifier('record_id', dialect)}`,
    `    FROM ${ctx.pairScoresTable} WHERE ${pairIdCol} IN (${pairList})`,
  ].join('\n');
}

/**
 * Post-materialization read: the current (post-merge) entity_ids of the
 * records touched by the given merge pairs.
 */
export function generateTouchedEntityIdsQuery(
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string,
  mergePairIds: string[]
): string {
  const ctx = buildContext(entity, dialect, targetSchema);
  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  return [
    `SELECT DISTINCT x.${entityId}`,
    `FROM ${ctx.crosswalksTable} x`,
    `WHERE x.${recordId} IN (`,
    pairRecordIdsSubquery(ctx, mergePairIds),
    `)`,
    `ORDER BY x.${entityId}`,
  ].join('\n');
}

/**
 * Post-materialization read: the updated wide `__golden` rows for the entities
 * touched by the given merge pairs, so callers can reflect them immediately.
 */
export function generateUpdatedGoldenRowsQuery(
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string,
  mergePairIds: string[]
): string {
  const ctx = buildContext(entity, dialect, targetSchema);
  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  return [
    `SELECT g.*`,
    `FROM ${ctx.goldenTable} g`,
    `WHERE g.${entityId} IN (`,
    `  SELECT DISTINCT x.${entityId}`,
    `  FROM ${ctx.crosswalksTable} x`,
    `  WHERE x.${recordId} IN (`,
    pairRecordIdsSubquery(ctx, mergePairIds),
    `  )`,
    `)`,
    `ORDER BY g.${entityId}`,
  ].join('\n');
}
