import { explorerFetch } from '@/lib/explorer-fetch';
import {
  parseAgentReviewRouteResponse,
  type AgentReviewRouteResponse,
  type AgentReviewTaskResult,
} from '@/lib/entity-graph-agent-review';
import type { EntityGraphEntityId, EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';

export interface AgentReviewSampleRequestOptions {
  scenario: EntityGraphScenarioId;
  entity: EntityGraphEntityId;
  limit: number;
  signal?: AbortSignal;
  invalidMessage?: string;
}

export interface AgentReviewSampleSuccess extends AgentReviewRouteResponse {
  result: AgentReviewTaskResult;
}

function buildAgentReviewErrorMessage(
  response: AgentReviewRouteResponse | null,
  status: number
): string {
  return (
    response?.error ?? response?.detail ?? response?.hint ?? `Request failed with status ${status}`
  );
}

export async function requestAgentReviewSample(
  options: AgentReviewSampleRequestOptions
): Promise<AgentReviewSampleSuccess> {
  const {
    scenario,
    entity,
    limit,
    signal,
    invalidMessage = 'Agent review returned an invalid response.',
  } = options;
  const res = await explorerFetch('/api/entity-graph/agent-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario, entity, limit }),
    signal,
  });
  const raw = await res.json().catch(() => null);
  const response = parseAgentReviewRouteResponse(raw);
  if (!res.ok) {
    throw new Error(buildAgentReviewErrorMessage(response, res.status));
  }
  if (!response?.result) {
    throw new Error(invalidMessage);
  }
  return response as AgentReviewSampleSuccess;
}
