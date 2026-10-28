import { NextResponse } from 'next/server';
import { getEntityGraphInsightCardsByIds } from '@/lib/entity-graph-insights';
import {
  isInvalidEntityGraphInputError,
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scenario = url.searchParams.get('scenario');
  const entity = url.searchParams.get('entity');

  let scenarioId: EntityGraphScenarioId;
  let entityId: EntityGraphEntityId;
  try {
    const resolved = resolveEntityGraphScenarioEntity(scenario, entity);
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
  } catch (err) {
    if (isInvalidEntityGraphInputError(err)) {
      return NextResponse.json({ error: err.message, code: 'invalid_request' }, { status: 400 });
    }
    logServerError('apps/explorer/api/entity-graph-insights:get:resolve', err, {
      scenario,
      entity,
    });
    return NextResponse.json({ error: 'Failed to load Entity Graph insights' }, { status: 500 });
  }

  try {
    const cards = await getEntityGraphInsightCardsByIds(scenarioId, entityId);
    return NextResponse.json({ scenario: scenarioId, entity: entityId, cards });
  } catch (error) {
    logServerError('apps/explorer/api/entity-graph-insights:get', error, {
      scenario: scenarioId,
      entity: entityId,
    });
    return NextResponse.json({ error: 'Failed to load Entity Graph insights' }, { status: 500 });
  }
}
