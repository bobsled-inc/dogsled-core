import { NextResponse } from 'next/server';
import {
  escapeSqlLiteral,
  formatEntityGraphTableName,
  isEntityGraphWorkspaceReady,
  withEntityGraphWorkspaceQuery,
} from '@/lib/entity-graph-workspace';
import { getEntityGraphBusyActionableError } from '@/lib/entity-graph-workspace-state';
import {
  buildEntityGraphMemberFields,
  buildEntityGraphMemberSelectList,
  isInvalidEntityGraphInputError,
  labelEntityGraphGoldenAttribute,
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

interface EntityGraphJsonRow {
  [key: string]: unknown;
}

function coerceBigInts<T extends EntityGraphJsonRow>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? Number(value) : value,
    ])
  ) as T;
}

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid cluster id' }, { status: 400 });
  }

  const url = new URL(req.url);
  let scenarioId: EntityGraphScenarioId | null = null;
  let entityId: EntityGraphEntityId | null = null;
  let entity = null;
  try {
    const resolved = resolveEntityGraphScenarioEntity(
      url.searchParams.get('scenario'),
      url.searchParams.get('entity')
    );
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
    entity = resolved.entity;
    if (!isEntityGraphWorkspaceReady(resolved.scenarioId)) {
      return NextResponse.json({ error: 'Entity Graph workspace not found' }, { status: 404 });
    }
  } catch (err) {
    if (isInvalidEntityGraphInputError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logServerError('apps/explorer/api/entity-graph-clusters:resolve', err, {
      scenario: url.searchParams.get('scenario'),
      entity: url.searchParams.get('entity'),
      cluster_id: id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  if (!scenarioId || !entityId || !entity) {
    return NextResponse.json({ error: 'Entity Graph workspace not found' }, { status: 404 });
  }

  const safeId = escapeSqlLiteral(id);

  try {
    const memberSelect = buildEntityGraphMemberSelectList(entity, 's').join(',\n        ');
    const { profile, members, rawGolden, audit } = await withEntityGraphWorkspaceQuery(
      scenarioId,
      async (query) => ({
        profile: await query<EntityGraphJsonRow>(`
          SELECT
            ep.*,
            eq.trust_tier,
            eq.entity_trust_score,
            eq.identity_confidence,
            eq.freshness_score,
            eq.source_diversity_score,
            eq.profile_attribute_coverage
          FROM ${formatEntityGraphTableName(entityId, '__entity_profile', scenarioId)} ep
          LEFT JOIN ${formatEntityGraphTableName(entityId, '__entity_quality', scenarioId)} eq
            ON ep.cluster_id = eq.cluster_id
          WHERE ep.cluster_id = '${safeId}'
        `),
        members: await query<EntityGraphJsonRow>(`
          SELECT
            cw.record_id,
            cw.source_ref,
            cw.source_system,
            cw.source_entity_id,
            cw.confidence_score,
            cw.matched_at,
            ${memberSelect}
          FROM ${formatEntityGraphTableName(entityId, '__crosswalks', scenarioId)} cw
          LEFT JOIN ${formatEntityGraphTableName(entityId, '__standardized', scenarioId)} s
            ON cw.record_id = s.record_id
          WHERE cw.cluster_id = '${safeId}'
          ORDER BY cw.matched_at DESC
        `),
        rawGolden: await query<EntityGraphJsonRow>(`
          SELECT attribute_name, attribute_value, source_system, updated_at
          FROM ${formatEntityGraphTableName(entityId, '__golden_record', scenarioId)}
          WHERE cluster_id = '${safeId}'
          ORDER BY attribute_name ASC
        `),
        audit: await query<EntityGraphJsonRow>(`
          SELECT attribute_name, chosen_value, source_system, strategy, decided_at
          FROM ${formatEntityGraphTableName(entityId, '__survivorship_audit', scenarioId)}
          WHERE cluster_id = '${safeId}'
          ORDER BY decided_at DESC, attribute_name ASC
        `),
      })
    );

    if (profile.length === 0) {
      return NextResponse.json({ error: 'Cluster not found', cluster_id: id }, { status: 404 });
    }

    const profileRows = profile.map(coerceBigInts);
    const memberRows = members.map(coerceBigInts);
    const goldenRows = rawGolden.map(coerceBigInts);
    const auditRows = audit.map(coerceBigInts);

    const hydratedMembers = memberRows.map((row) => ({
      ...row,
      member_fields: buildEntityGraphMemberFields(entity, row),
    }));
    const golden = goldenRows.map((row) => ({
      ...row,
      attribute_label:
        typeof row.attribute_name === 'string'
          ? labelEntityGraphGoldenAttribute(entity, row.attribute_name)
          : null,
    }));
    return NextResponse.json({
      cluster_id: id,
      scenario: scenarioId,
      entity: entityId,
      profile: profileRows[0],
      members: hydratedMembers,
      golden_record: golden,
      survivorship_audit: auditRows,
      business_snapshot: [],
    });
  } catch (err) {
    const busyError = getEntityGraphBusyActionableError(err);
    if (busyError) {
      return NextResponse.json(busyError.body, { status: busyError.status });
    }
    logServerError('apps/explorer/api/entity-graph-clusters:detail', err);
    return NextResponse.json({ error: 'Failed to load cluster details' }, { status: 500 });
  }
}
