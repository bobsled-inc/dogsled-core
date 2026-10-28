import { getActiveEntityGraphRunId } from './entity-graph-run-manager';
import type { EntityGraphRouteErrorResponse } from './entity-graph-route-errors';
import type { EntityGraphEntityId, EntityGraphScenarioId } from './entity-graph-scenarios';
import {
  getLatestEntityGraphRunEntry,
  getEntityGraphWorkspaceHealth,
  isDuckDbBusyError,
} from './entity-graph-workspace-inventory';

export interface EntityGraphActionableError {
  status: number;
  body: EntityGraphRouteErrorResponse;
}

export async function getEntityGraphWorkspaceActionableError(
  scenario: EntityGraphScenarioId,
  entity: EntityGraphEntityId
): Promise<EntityGraphActionableError | null> {
  let health;
  try {
    health = await getEntityGraphWorkspaceHealth(scenario, entity);
  } catch (error) {
    const busy = getEntityGraphBusyActionableError(error);
    if (busy) {
      return busy;
    }
    if (
      error instanceof Error &&
      /Entity Graph (workspace )?database not found/i.test(error.message)
    ) {
      return {
        status: 409,
        body: {
          error: 'Entity Graph workspace database not found',
          detail: 'Rebuild or reseed the workspace before opening Resolve.',
          code: 'database_missing',
        },
      };
    }
    throw error;
  }

  if (!health.specExists) {
    return {
      status: 404,
      body: {
        error: 'Resolution spec not found',
        detail: 'Open the Design surface for this entity and save the seeded spec again.',
        code: 'spec_missing',
      },
    };
  }

  if (!health.runnerExists) {
    return {
      status: 404,
      body: {
        error: 'Entity Graph workspace runner not found',
        detail: 'Rebuild or reseed the workspace before opening Resolve.',
        code: 'runner_missing',
      },
    };
  }

  if (health.expectedOutputsReady) {
    return null;
  }

  const activeRunId = getActiveEntityGraphRunId();
  if (activeRunId) {
    return {
      status: 409,
      body: {
        error: 'Resolve outputs are still being materialized',
        detail: `Run ${activeRunId} is still updating the workspace. Wait for it to finish, then retry this tab.`,
        code: 'run_in_progress',
      },
    };
  }

  const latestRun = await getLatestEntityGraphRunEntry(entity, scenario);
  const failureDetail =
    latestRun?.status === 'failed'
      ? `The last run failed${latestRun.failure_step ? ` during ${latestRun.failure_step}` : ''}${
          latestRun.failure_message ? `: ${latestRun.failure_message}` : '.'
        }`
      : 'Click "Run pipeline" above to materialize the queue and cluster tables.';

  return {
    status: 409,
    body: {
      error: 'Resolve outputs are not materialized yet',
      detail: `${failureDetail} Retry after the run succeeds.`,
      code: 'outputs_missing',
    },
  };
}

export function getEntityGraphBusyActionableError(
  error: unknown
): EntityGraphActionableError | null {
  if (!isDuckDbBusyError(error)) {
    return null;
  }

  return {
    status: 409,
    body: {
      error: 'The workspace database is busy right now',
      detail:
        'Another run is using DuckDB. Wait for the current pipeline step to finish, then retry this tab.',
      code: 'database_busy',
    },
  };
}
