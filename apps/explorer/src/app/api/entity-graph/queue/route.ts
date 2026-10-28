import { NextResponse } from 'next/server';
import {
  buildEntityGraphCompareFields,
  buildEntityGraphCompareSelectList,
  buildEntityGraphFeatureContributions,
  resolveEntityGraphScenarioEntity,
  type EntityGraphCompareFieldValue,
  type EntityGraphEntityId,
  type EntityGraphFeatureContribution,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import {
  escapeSqlLiteral,
  formatEntityGraphTableName,
  withEntityGraphWorkspaceQuery,
} from '@/lib/entity-graph-workspace';
import {
  buildEntityGraphQueueStatusClause,
  type EntityGraphQueueStatus,
} from '@/lib/entity-graph-review-status';
import {
  getEntityGraphBusyActionableError,
  getEntityGraphWorkspaceActionableError,
} from '@/lib/entity-graph-workspace-state';
import { CLAUDE_AGENT_DECISION_SOURCE } from '@/lib/entity-graph-agent-sample';
import type {
  EntityGraphQueueDecisionMetadata,
  EntityGraphReviewPairSqlRow,
} from '@/lib/entity-graph-queue-rows';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

interface QueueSqlRow extends EntityGraphReviewPairSqlRow, EntityGraphQueueDecisionMetadata {}

function isValidStatus(v: string): v is EntityGraphQueueStatus {
  return v === 'open' || v === 'decided' || v === 'all';
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  let scenarioId: EntityGraphScenarioId;
  let entityId: EntityGraphEntityId;
  let entity: ReturnType<typeof resolveEntityGraphScenarioEntity>['entity'];

  try {
    const resolved = resolveEntityGraphScenarioEntity(
      url.searchParams.get('scenario'),
      url.searchParams.get('entity')
    );
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
    entity = resolved.entity;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), code: 'invalid_request' },
      { status: 400 }
    );
  }
  const statusParam = url.searchParams.get('status');
  const rawBatchParam = url.searchParams.get('decisionBatchId') ?? url.searchParams.get('batch');
  const batchParam = rawBatchParam?.trim() || null;
  const rawLimit = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;

  const status = statusParam ?? 'open';
  if (!isValidStatus(status)) {
    return NextResponse.json({ error: 'Invalid status', code: 'invalid_request' }, { status: 400 });
  }
  if (batchParam && batchParam.length > 128) {
    return NextResponse.json(
      { error: 'Invalid decision batch id', code: 'invalid_request' },
      { status: 400 }
    );
  }
  try {
    const readinessError = await getEntityGraphWorkspaceActionableError(scenarioId, entityId);
    if (readinessError) {
      return NextResponse.json(readinessError.body, { status: readinessError.status });
    }

    const statusClause = buildEntityGraphQueueStatusClause(status);
    const batchClause = batchParam
      ? ` AND ld."decision_batch_id" = '${escapeSqlLiteral(batchParam)}'`
      : '';

    const compareSelect = buildEntityGraphCompareSelectList(entity, 'sa', 'a')
      .concat(buildEntityGraphCompareSelectList(entity, 'sb', 'b'))
      .join(',\n        ');

    const sql = `
      WITH latest_decisions AS (
        SELECT pair_id, decision, confidence, reason, reviewer, decided_at,
          status AS decision_status, proposed_decision, proposed_confidence,
          decision_source, decision_batch_id,
          ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY decided_at DESC, applied_at DESC) AS rn
        FROM ${formatEntityGraphTableName(entityId, '__review_decisions', scenarioId)}
      ),
      latest_human_decisions AS (
        SELECT pair_id, decision, confidence, reason, reviewer, decided_at,
          status AS decision_status,
          ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY decided_at DESC, applied_at DESC) AS rn
        FROM ${formatEntityGraphTableName(entityId, '__review_decisions', scenarioId)}
        WHERE COALESCE(decision_source, '') <> '${escapeSqlLiteral(CLAUDE_AGENT_DECISION_SOURCE)}'
      )
      SELECT
        rq.pair_id,
        rq.record_a_id,
        rq.record_b_id,
        rq.source_a,
        rq.source_b,
        rq.composite_score,
        rq.threshold_band,
        rq.blocking_rules,
        rq.field_diffs,
        rq.recommended_action,
        ${compareSelect},
        ld.decision         AS decision,
        ld.confidence       AS decision_confidence,
        ld.reason           AS decision_reason,
        ld.reviewer         AS decision_reviewer,
        ld.decided_at       AS decided_at,
        ld.decision_status  AS decision_status,
        ld.proposed_decision AS proposed_decision,
        ld.proposed_confidence AS proposed_confidence,
        ld.decision_source AS decision_source,
        ld.decision_batch_id AS decision_batch_id,
        hd.decision AS human_decision,
        hd.confidence AS human_decision_confidence,
        hd.reason AS human_decision_reason,
        hd.reviewer AS human_decision_reviewer,
        hd.decided_at AS human_decided_at,
        hd.decision_status AS human_decision_status
      FROM ${formatEntityGraphTableName(entityId, '__review_queue', scenarioId)} rq
      LEFT JOIN ${formatEntityGraphTableName(entityId, '__standardized', scenarioId)} sa
        ON rq."record_a_id" = sa."record_id"
      LEFT JOIN ${formatEntityGraphTableName(entityId, '__standardized', scenarioId)} sb
        ON rq."record_b_id" = sb."record_id"
      LEFT JOIN latest_decisions ld
        ON rq."pair_id" = ld."pair_id" AND ld.rn = 1
      LEFT JOIN latest_human_decisions hd
        ON rq."pair_id" = hd."pair_id" AND hd.rn = 1
      WHERE ${statusClause}${batchClause}
      ORDER BY rq."composite_score" DESC
      LIMIT ${limit}
    `;

    const { rawRows, counts } = await withEntityGraphWorkspaceQuery(scenarioId, async (query) => ({
      rawRows: await query<QueueSqlRow>(sql),
      counts: await query<{ threshold_band: string; n: number | bigint }>(`
        WITH latest_decisions AS (
          SELECT pair_id, decision, status AS decision_status, decision_batch_id,
            ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY decided_at DESC, applied_at DESC) AS rn
          FROM ${formatEntityGraphTableName(entityId, '__review_decisions', scenarioId)}
        )
        SELECT rq.threshold_band, COUNT(*) AS n
        FROM ${formatEntityGraphTableName(entityId, '__review_queue', scenarioId)} rq
        LEFT JOIN latest_decisions ld
          ON rq."pair_id" = ld."pair_id" AND ld.rn = 1
        WHERE ${statusClause}${batchClause}
        GROUP BY rq.threshold_band
      `),
    }));
    const bands = counts.map((row) => ({
      threshold_band: row.threshold_band,
      n: Number(row.n),
    }));

    const rows = rawRows.map((row) => {
      const compareFields = buildEntityGraphCompareFields(entity, row);
      const featureContributions = buildEntityGraphFeatureContributions(entity, row);
      const firstField = compareFields[0];
      return {
        ...row,
        compare_fields: compareFields satisfies EntityGraphCompareFieldValue[],
        feature_contributions: featureContributions satisfies EntityGraphFeatureContribution[],
        a_display_label:
          firstField?.a ?? (typeof row.record_a_id === 'string' ? row.record_a_id : null),
        b_display_label:
          firstField?.b ?? (typeof row.record_b_id === 'string' ? row.record_b_id : null),
      };
    });

    return NextResponse.json({
      rows,
      scenario: scenarioId,
      entity: entityId,
      status,
      decision_batch_id_filter: batchParam ?? null,
      count: rows.length,
      bands,
    });
  } catch (err) {
    const busyError = getEntityGraphBusyActionableError(err);
    if (busyError) {
      return NextResponse.json(busyError.body, { status: busyError.status });
    }

    logServerError('apps/explorer/api/entity-graph-queue:list', err);
    return NextResponse.json(
      {
        error: 'Failed to load review queue',
        detail:
          'Retry once. If the problem persists, rerun the pipeline and inspect the latest run logs.',
        code: 'queue_failed',
      },
      { status: 500 }
    );
  }
}
