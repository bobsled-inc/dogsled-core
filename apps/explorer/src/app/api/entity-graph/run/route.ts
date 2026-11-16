import { NextResponse } from 'next/server';
import {
  appendRunLog,
  getEntityGraphWorkspaceRoot,
  getEntityGraphRunnerPath,
  isEntityGraphWorkspaceReady,
  spawnBobsledCommand,
} from '@/lib/entity-graph-workspace';
import {
  isInvalidEntityGraphInputError,
  resolveEntityGraphScenarioEntity,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import { isPlainObject } from '@/lib/guards';
import {
  cancelEntityGraphRun,
  claimEntityGraphRun,
  getActiveEntityGraphRunId,
  releaseEntityGraphRun,
} from '@/lib/entity-graph-run-manager';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

type Step = {
  command: 'entity-graph' | 'model';
  label: string;
  argv: string[];
};

type RunFailure = {
  step?: string;
  code: string;
  message: string;
};

interface RunSseEvent {
  stream: 'run' | 'step' | 'stdout' | 'stderr' | 'error' | 'exit';
  step?: string;
  data:
    | string
    | number
    | {
        runId?: string;
        startedAt?: string;
        entity?: string;
        steps?: number;
        index?: number;
        label?: string;
        status?: 'start' | 'ok' | 'fail';
        code?: number;
        finishedAt?: string;
      };
}

const STEP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build the ordered list of CLI invocations that together populate every
 * Entity Graph output table consumed by the Resolve workspace UI.
 */
function buildSteps(entity: string, survivorshipSpec: string, runnerPath: string): Step[] {
  const runnerFlag = ['--runner', runnerPath];
  return [
    {
      command: 'model',
      label: 'seed:load',
      argv: ['seed', 'load', '--dialect', 'duckdb', ...runnerFlag],
    },
    {
      command: 'entity-graph',
      label: 'resolve:run',
      argv: ['resolve', 'run', entity, ...runnerFlag],
    },
    {
      command: 'entity-graph',
      label: 'resolve:cluster',
      argv: ['resolve', 'cluster', entity, ...runnerFlag],
    },
    {
      command: 'entity-graph',
      label: 'resolve:profile',
      argv: ['resolve', 'profile', entity, ...runnerFlag],
    },
    {
      command: 'entity-graph',
      label: 'survivorship:run',
      argv: ['survivorship', 'run', survivorshipSpec, ...runnerFlag],
    },
  ];
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  if (!isPlainObject(raw)) {
    return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
  }

  const body = raw as {
    scenario?: string;
    entity?: string;
    resolutionSpec?: string;
    survivorshipSpec?: string;
  };

  let scenarioId: EntityGraphScenarioId;
  let entityId: EntityGraphEntityId;
  let defaultResolutionSpec: string;
  let defaultSurvivorshipSpec: string;

  try {
    const resolved = resolveEntityGraphScenarioEntity(body.scenario, body.entity);
    scenarioId = resolved.scenarioId;
    entityId = resolved.entityId;
    defaultResolutionSpec = resolved.entity.defaultResolutionSpec;
    defaultSurvivorshipSpec = resolved.entity.defaultSurvivorshipSpec;
    if (!isEntityGraphWorkspaceReady(resolved.scenarioId)) {
      return NextResponse.json({ error: 'Entity Graph workspace not found' }, { status: 404 });
    }
  } catch (err) {
    if (isInvalidEntityGraphInputError(err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logServerError('apps/explorer/api/entity-graph-run:resolve', err, {
      scenario: body.scenario,
      entity: body.entity,
    });
    return NextResponse.json({ error: 'Failed to load Entity Graph workspace' }, { status: 500 });
  }

  const resolutionSpec = body.resolutionSpec ?? defaultResolutionSpec;
  const survivorshipSpec = body.survivorshipSpec ?? defaultSurvivorshipSpec;

  if (resolutionSpec !== defaultResolutionSpec) {
    return NextResponse.json(
      { error: 'resolutionSpec overrides are not yet supported by the demo runner' },
      { status: 400 }
    );
  }
  if (survivorshipSpec !== defaultSurvivorshipSpec) {
    return NextResponse.json({ error: 'Unsupported demo survivorship spec' }, { status: 400 });
  }

  const runnerPath = getEntityGraphRunnerPath(scenarioId);
  const steps = buildSteps(entityId, survivorshipSpec, runnerPath);

  const startedAt = new Date().toISOString();
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let currentChild: ReturnType<typeof spawnBobsledCommand> | null = null;
  let cancelled = false;
  let lastFailure: RunFailure | null = null;

  const cancelActiveStep = () => {
    cancelled = true;
    if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
      currentChild.kill('SIGTERM');
    }
  };

  if (!claimEntityGraphRun(runId, cancelActiveStep)) {
    return NextResponse.json(
      {
        error:
          'Entity Graph run already in progress. Wait for the current run to finish and retry.',
        runId: getActiveEntityGraphRunId(),
      },
      { status: 409 }
    );
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: RunSseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
          cancelActiveStep();
        }
      };

      let exitCode = 0;

      try {
        send({ stream: 'run', data: { runId, startedAt, entity: entityId, steps: steps.length } });

        for (let idx = 0; idx < steps.length; idx += 1) {
          if (cancelled) {
            exitCode = 1;
            break;
          }

          const step = steps[idx]!;
          send({ stream: 'step', data: { index: idx, label: step.label, status: 'start' } });

          try {
            currentChild = spawnBobsledCommand(step.command, step.argv, {
              cwd: getEntityGraphWorkspaceRoot(scenarioId),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lastFailure = { step: step.label, code: 'spawn_failed', message };
            send({ stream: 'error', step: step.label, data: message });
            send({
              stream: 'step',
              data: { index: idx, label: step.label, status: 'fail', code: 1 },
            });
            exitCode = 1;
            break;
          }

          const child = currentChild;
          let stdoutBuf = '';
          let stderrBuf = '';
          let lastStderrLine: string | null = null;
          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() ?? '';
            for (const line of lines) {
              if (line) send({ stream: 'stdout', step: step.label, data: line });
            }
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            const lines = stderrBuf.split('\n');
            stderrBuf = lines.pop() ?? '';
            for (const line of lines) {
              if (line) {
                lastStderrLine = line;
                send({ stream: 'stderr', step: step.label, data: line });
              }
            }
          });

          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const code = await new Promise<number>((resolve, reject) => {
            let timedOut = false;
            timeoutId = setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              const forceKillId = setTimeout(() => child.kill('SIGKILL'), 5_000);
              child.once('close', () => {
                clearTimeout(forceKillId);
                reject(new Error(`Step ${step.label} timed out after ${STEP_TIMEOUT_MS / 1000}s`));
              });
            }, STEP_TIMEOUT_MS);
            child.once('error', (err) => {
              if (!timedOut) reject(err);
            });
            child.once('close', (c) => {
              if (!timedOut) resolve(c ?? 1);
            });
          })
            .catch((err: Error) => {
              lastFailure = { step: step.label, code: 'timeout', message: err.message };
              if (!cancelled) {
                send({ stream: 'error', step: step.label, data: err.message });
              }
              return 1;
            })
            .finally(() => {
              if (timeoutId) clearTimeout(timeoutId);
            });

          currentChild = null;
          if (!cancelled) {
            if (stdoutBuf) send({ stream: 'stdout', step: step.label, data: stdoutBuf });
            if (stderrBuf) {
              lastStderrLine = stderrBuf;
              send({ stream: 'stderr', step: step.label, data: stderrBuf });
            }

            send({
              stream: 'step',
              data: { index: idx, label: step.label, status: code === 0 ? 'ok' : 'fail', code },
            });
          }

          if (code !== 0) {
            if (!lastFailure) {
              lastFailure = {
                step: step.label,
                code: 'step_failed',
                message: lastStderrLine ?? `Step ${step.label} exited with code ${code}`,
              };
            }
            exitCode = code;
            break;
          }
        }
      } catch (err) {
        exitCode = 1;
        lastFailure = {
          code: 'unexpected',
          message: err instanceof Error ? err.message : String(err),
        };
        if (!cancelled) {
          send({
            stream: 'error',
            data: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        currentChild = null;

        const finishedAt = new Date().toISOString();
        await appendRunLog(
          {
            run_id: runId,
            scenario: scenarioId,
            entity: entityId,
            resolution_spec: resolutionSpec,
            survivorship_spec: survivorshipSpec,
            status: exitCode === 0 && !cancelled ? 'success' : 'failed',
            started_at: startedAt,
            finished_at: finishedAt,
            failure_step: lastFailure?.step,
            failure_code: lastFailure?.code,
            failure_message: lastFailure?.message,
          },
          scenarioId
        ).catch(() => undefined);

        if (!cancelled) {
          send({ stream: 'exit', data: { runId, code: exitCode, finishedAt } });
        }
        releaseEntityGraphRun(runId);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      cancelEntityGraphRun(runId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
