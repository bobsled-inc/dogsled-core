import { NextResponse } from 'next/server';
import {
  collectOutput,
  getEntityGraphRunnerPath,
  isEntityGraphWorkspaceReady,
  spawnEntityGraphCommand,
} from '@/lib/entity-graph-workspace';
import {
  isInvalidEntityGraphInputError,
  resolveEntityGraphScenarioEntity,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { isPlainObject } from '@/lib/guards';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

type Decision = 'merge' | 'not_match' | 'defer';
const DECISIONS: Decision[] = ['merge', 'not_match', 'defer'];

const PAIR_ID_RE = /^[a-f0-9]{8,64}$/i;
const REASON_MAX = 500;

type DecideBody = {
  scenario?: string;
  entity?: string;
  pairId?: string;
  decision?: Decision;
  reviewer?: string;
  reason?: string;
};

interface EntityGraphStepContext {
  pairId: string;
  entity: string;
  scenario: EntityGraphScenarioId;
}

async function runEntityGraphStep(
  label: string,
  args: string[],
  scenarioId: EntityGraphScenarioId,
  context: EntityGraphStepContext
): Promise<void> {
  const child = spawnEntityGraphCommand(args, scenarioId);
  const { stdout, stderr, code } = await collectOutput(child, { timeoutMs: 60_000 });
  if (code !== 0) {
    logServerError(`apps/explorer/api/entity-graph-decide:${label}`, new Error(`Exit ${code}`), {
      ...context,
      code,
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
    });
    throw new Error(`Failed during ${label}`);
  }
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  if (!isPlainObject(raw)) {
    return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
  }

  const body = raw as DecideBody;
  const { pairId, decision } = body;
  let scenarioId: EntityGraphScenarioId;
  let entityId: string;
  let survivorshipSpec: string;

  try {
    const resolved = resolveEntityGraphScenarioEntity(body.scenario, body.entity);
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
    survivorshipSpec = resolved.entity.defaultSurvivorshipSpec;
    if (!isEntityGraphWorkspaceReady(resolved.scenarioId)) {
      return NextResponse.json({ error: 'Entity Graph workspace not found' }, { status: 404 });
    }
  } catch (err) {
    if (isInvalidEntityGraphInputError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logServerError('apps/explorer/api/entity-graph-decide:resolve', err, {
      scenario: body.scenario,
      entity: body.entity,
    });
    return NextResponse.json({ error: 'Failed to load Entity Graph workspace' }, { status: 500 });
  }

  // Guard non-string fields before trimming so malformed payloads surface as
  // 400s, not 500s from a TypeError on `undefined.trim()`.
  if (body.reviewer !== undefined && typeof body.reviewer !== 'string') {
    return NextResponse.json({ error: 'reviewer must be a string' }, { status: 400 });
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string' }, { status: 400 });
  }
  const reviewer = body.reviewer?.trim() || 'explorer-ui';
  const reason = body.reason?.trim();

  if (!pairId || !PAIR_ID_RE.test(pairId)) {
    return NextResponse.json({ error: 'pairId required (hex, 8-64 chars)' }, { status: 400 });
  }
  if (!decision || !DECISIONS.includes(decision)) {
    return NextResponse.json(
      { error: `decision must be one of ${DECISIONS.join(', ')}` },
      { status: 400 }
    );
  }
  if (!/^[\w.\- ]{1,80}$/.test(reviewer)) {
    return NextResponse.json({ error: 'Invalid reviewer name' }, { status: 400 });
  }
  if (reason && reason.length > REASON_MAX) {
    return NextResponse.json({ error: `reason must be <= ${REASON_MAX} chars` }, { status: 400 });
  }

  const args = [
    'review',
    'decide',
    '--entity',
    entityId,
    '--pair-id',
    pairId,
    '--decision',
    decision,
    '--reviewer',
    reviewer,
    '--runner',
    getEntityGraphRunnerPath(scenarioId),
    '--json',
  ];
  if (reason) args.push('--reason', reason);

  try {
    const child = spawnEntityGraphCommand(args, scenarioId);
    const { stdout, stderr, code } = await collectOutput(child, { timeoutMs: 30_000 });
    if (code !== 0) {
      logServerError('apps/explorer/api/entity-graph-decide:cli', new Error(`Exit ${code}`), {
        code,
        stdout: stdout.trim() || undefined,
        stderr: stderr.trim() || undefined,
        pairId,
        scenario: scenarioId,
        entity: entityId,
      });
      return NextResponse.json({ error: 'Failed to record review decision.' }, { status: 500 });
    }

    let parsed: unknown = null;
    try {
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      if (lastLine) parsed = JSON.parse(lastLine);
    } catch {
      // fall through — return raw stdout
    }

    const shouldRefreshClusters = decision === 'merge' || decision === 'not_match';
    let refreshed = false;
    if (shouldRefreshClusters) {
      try {
        await runEntityGraphStep(
          'resolve.cluster',
          ['resolve', 'cluster', entityId, '--runner', getEntityGraphRunnerPath(scenarioId)],
          scenarioId,
          { pairId, entity: entityId, scenario: scenarioId }
        );
        await runEntityGraphStep(
          'resolve.profile',
          ['resolve', 'profile', entityId, '--runner', getEntityGraphRunnerPath(scenarioId)],
          scenarioId,
          { pairId, entity: entityId, scenario: scenarioId }
        );
        await runEntityGraphStep(
          'survivorship.run',
          [
            'survivorship',
            'run',
            survivorshipSpec,
            '--runner',
            getEntityGraphRunnerPath(scenarioId),
          ],
          scenarioId,
          { pairId, entity: entityId, scenario: scenarioId }
        );
        refreshed = true;
      } catch (refreshError) {
        logServerError('apps/explorer/api/entity-graph-decide:refresh', refreshError, {
          pairId,
          scenario: scenarioId,
          entity: entityId,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      scenario: scenarioId,
      entity: entityId,
      result: parsed,
      refreshed,
    });
  } catch (err) {
    logServerError('apps/explorer/api/entity-graph-decide:request', err, {
      pairId,
      scenario: scenarioId,
      entity: entityId,
    });
    return NextResponse.json({ error: 'Failed to record review decision.' }, { status: 500 });
  }
}
