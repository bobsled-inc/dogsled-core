'use client';

import { useEffect, useState } from 'react';
import { type EntityGraphEntityId, type EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';
import { formatRelative } from '@/lib/format-relative';

type Run = {
  run_id: string;
  scenario?: string;
  entity: string;
  status: 'success' | 'failed';
  started_at: string;
  finished_at: string;
};

interface RunsResponse {
  runs?: unknown;
  error?: unknown;
}

function isRun(value: unknown): value is Run {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<Run>;
  return (
    typeof run.run_id === 'string' &&
    typeof run.entity === 'string' &&
    (run.status === 'success' || run.status === 'failed') &&
    typeof run.started_at === 'string' &&
    typeof run.finished_at === 'string'
  );
}

export function RecentRunsStrip() {
  return <RecentRunsStripInner scenario="default" />;
}

export function RecentRunsStripInner({
  scenario,
  entity,
}: {
  scenario: EntityGraphScenarioId;
  entity?: EntityGraphEntityId;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setError(null);
    const params = new URLSearchParams({ limit: '5', scenario });
    if (entity) {
      params.set('entity', entity);
    }
    fetch(`/api/entity-graph/runs?${params.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(body || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((j: unknown) => {
        if (cancelled) return;
        const payload = (j ?? {}) as RunsResponse;
        if (typeof payload.error === 'string') {
          setError(payload.error);
          return;
        }
        const safeRuns = Array.isArray(payload.runs) ? payload.runs.filter(isRun) : [];
        setRuns(safeRuns);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [scenario, entity]);

  if (error) {
    return (
      <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        Run history unavailable: {error}
      </div>
    );
  }

  if (runs === null) {
    return (
      <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        Loading runs…
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-4 text-xs text-muted-foreground">
        No runs yet — head to Resolve and click “Run pipeline” to execute it.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {runs.map((run) => (
        <div key={run.run_id} className="rounded-md border border-border bg-card p-3 text-xs">
          <div className="flex items-center justify-between">
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                run.status === 'success'
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : 'bg-red-500/15 text-red-500'
              }`}
            >
              {run.status}
            </span>
            <span className="text-muted-foreground">{formatRelative(run.finished_at)}</span>
          </div>
          <div className="mt-2 font-medium">{run.entity}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground truncate">{run.run_id}</div>
        </div>
      ))}
    </div>
  );
}
