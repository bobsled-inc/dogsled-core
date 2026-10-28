import { NextResponse } from 'next/server';
import { isEntityGraphWorkspaceReady } from '@/lib/entity-graph-workspace';
import { getEntityGraphWorkspaceInventory } from '@/lib/entity-graph-workspace-inventory';
import { getEntityGraphBusyActionableError } from '@/lib/entity-graph-workspace-state';
import { isEntityGraphScenarioId, type EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';
import { logServerError } from '@/lib/server-logging';

export const dynamic = 'force-dynamic';

const INVENTORY_BUSY_RETRY_DELAYS_MS = [80, 160, 320] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadWorkspaceInventoryWithRetry(scenario: EntityGraphScenarioId) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= INVENTORY_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await getEntityGraphWorkspaceInventory(scenario);
    } catch (error) {
      const busyError = getEntityGraphBusyActionableError(error);
      if (!busyError) {
        throw error;
      }

      lastError = error;
      const delay = INVENTORY_BUSY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        break;
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawScenario = url.searchParams.get('scenario');

  let scenario: EntityGraphScenarioId;
  if (rawScenario === null) {
    scenario = 'default';
  } else if (isEntityGraphScenarioId(rawScenario)) {
    scenario = rawScenario;
  } else {
    return NextResponse.json(
      { error: `Unsupported scenario: ${rawScenario || '(empty)'}`, code: 'invalid_request' },
      { status: 400 }
    );
  }

  if (!isEntityGraphWorkspaceReady(scenario)) {
    return NextResponse.json(
      {
        error: 'Entity Graph workspace not found',
        detail: 'Seed or rebuild the workspace before opening Demo Data.',
        code: 'workspace_missing',
      },
      { status: 404 }
    );
  }

  try {
    const inventory = await loadWorkspaceInventoryWithRetry(scenario);
    return NextResponse.json(inventory);
  } catch (error) {
    const busyError = getEntityGraphBusyActionableError(error);
    if (busyError) {
      return NextResponse.json(busyError.body, { status: busyError.status });
    }

    logServerError('apps/explorer/api/entity-graph-workspace:get', error, { scenario });
    return NextResponse.json(
      {
        error: 'Failed to load workspace inventory',
        detail: 'Retry once. If it keeps failing, inspect the workspace database and runner.',
        code: 'workspace_inventory_failed',
      },
      { status: 500 }
    );
  }
}
