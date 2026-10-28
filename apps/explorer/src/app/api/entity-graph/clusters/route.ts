import { NextResponse } from 'next/server';
import {
  formatEntityGraphTableName,
  withEntityGraphWorkspaceQuery,
} from '@/lib/entity-graph-workspace';
import {
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { logServerError } from '@/lib/server-logging';
import {
  getEntityGraphBusyActionableError,
  getEntityGraphWorkspaceActionableError,
} from '@/lib/entity-graph-workspace-state';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  let scenarioId: EntityGraphScenarioId | null = null;
  let entityId: EntityGraphEntityId | null = null;
  const rawLimit = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;

  try {
    const resolved = resolveEntityGraphScenarioEntity(
      url.searchParams.get('scenario'),
      url.searchParams.get('entity')
    );
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), code: 'invalid_request' },
      { status: 400 }
    );
  }

  if (!scenarioId || !entityId) {
    return NextResponse.json(
      { error: 'Entity Graph workspace not found', code: 'workspace_missing' },
      { status: 404 }
    );
  }

  try {
    const readinessError = await getEntityGraphWorkspaceActionableError(scenarioId, entityId);
    if (readinessError) {
      return NextResponse.json(readinessError.body, { status: readinessError.status });
    }

    const sql = `
      SELECT
        ep.cluster_id,
        ep.display_name,
        ep.profile_attrs,
        ep.source_count,
        ep.record_count,
        ep.entity_confidence,
        ep.observed_at,
        eq.trust_tier,
        eq.entity_trust_score,
        eq.identity_confidence,
        eq.freshness_score,
        eq.source_diversity_score,
        eq.profile_attribute_coverage
      FROM ${formatEntityGraphTableName(entityId, '__entity_profile', scenarioId)} ep
      LEFT JOIN ${formatEntityGraphTableName(entityId, '__entity_quality', scenarioId)} eq
        ON ep.cluster_id = eq.cluster_id
      ORDER BY ep.record_count DESC, ep.display_name ASC
      LIMIT ${limit}
    `;
    const { rows, summary, totalRows } = await withEntityGraphWorkspaceQuery(
      scenarioId,
      async (query) => ({
        rows: await query(sql),
        summary: await query<{ trust_tier: string; n: number }>(`
          SELECT trust_tier, COUNT(*) AS n
          FROM ${formatEntityGraphTableName(entityId, '__entity_quality', scenarioId)}
          GROUP BY trust_tier
        `),
        totalRows: await query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${formatEntityGraphTableName(entityId, '__entity_profile', scenarioId)}`
        ),
      })
    );

    return NextResponse.json({
      rows,
      scenario: scenarioId,
      entity: entityId,
      count: rows.length,
      totals: {
        clusters: totalRows[0]?.n ?? 0,
        by_trust_tier: summary,
      },
    });
  } catch (err) {
    const busyError = getEntityGraphBusyActionableError(err);
    if (busyError) {
      return NextResponse.json(busyError.body, { status: busyError.status });
    }

    logServerError('apps/explorer/api/entity-graph-clusters:list', err);
    return NextResponse.json(
      {
        error: 'Failed to load clusters',
        detail:
          'Retry once. If the problem persists, rerun the pipeline and inspect the latest run logs.',
        code: 'clusters_failed',
      },
      { status: 500 }
    );
  }
}
