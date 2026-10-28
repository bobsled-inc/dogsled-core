import { NextResponse } from 'next/server';
import { isEntityGraphWorkspaceReady } from '@/lib/entity-graph-workspace';
import {
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityDefinition,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { isPlainObject } from '@/lib/guards';
import { ClaudeJsonRequestError } from '@/lib/claude-json';
import { clampAgentSampleLimit, getClaudeFailureHttpStatus } from '@/lib/entity-graph-agent-sample';
import {
  InvalidAgentAssessmentPayloadError,
  runClaudeAgentReviewSample,
} from '@/lib/entity-graph-agent-sample-server';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

// Explorer runs this sample in a local/demo Next.js process. A process-local
// guard is enough to prevent duplicate Claude + DuckDB writes in that runtime.
let agentReviewInFlight = false;

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  if (!isPlainObject(raw)) {
    return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
  }

  const body = raw as { scenario?: string; entity?: string; limit?: unknown };
  let scenarioId: EntityGraphScenarioId;
  let entityId: EntityGraphEntityId;
  let entity: EntityGraphEntityDefinition;

  try {
    const resolved = resolveEntityGraphScenarioEntity(body.scenario, body.entity);
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
    entity = resolved.entity;
    if (!isEntityGraphWorkspaceReady(resolved.scenarioId)) {
      return NextResponse.json({ error: 'Entity Graph workspace not found' }, { status: 404 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  const limit = clampAgentSampleLimit(body.limit);
  if (agentReviewInFlight) {
    return NextResponse.json(
      {
        error: 'Agent review sample is already running.',
        code: 'agent_review_busy',
        detail: 'Wait for the current sample to finish, then retry.',
      },
      { status: 429 }
    );
  }

  agentReviewInFlight = true;
  try {
    const { result, assessments } = await runClaudeAgentReviewSample({
      scenarioId,
      entityId,
      entity,
      limit,
    });
    return NextResponse.json({
      scenario: scenarioId,
      entity: entityId,
      result,
      assessments,
    });
  } catch (err) {
    if (err instanceof InvalidAgentAssessmentPayloadError) {
      logServerError(
        'apps/explorer/api/entity-graph-agent-review:shape',
        'Invalid Claude payload',
        {
          scenario: scenarioId,
          entity: entityId,
        }
      );
      return NextResponse.json(
        { error: 'Agent review returned an invalid response.' },
        { status: 500 }
      );
    }

    if (err instanceof ClaudeJsonRequestError) {
      logServerError('apps/explorer/api/entity-graph-agent-review:claude', err.message, {
        code: err.code,
        scenario: scenarioId,
        entity: entityId,
      });
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          hint: err.hint,
          detail: err.message,
        },
        { status: getClaudeFailureHttpStatus(err.code) }
      );
    }

    logServerError('apps/explorer/api/entity-graph-agent-review:request', err, {
      scenario: scenarioId,
      entity: entityId,
    });
    return NextResponse.json({ error: 'Agent review failed.' }, { status: 500 });
  } finally {
    agentReviewInFlight = false;
  }
}
