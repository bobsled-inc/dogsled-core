'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { QueueTable, type QueueRow } from '@/components/entity-graph/queue-table';
import { PairInspector } from '@/components/entity-graph/pair-inspector';
import { ClusterList, type ClusterRow } from '@/components/entity-graph/cluster-list';
import { ClusterDetail } from '@/components/entity-graph/cluster-detail';
import {
  buildEntityGraphHref,
  getEntityGraphEntityDefinition,
  getEntityGraphOverviewHref,
  getEntityGraphScenarioDefinition,
  type EntityGraphBusinessInsightCard,
  type EntityGraphScenarioId,
} from '@/lib/entity-graph-scenarios';
import {
  dispatchEntityGraphDagRunReset,
  dispatchEntityGraphDagRunStep,
  ENTITY_GRAPH_RESOLVE_REFRESH_EVENT,
} from '@/lib/entity-graph-ui-events';
import { formatEntityGraphRouteErrorMessage, parseJsonText } from '@/lib/entity-graph-route-errors';
import type { AgentReviewTaskResult } from '@/lib/entity-graph-agent-review';
import { requestAgentReviewSample } from '@/lib/entity-graph-agent-review-client';
import { AGENT_SAMPLE_LIMIT } from '@/lib/entity-graph-agent-sample';
import { parseClusterDetailPayload } from '@/lib/entity-graph-cluster-detail';
import { isPlainObject } from '@/lib/guards';
import { useEntityGraphAssistantContext } from '@/components/entity-graph/entity-graph-assistant-context';

type Tab = 'queue' | 'clusters';

type QueueResponse = {
  rows: QueueRow[];
  bands?: Array<{ threshold_band: string; n: number }>;
  error?: string;
  detail?: string;
  code?: string;
};

type ClustersResponse = {
  rows: ClusterRow[];
  totals?: { clusters: number; by_trust_tier: Array<{ trust_tier: string; n: number }> };
  error?: string;
  detail?: string;
  code?: string;
};

type InsightsResponse = {
  cards?: EntityGraphBusinessInsightCard[];
  error?: string;
};

type RunEvent =
  | { stream: 'run'; data: { runId: string; steps: number } }
  | {
      stream: 'step';
      data: { index: number; label: string; status: 'start' | 'ok' | 'fail'; code?: number };
    }
  | { stream: 'stdout'; step?: string; data: string }
  | { stream: 'stderr'; step?: string; data: string }
  | { stream: 'error'; step?: string; data: string }
  | { stream: 'exit'; data: { runId: string; code: number } };

function summarizeAgentSample(result: AgentReviewTaskResult): string {
  const summary = result.summary;
  const candidateCount = summary.candidate_count ?? 0;
  const decisionCount = summary.decision_count ?? 0;
  if (candidateCount === 0) return 'No open pairs were available for an agent sample.';

  // Newer runner payloads include a per-decision breakdown
  // (merge / not_match / deferred). When any of those are present, lead with
  // the breakdown so reviewers can see at a glance what's queued. Older
  // results fall back to the candidate/decision-count copy below.
  const mergeCount = summary.merge_count;
  const notMatchCount = summary.not_match_count;
  const deferredCount = summary.deferred_count;
  const hasBreakdown =
    mergeCount !== undefined || notMatchCount !== undefined || deferredCount !== undefined;
  if (hasBreakdown) {
    const proposedParts: string[] = [];
    if ((mergeCount ?? 0) > 0) {
      proposedParts.push(`${mergeCount} merge${mergeCount === 1 ? '' : 's'}`);
    }
    if ((notMatchCount ?? 0) > 0) {
      proposedParts.push(`${notMatchCount} not_match${notMatchCount === 1 ? '' : 'es'}`);
    }
    const proposedClause =
      proposedParts.length > 0 ? ` Proposed ${proposedParts.join(' and ')}` : '';
    const deferredClause = (deferredCount ?? 0) > 0 ? `; deferred ${deferredCount}` : '';
    const reviewedCount = decisionCount || candidateCount;
    return `Agent reviewed ${reviewedCount} pair${reviewedCount === 1 ? '' : 's'}.${proposedClause}${deferredClause} — review queued in Open tab.`;
  }

  const batch = summary.decision_batch_id;
  return `Saved ${decisionCount} sample proposal${decisionCount === 1 ? '' : 's'} for ${candidateCount} open pair${candidateCount === 1 ? '' : 's'}${batch ? ` · ${batch}` : ''}.`;
}

async function readRouteErrorMessage(response: Response): Promise<string> {
  const rawText = await response.text();
  const parsed = parseJsonText(rawText);
  return formatEntityGraphRouteErrorMessage(parsed, `Request failed (${response.status})`);
}

export interface ResolveSurfaceRoutes {
  /** Build the URL for this exact page with updated query params (used by router.replace). */
  buildPath: (params: Record<string, string>) => string;
  /** Static href for the design page in the same context (used by "← Design" link + breadcrumb). */
  designHref: string;
  /** Href for the parent overview page (used by breadcrumb). */
  overviewHref: string;
  /** Href for switching to a different entity within the same scenario. */
  entityHref: (entityId: 'company' | 'customer' | 'location') => string;
  /** Breadcrumb crumbs between "Dogsled" and the current page label ("Resolve"). */
  breadcrumbs?: ReadonlyArray<{ label: string; href?: string }>;
}

export interface ResolvePageInnerProps {
  scenarioId: EntityGraphScenarioId;
  entityId: 'company' | 'customer' | 'location';
  routes?: ResolveSurfaceRoutes;
}

export function ResolvePageInner({ scenarioId, entityId, routes }: ResolvePageInnerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scenarioDefinition = getEntityGraphScenarioDefinition(scenarioId);
  const entityDefinition = getEntityGraphEntityDefinition(entityId);
  const {
    setSelectedPair,
    // Shared with the assistant rail's "Run … agent sample" button so both
    // buttons disable while either run is in flight.
    agentReviewRunning: agentSampleRunning,
    setAgentReviewRunning: setAgentSampleRunning,
  } = useEntityGraphAssistantContext();
  const resolvedRoutes = useMemo<ResolveSurfaceRoutes>(
    () =>
      routes ?? {
        buildPath: (params) =>
          buildEntityGraphHref('/entity-graph/resolve', {
            scenario: scenarioId,
            entity: entityId,
            params,
          }),
        designHref: buildEntityGraphHref('/entity-graph/design', {
          scenario: scenarioId,
          entity: entityId,
        }),
        overviewHref: getEntityGraphOverviewHref(scenarioId, entityId),
        entityHref: (e) =>
          buildEntityGraphHref('/entity-graph/resolve', {
            scenario: scenarioId,
            entity: e,
            params: { tab: 'queue' },
          }),
      },
    [routes, scenarioId, entityId]
  );
  const rawTab = searchParams.get('tab');
  const tab: Tab = rawTab === 'clusters' ? 'clusters' : 'queue';
  const autorun = searchParams.get('autorun');
  const agentSample = searchParams.get('agentSample');
  const selectedPairId = searchParams.get('pair');
  const selectedClusterId = searchParams.get('cluster');

  const [queue, setQueue] = useState<QueueRow[] | null>(null);
  const [queueBands, setQueueBands] = useState<Array<{ threshold_band: string; n: number }>>([]);
  const [clusters, setClusters] = useState<ClusterRow[] | null>(null);
  const [clusterTotals, setClusterTotals] = useState<ClustersResponse['totals'] | null>(null);
  const [insightCards, setInsightCards] = useState<EntityGraphBusinessInsightCard[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'decided' | 'all'>('open');
  // When the queue tab carries a `cluster=<id>` query param (e.g. via the
  // "View pairs in queue →" link from the cluster detail), we filter the
  // displayed queue rows to those whose record_a_id or record_b_id is a
  // member of that cluster. The queue API does not currently support a
  // server-side cluster filter, so we fetch the cluster's member ids from
  // /api/entity-graph/clusters/<id> and intersect on the client.
  const [clusterFilterMemberIds, setClusterFilterMemberIds] = useState<Set<string> | null>(null);
  const [clusterFilterName, setClusterFilterName] = useState<string | null>(null);
  const [clusterFilterLoading, setClusterFilterLoading] = useState(false);
  const [clusterFilterError, setClusterFilterError] = useState<string | null>(null);
  const clusterFilterAbortRef = useRef<AbortController | null>(null);

  const [running, setRunning] = useState(false);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [runExitCode, setRunExitCode] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Tracks whether the user has triggered a pipeline run during *this* browser
  // session. Drives the run-button label ("Run pipeline" first time, "Run
  // again" once we've actually run). We deliberately do NOT seed this from the
  // persisted `.runs.jsonl` log: that file survives across sessions (and is
  // re-created by demo setup scripts), which historically caused fresh page
  // loads on a materialized workspace to read "Run again" before the user had
  // clicked anything. Session-scoped state is what the user actually expects.
  // `null` is the loading state — we fetch the latest run to seed this when
  // the (scenario, entity) flips. Without the loading distinction the button
  // can flash "Run pipeline" before the fetch resolves and then snap to "Run
  // again", which makes the surface feel jumpy.
  const [hasEverRun, setHasEverRun] = useState<boolean | null>(false);
  const [agentSampleError, setAgentSampleError] = useState<string | null>(null);
  const [lastAgentSample, setLastAgentSample] = useState<AgentReviewTaskResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const agentSampleAbortRef = useRef<AbortController | null>(null);
  const runLockRef = useRef(false);
  const agentSampleLockRef = useRef(false);
  const isMountedRef = useRef(true);
  const hasAutorunRef = useRef(false);
  const hasAgentSampleRef = useRef(false);
  const queueRequestRef = useRef(0);
  const clusterRequestRef = useRef(0);
  const insightRequestRef = useRef(0);
  const queueAbortRef = useRef<AbortController | null>(null);
  const clusterAbortRef = useRef<AbortController | null>(null);
  const insightAbortRef = useRef<AbortController | null>(null);
  const currentTabRef = useRef<Tab>(tab);
  // Track whether the queue auto-select effect has already run for the current
  // scope (tab + scenario + entity + statusFilter + cluster filter). It must
  // only fire on the *initial* load for a given scope — not on every refetch.
  // Otherwise a refresh that lands while the user is mid-click (e.g. clicking
  // row 2 during a pipeline run) can clobber their explicit selection because
  // the effect treats their now-decided pair_id as "stale" and overwrites it.
  const queueAutoSelectScopeRef = useRef<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortRef.current?.abort();
      agentSampleAbortRef.current?.abort();
      queueAbortRef.current?.abort();
      clusterAbortRef.current?.abort();
      insightAbortRef.current?.abort();
      clusterFilterAbortRef.current?.abort();
    };
  }, []);

  // The autorun + agent-sample guards are one-shot per (scenario, entity)
  // context, not per component instance — clear them when the route context
  // flips so a follow-on `?autorun=1` link can still trigger.
  useEffect(() => {
    hasAutorunRef.current = false;
    hasAgentSampleRef.current = false;
  }, [entityId, scenarioId]);

  // Reset the session-scoped run flag when the user switches scenario/entity:
  // each (scenario, entity) pair is its own demo context with its own button
  // label. Without this reset, switching from Customer (which the user has
  // run) to Location (which they haven't) would still show "Run again".
  useEffect(() => {
    let cancelled = false;
    setHasEverRun(null);
    explorerFetch(
      `/api/entity-graph/runs?scenario=${encodeURIComponent(scenarioId)}&entity=${encodeURIComponent(entityId)}&limit=1`
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((payload: { runs?: unknown[] }) => {
        if (cancelled) return;
        setHasEverRun(Array.isArray(payload.runs) && payload.runs.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasEverRun(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, scenarioId]);

  useEffect(() => {
    currentTabRef.current = tab;
  }, [tab]);

  const loadQueue = useCallback(() => {
    const requestId = ++queueRequestRef.current;
    queueAbortRef.current?.abort();
    const controller = new AbortController();
    queueAbortRef.current = controller;
    setQueue(null);
    setQueueBands([]);
    setQueueError(null);
    explorerFetch(
      `/api/entity-graph/queue?scenario=${encodeURIComponent(scenarioId)}&entity=${encodeURIComponent(entityId)}&status=${statusFilter}`,
      { signal: controller.signal }
    )
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(await readRouteErrorMessage(r));
        }
        return r.json();
      })
      .then((j: QueueResponse) => {
        if (!isMountedRef.current || requestId !== queueRequestRef.current) {
          return;
        }
        if (j.error) {
          setQueueError(formatEntityGraphRouteErrorMessage(j, j.error));
        } else {
          setQueue(j.rows ?? []);
          setQueueBands(j.bands ?? []);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (isMountedRef.current && requestId === queueRequestRef.current) {
          setQueueError(String(e));
        }
      });
  }, [entityId, scenarioId, statusFilter]);

  const loadClusters = useCallback(() => {
    const requestId = ++clusterRequestRef.current;
    clusterAbortRef.current?.abort();
    const controller = new AbortController();
    clusterAbortRef.current = controller;
    setClusters(null);
    setClusterTotals(null);
    setClusterError(null);
    explorerFetch(
      `/api/entity-graph/clusters?scenario=${encodeURIComponent(scenarioId)}&entity=${encodeURIComponent(entityId)}`,
      { signal: controller.signal }
    )
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(await readRouteErrorMessage(r));
        }
        return r.json();
      })
      .then((j: ClustersResponse) => {
        if (!isMountedRef.current || requestId !== clusterRequestRef.current) {
          return;
        }
        if (j.error) {
          setClusterError(formatEntityGraphRouteErrorMessage(j, j.error));
        } else {
          setClusters(j.rows ?? []);
          setClusterTotals(j.totals ?? null);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (isMountedRef.current && requestId === clusterRequestRef.current) {
          setClusterError(String(e));
        }
      });
  }, [entityId, scenarioId]);

  const loadInsights = useCallback(() => {
    const requestId = ++insightRequestRef.current;
    insightAbortRef.current?.abort();
    const controller = new AbortController();
    insightAbortRef.current = controller;
    explorerFetch(
      `/api/entity-graph/insights?scenario=${encodeURIComponent(scenarioId)}&entity=${encodeURIComponent(entityId)}`,
      { signal: controller.signal }
    )
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(await readRouteErrorMessage(r));
        }
        return r.json();
      })
      .then((payload: InsightsResponse) => {
        if (!isMountedRef.current || requestId !== insightRequestRef.current) return;
        setInsightCards(payload.cards ?? []);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (isMountedRef.current && requestId === insightRequestRef.current) {
          setInsightCards([]);
        }
      });
  }, [entityId, scenarioId]);

  useEffect(() => {
    if (tab === 'queue') loadQueue();
  }, [tab, loadQueue]);

  useEffect(() => {
    if (tab === 'clusters') loadClusters();
  }, [tab, loadClusters]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  // Fetch the cluster's member ids whenever the queue tab is active and a
  // `cluster=<id>` filter is set. We hit /api/entity-graph/clusters/<id> (the same
  // endpoint the cluster detail uses) and stash the record_id set + display
  // name so the queue can be filtered client-side and the banner has a
  // friendly label. When the filter is cleared or we leave the queue tab,
  // reset the state so a re-entry refetches cleanly.
  useEffect(() => {
    if (tab !== 'queue' || !selectedClusterId) {
      clusterFilterAbortRef.current?.abort();
      clusterFilterAbortRef.current = null;
      setClusterFilterMemberIds(null);
      setClusterFilterName(null);
      setClusterFilterError(null);
      setClusterFilterLoading(false);
      return;
    }
    clusterFilterAbortRef.current?.abort();
    const controller = new AbortController();
    clusterFilterAbortRef.current = controller;
    // Drop the previous cluster's member set before the new lookup lands so
    // `displayedQueue` returns its loading sentinel (null) instead of
    // filtering with a stale cluster while the next response is in flight.
    setClusterFilterMemberIds(null);
    setClusterFilterName(null);
    setClusterFilterLoading(true);
    setClusterFilterError(null);
    explorerFetch(
      `/api/entity-graph/clusters/${encodeURIComponent(selectedClusterId)}?scenario=${encodeURIComponent(scenarioId)}&entity=${encodeURIComponent(entityId)}`,
      { signal: controller.signal }
    )
      .then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!isMountedRef.current || clusterFilterAbortRef.current !== controller) return;
        const apiError = isPlainObject(json) && typeof json.error === 'string' ? json.error : null;
        if (!r.ok || apiError) {
          setClusterFilterError(apiError ?? `HTTP ${r.status}`);
          setClusterFilterMemberIds(null);
          setClusterFilterName(null);
          return;
        }
        try {
          const parsed = parseClusterDetailPayload(json);
          setClusterFilterMemberIds(new Set(parsed.members.map((m) => m.record_id)));
          setClusterFilterName(parsed.profile.display_name);
        } catch (err) {
          setClusterFilterError(
            err instanceof Error ? err.message : 'Invalid cluster detail response'
          );
          setClusterFilterMemberIds(null);
          setClusterFilterName(null);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (!isMountedRef.current || clusterFilterAbortRef.current !== controller) return;
        setClusterFilterError(String(e));
        setClusterFilterMemberIds(null);
        setClusterFilterName(null);
      })
      .finally(() => {
        if (!isMountedRef.current || clusterFilterAbortRef.current !== controller) return;
        setClusterFilterLoading(false);
      });
  }, [entityId, scenarioId, selectedClusterId, tab]);

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      router.replace(resolvedRoutes.buildPath(Object.fromEntries(next.entries())), {
        scroll: false,
      });
    },
    [resolvedRoutes, router, searchParams]
  );

  // Apply the cluster=<id> client-side filter when one is active on the
  // queue tab. A pair belongs to a cluster if either side of the pair is one
  // of the cluster's member record_ids. While the member ids are still
  // loading we return null (loading state) so the UI doesn't flash the full
  // unfiltered queue and the auto-select effect doesn't latch onto an
  // unrelated row. If the filter request errored we return [] so the empty
  // state explains the situation rather than showing unrelated pairs.
  const displayedQueue = useMemo(() => {
    if (queue === null) return null;
    if (tab !== 'queue' || !selectedClusterId) return queue;
    if (!clusterFilterMemberIds) return clusterFilterError ? [] : null;
    return queue.filter(
      (row) =>
        clusterFilterMemberIds.has(row.record_a_id) || clusterFilterMemberIds.has(row.record_b_id)
    );
  }, [queue, tab, selectedClusterId, clusterFilterMemberIds, clusterFilterError]);

  // Auto-select the sole queue row when the queue narrows to one, AND clear
  // stale `pair` URL params that don't exist in the current queue (filter
  // changes or deep-link with a dead pair leave dead params otherwise).
  //
  // We only do this on the *initial* load for a given scope (tab + scenario +
  // entity + statusFilter + cluster filter). Re-firing on every refetch races
  // user interaction: if the user clicks row 2 during a pipeline run, the
  // post-run refetch may decide their pair away — without the scope guard
  // we'd then overwrite their explicit `?pair=` with a different row (or
  // null), which feels like the click un-clicked itself.
  useEffect(() => {
    if (tab !== 'queue' || !displayedQueue) return;
    const scopeKey = `${tab}|${scenarioId}|${entityId}|${statusFilter}|${selectedClusterId ?? ''}`;
    if (queueAutoSelectScopeRef.current === scopeKey) return;
    queueAutoSelectScopeRef.current = scopeKey;

    const stale =
      selectedPairId !== null && !displayedQueue.some((row) => row.pair_id === selectedPairId);
    if (stale) {
      // Drop the dead param. If exactly one row remains, auto-select it instead.
      const replacement = displayedQueue.length === 1 ? (displayedQueue[0]?.pair_id ?? null) : null;
      updateParams({ pair: replacement });
      return;
    }
    if (selectedPairId === null && displayedQueue.length === 1) {
      const firstId = displayedQueue[0]?.pair_id;
      if (firstId) updateParams({ pair: firstId });
    }
  }, [
    displayedQueue,
    entityId,
    scenarioId,
    selectedClusterId,
    selectedPairId,
    statusFilter,
    tab,
    updateParams,
  ]);

  const selectedRow = useMemo(
    () => displayedQueue?.find((r) => r.pair_id === selectedPairId) ?? null,
    [displayedQueue, selectedPairId]
  );

  // Publish the selected pair to the assistant rail so it can render
  // pair-aware click-to-fill prompts and the API can inject the pair into
  // Claude's system prompt. We only surface this on the queue tab — clusters
  // tab selections aren't pairs.
  useEffect(() => {
    if (tab !== 'queue' || !selectedRow) {
      setSelectedPair(null);
      return;
    }
    setSelectedPair({
      pairId: selectedRow.pair_id,
      compositeScore: selectedRow.composite_score,
      thresholdBand: selectedRow.threshold_band,
      sourceA: selectedRow.source_a ?? null,
      sourceB: selectedRow.source_b ?? null,
      recordALabel: selectedRow.a_display_label ?? selectedRow.record_a_id,
      recordBLabel: selectedRow.b_display_label ?? selectedRow.record_b_id,
      blockingRules: selectedRow.blocking_rules,
      fields: selectedRow.compare_fields.map((f) => ({
        key: f.key,
        label: f.label,
        a: f.a,
        b: f.b,
      })),
      featureContributions: selectedRow.feature_contributions.map((f) => ({
        key: f.key,
        label: f.label,
        score: f.score,
        a: f.a,
        b: f.b,
      })),
    });
  }, [selectedRow, setSelectedPair, tab]);

  // Clear the selected pair from the assistant context on unmount so a stale
  // pair from a previous render doesn't leak into the next surface.
  useEffect(() => {
    return () => {
      setSelectedPair(null);
    };
  }, [setSelectedPair]);

  const runAgentSample = useCallback(async () => {
    if (agentSampleLockRef.current) return false;
    agentSampleLockRef.current = true;
    agentSampleAbortRef.current?.abort();
    const controller = new AbortController();
    agentSampleAbortRef.current = controller;
    setAgentSampleRunning(true);
    setAgentSampleError(null);
    setLastAgentSample(null);

    try {
      const response = await requestAgentReviewSample({
        scenario: scenarioId,
        entity: entityId,
        limit: AGENT_SAMPLE_LIMIT,
        signal: controller.signal,
        invalidMessage: 'Agent sample returned an invalid response.',
      });
      if (!isMountedRef.current) return false;
      setLastAgentSample(response.result);
      loadQueue();
      return true;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError') && isMountedRef.current) {
        setAgentSampleError(err instanceof Error ? err.message : String(err));
      }
      return false;
    } finally {
      agentSampleLockRef.current = false;
      if (agentSampleAbortRef.current === controller) {
        agentSampleAbortRef.current = null;
      }
      if (isMountedRef.current) {
        setAgentSampleRunning(false);
      }
    }
  }, [entityId, loadQueue, scenarioId, setAgentSampleRunning]);

  const runPipeline = useCallback(
    async (options?: { sampleAfterSuccess?: boolean }) => {
      if (runLockRef.current) return false;
      runLockRef.current = true;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setRunEvents([]);
      setRunExitCode(null);
      setRunError(null);
      // Clear any stale "completed" highlights left over from a previous run
      // BEFORE the first step event arrives — otherwise the DAG flashes the
      // old chain green for a frame between clicks.
      dispatchEntityGraphDagRunReset({ entity: entityId });

      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let finalExitCode: number | null = null;
      try {
        const res = await explorerFetch('/api/entity-graph/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: scenarioId, entity: entityId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(await readRouteErrorMessage(res));
        }
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!isMountedRef.current) break;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split('\n\n');
            buf = frames.pop() ?? '';
            for (const frame of frames) {
              if (!frame.startsWith('data: ')) continue;
              try {
                const parsed = JSON.parse(frame.slice(6)) as RunEvent;
                if (!isMountedRef.current) continue;
                setRunEvents((prev) => {
                  const next = [...prev, parsed];
                  return next.length > 500 ? next.slice(-500) : next;
                });
                if (parsed.stream === 'step') {
                  // Forward each step transition to any DAG panels mounted on
                  // the page so they can animate the corresponding nodes. We
                  // tag the event with the entity that triggered the run so a
                  // multi-entity DAG only highlights the relevant chain.
                  dispatchEntityGraphDagRunStep({
                    entity: entityId,
                    step: parsed.data.label,
                    status: parsed.data.status,
                  });
                }
                if (parsed.stream === 'exit' && isMountedRef.current) {
                  finalExitCode = parsed.data.code;
                  setRunExitCode(parsed.data.code);
                }
              } catch {
                // skip malformed frame
              }
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // reader may already be released if the stream errored
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError' && isMountedRef.current) {
          setRunError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        runLockRef.current = false;
        // If the run never reached an `exit` event we have no terminal
        // 'fail'/'ok' step status — which means any node that was in a
        // 'start' state on the DAG would pulse forever. This catches
        // abort-on-unmount (user navigates away mid-run), abort-on-rerun, and
        // network/transport failures. A clean run (success or non-zero exit)
        // already cleared the running set via the per-step events, so we
        // only reset on the truly indeterminate path.
        if (finalExitCode === null) {
          dispatchEntityGraphDagRunReset({ entity: entityId });
        }
        if (isMountedRef.current) {
          setRunning(false);
          loadInsights();
          if (currentTabRef.current === 'queue') loadQueue();
          else loadClusters();
        }
      }
      // Any completed run (success OR failure) flips the button label to "Run
      // again" for the rest of this session — the run is now visible in
      // /api/entity-graph/runs. Limiting this to success-only would keep the
      // CTA stuck on "Run pipeline" even after a real attempt that logged a
      // failed run; the user has clearly already "run something".
      if (finalExitCode !== null && isMountedRef.current) {
        setHasEverRun(true);
      }
      const succeeded = finalExitCode === 0;
      if (succeeded && options?.sampleAfterSuccess) {
        await runAgentSample();
      }
      return succeeded;
    },
    [entityId, loadClusters, loadInsights, loadQueue, runAgentSample, scenarioId]
  );

  useEffect(() => {
    if (autorun !== '1' || hasAutorunRef.current || running) return;
    hasAutorunRef.current = true;
    const sampleAfterSuccess = agentSample === '1' && !hasAgentSampleRef.current;
    if (sampleAfterSuccess) {
      hasAgentSampleRef.current = true;
    }
    updateParams({ autorun: null, agentSample: null });
    void runPipeline({ sampleAfterSuccess });
  }, [agentSample, autorun, runPipeline, running, updateParams]);

  useEffect(() => {
    const refresh = () => {
      loadInsights();
      if (tab === 'queue') {
        loadQueue();
        return;
      }

      loadClusters();
    };

    window.addEventListener(ENTITY_GRAPH_RESOLVE_REFRESH_EVENT, refresh);
    return () => {
      window.removeEventListener(ENTITY_GRAPH_RESOLVE_REFRESH_EVENT, refresh);
    };
  }, [loadClusters, loadInsights, loadQueue, tab]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          ...(resolvedRoutes.breadcrumbs ?? [
            { label: 'Entity Graph', href: resolvedRoutes.overviewHref },
          ]),
          { label: 'Resolve' },
        ]}
        title={`${entityDefinition.label} · Resolve`}
        description={`Spec · ${entityDefinition.defaultResolutionSpec} · DuckDB · schema ${scenarioDefinition.schema}`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={resolvedRoutes.designHref}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Design
            </Link>
            {scenarioDefinition.supportedEntities.length > 1 && (
              <div className="mr-2 flex items-center gap-1 rounded-full border border-border bg-background/70 p-1">
                {scenarioDefinition.supportedEntities.map((supportedEntityId) => {
                  const supportedEntity = getEntityGraphEntityDefinition(supportedEntityId);
                  const active = supportedEntityId === entityId;
                  return (
                    <button
                      key={supportedEntityId}
                      type="button"
                      onClick={() => router.replace(resolvedRoutes.entityHref(supportedEntityId))}
                      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {supportedEntity.label}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              disabled={running}
              onClick={() => void runPipeline()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {running ? 'Running…' : hasEverRun ? 'Run again' : 'Run pipeline'}
            </button>
            <button
              type="button"
              disabled={running || agentSampleRunning}
              onClick={() => void runAgentSample()}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-60"
            >
              {agentSampleRunning ? 'Sampling…' : `Run ${AGENT_SAMPLE_LIMIT}-pair agent sample`}
            </button>
          </div>
        }
      />

      {insightCards.length > 0 && (
        <section className="grid gap-2 md:grid-cols-4">
          {insightCards.map((card) => (
            <div key={card.label} className="rounded-md border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {card.label}
              </div>
              <div className="mt-1 text-sm font-semibold">{card.value}</div>
              {card.context && (
                <div className="mt-1 text-xs text-muted-foreground">{card.context}</div>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="flex items-center gap-2">
        <TabButton
          active={tab === 'queue'}
          label="Queue"
          count={displayedQueue?.length}
          onClick={() => updateParams({ tab: 'queue', cluster: null })}
        />
        <TabButton
          active={tab === 'clusters'}
          label="Clusters"
          count={clusters?.length}
          onClick={() => updateParams({ tab: 'clusters', pair: null })}
        />
      </div>

      {(runEvents.length > 0 || runError) && (
        <RunConsole events={runEvents} running={running} exitCode={runExitCode} error={runError} />
      )}

      {(lastAgentSample || agentSampleError || agentSampleRunning) && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            agentSampleError
              ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300'
              : 'border-amber-500/30 bg-amber-500/10 text-foreground'
          }`}
        >
          <div className="font-medium">
            {agentSampleRunning
              ? 'Running sample agent review…'
              : agentSampleError
                ? 'Agent sample unavailable'
                : 'Sample agent review proposals saved'}
          </div>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {agentSampleError ??
              (lastAgentSample ? summarizeAgentSample(lastAgentSample) : 'Preparing sample…')}
          </p>
        </div>
      )}

      {tab === 'queue' && (
        <section className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <div className="min-w-0 space-y-3">
            {selectedClusterId && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <span className="font-medium">Filtered to pairs in cluster </span>
                  <span className="truncate font-semibold">
                    {clusterFilterLoading
                      ? 'loading…'
                      : clusterFilterError
                        ? selectedClusterId
                        : (clusterFilterName ?? selectedClusterId)}
                  </span>
                  {clusterFilterError && (
                    <span className="ml-2 text-muted-foreground">({clusterFilterError})</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => updateParams({ cluster: null, pair: null })}
                  aria-label="Clear cluster filter"
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-amber-500/20 hover:text-foreground"
                >
                  ×
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Status</span>
                {(['open', 'decided', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatusFilter(s)}
                    className={`rounded-full px-2 py-0.5 transition-colors ${
                      statusFilter === s
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 text-[11px]">
                {queueBands.map((b) => (
                  <span key={b.threshold_band} className="text-muted-foreground">
                    {b.threshold_band}: <span className="text-foreground">{b.n}</span>
                  </span>
                ))}
              </div>
            </div>
            {queueError ? (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">
                {queueError}
              </div>
            ) : displayedQueue === null ? (
              <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
                Loading queue…
              </div>
            ) : clusterFilterError && selectedClusterId ? (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">
                Couldn't load the cluster filter: {clusterFilterError}. Clear the filter to see the
                full queue.
              </div>
            ) : displayedQueue.length === 0 && selectedClusterId ? (
              <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
                No pairs in the queue reference this cluster's members. Clear the filter to see the
                full queue.
              </div>
            ) : (
              <QueueTable
                rows={displayedQueue}
                selectedPairId={selectedPairId}
                onSelect={(id) => updateParams({ pair: id })}
                statusFilter={statusFilter}
                clustersHref={`?${new URLSearchParams({ tab: 'clusters' }).toString()}`}
              />
            )}
          </div>
          <div className="min-w-0 overflow-hidden lg:min-h-[420px]">
            {!selectedRow && displayedQueue && displayedQueue.length > 0 && (
              <p className="mb-2 text-[11px] text-muted-foreground">
                Click a row to inspect the pair and record a decision.
              </p>
            )}
            <PairInspector
              key={selectedRow?.pair_id ?? 'empty'}
              row={selectedRow}
              scenario={scenarioId}
              entity={entityId}
              onDecided={loadQueue}
            />
          </div>
        </section>
      )}

      {tab === 'clusters' && (
        <section className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <div className="space-y-3">
            {clusterTotals && (
              <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                <span>
                  Clusters: <span className="text-foreground">{clusterTotals.clusters}</span>
                </span>
                {clusterTotals.by_trust_tier.map((b) => (
                  <span key={b.trust_tier}>
                    {b.trust_tier}: <span className="text-foreground">{b.n}</span>
                  </span>
                ))}
              </div>
            )}
            {clusterError ? (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">
                {clusterError}
              </div>
            ) : clusters === null ? (
              <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
                Loading clusters…
              </div>
            ) : (
              <ClusterList
                rows={clusters}
                selectedId={selectedClusterId}
                onSelect={(id) => updateParams({ cluster: id })}
              />
            )}
          </div>
          <div className="lg:min-h-[420px]">
            <ClusterDetail clusterId={selectedClusterId} scenario={scenarioId} entity={entityId} />
          </div>
        </section>
      )}
    </div>
  );
}

function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
      }`}
    >
      <span className="font-medium">{label}</span>
      {typeof count === 'number' && (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            active ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function RunConsole({
  events,
  running,
  exitCode,
  error,
}: {
  events: RunEvent[];
  running: boolean;
  exitCode: number | null;
  error: string | null;
}) {
  const steps = events.filter((e) => e.stream === 'step') as Array<
    Extract<RunEvent, { stream: 'step' }>
  >;
  // Derive both order and status from the streamed step events so the chips
  // reflect what the backend actually emitted (rather than a stale hardcoded list).
  const stepStatus = new Map<string, 'start' | 'ok' | 'fail'>();
  const stepOrder: string[] = [];
  for (const ev of steps) {
    if (!stepStatus.has(ev.data.label)) stepOrder.push(ev.data.label);
    stepStatus.set(ev.data.label, ev.data.status);
  }

  const latestLines = events
    .filter((e) => e.stream === 'stdout' || e.stream === 'stderr' || e.stream === 'error')
    .slice(-8) as Array<Extract<RunEvent, { stream: 'stdout' | 'stderr' | 'error' }>>;

  return (
    <div className="rounded-md border border-border bg-card p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="font-medium">
          {running
            ? 'Running pipeline…'
            : exitCode === 0
              ? 'Pipeline finished'
              : exitCode !== null
                ? `Pipeline exited with code ${exitCode}`
                : error
                  ? 'Pipeline error'
                  : 'Pipeline idle'}
        </div>
        <div className="flex flex-wrap gap-2">
          {stepOrder.map((label) => {
            const status = stepStatus.get(label);
            const klass =
              status === 'ok'
                ? 'bg-emerald-500/15 text-emerald-500'
                : status === 'fail'
                  ? 'bg-red-500/15 text-red-500'
                  : status === 'start'
                    ? 'bg-amber-500/15 text-amber-500'
                    : 'bg-secondary text-muted-foreground';
            return (
              <span key={label} className={`rounded-full px-2 py-0.5 text-[10px] ${klass}`}>
                {label}
              </span>
            );
          })}
        </div>
      </div>
      {error && <div className="mt-2 text-red-500">{error}</div>}
      {latestLines.length > 0 && (
        <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/40 p-2 font-mono text-[10px] text-muted-foreground">
          {latestLines.map((l) => `[${l.step ?? ''}] ${l.data}`).join('\n')}
        </pre>
      )}
    </div>
  );
}
