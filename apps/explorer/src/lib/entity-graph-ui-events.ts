import type { EntityGraphEntityId } from '@/lib/entity-graph-scenarios';

export const ENTITY_GRAPH_RESOLVE_REFRESH_EVENT = 'entity_graph:resolve-refresh';

export function dispatchEntityGraphResolveRefresh(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(ENTITY_GRAPH_RESOLVE_REFRESH_EVENT));
}

/**
 * Cross-component event that signals one step of a pipeline run has changed
 * state. The DAG panel listens to these to animate nodes in topological order
 * without being directly coupled to the resolve page surface that drives the run.
 *
 * `step` is the same label emitted by `/api/entity-graph/run` (e.g. `resolve:run`,
 * `resolve:cluster`, `resolve:profile`, `survivorship:run`, `seed:load`).
 * `status` mirrors the SSE `step` event: 'start' when the step begins, 'ok'
 * when it completes successfully, 'fail' on error. `entity` lets the DAG only
 * animate the lineage of the entity actually being run — a Location run
 * shouldn't light up the Customer chain.
 */
export const ENTITY_GRAPH_DAG_RUN_STEP_EVENT = 'entity_graph:dag-run-step';

export type EntityGraphDagRunStepStatus = 'start' | 'ok' | 'fail';

export interface EntityGraphDagRunStepPayload {
  entity: EntityGraphEntityId;
  step: string;
  status: EntityGraphDagRunStepStatus;
}

export function dispatchEntityGraphDagRunStep(payload: EntityGraphDagRunStepPayload): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<EntityGraphDagRunStepPayload>(ENTITY_GRAPH_DAG_RUN_STEP_EVENT, {
      detail: payload,
    })
  );
}

/**
 * Sentinel dispatched at the start of a run so listeners can clear any stale
 * "completed" highlights from a previous run before the first step fires.
 */
export const ENTITY_GRAPH_DAG_RUN_RESET_EVENT = 'entity_graph:dag-run-reset';

export interface EntityGraphDagRunResetPayload {
  entity: EntityGraphEntityId;
}

export function dispatchEntityGraphDagRunReset(payload: EntityGraphDagRunResetPayload): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<EntityGraphDagRunResetPayload>(ENTITY_GRAPH_DAG_RUN_RESET_EVENT, {
      detail: payload,
    })
  );
}
