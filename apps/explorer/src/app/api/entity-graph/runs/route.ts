import { NextResponse } from 'next/server';
import { readRunLog } from '@/lib/entity-graph-workspace';
import {
  isEntityGraphEntityId,
  isEntityGraphScenarioId,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
  const rawScenario = url.searchParams.get('scenario');
  let scenario: EntityGraphScenarioId = 'default';
  if (rawScenario) {
    if (!isEntityGraphScenarioId(rawScenario)) {
      return NextResponse.json({ error: `Unsupported scenario: ${rawScenario}` }, { status: 400 });
    }
    scenario = rawScenario;
  }
  const rawEntity = url.searchParams.get('entity');
  let entity: EntityGraphEntityId | undefined;
  // Distinguish "no filter" (null) from "filter set to empty string". The
  // empty string is an explicit filter that matches no entity — treat it as
  // a 400, otherwise the empty-string filter silently widens to all rows.
  if (rawEntity !== null) {
    if (!isEntityGraphEntityId(rawEntity)) {
      return NextResponse.json({ error: `Unsupported entity: ${rawEntity}` }, { status: 400 });
    }
    entity = rawEntity;
  }
  try {
    // When filtering by entity, scan the full run log so a long stretch of
    // other-entity runs at the head of the log can't underfill the response.
    // The log is a small JSONL file (one line per pipeline run) so reading
    // it whole is cheap; the previous 50-row prefilter left us blind to
    // older matching runs in mixed-entity histories.
    const fetchLimit = entity ? Number.MAX_SAFE_INTEGER : safeLimit;
    const allRuns = await readRunLog(fetchLimit, scenario);
    const runs = entity
      ? allRuns.filter((run) => run.entity === entity).slice(0, safeLimit)
      : allRuns;
    return NextResponse.json({ scenario, entity, runs });
  } catch {
    return NextResponse.json({ error: 'Failed to load Entity Graph runs' }, { status: 500 });
  }
}
