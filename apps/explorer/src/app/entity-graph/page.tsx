import { Suspense } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { HubCard } from '@/components/entity-graph/hub-card';
import { RecentRunsStrip } from '@/components/entity-graph/recent-runs-strip';
import { SavedEntityGraphBanner } from '@/components/entity-graph/saved-entity-graph-banner';
import {
  formatEntityGraphTableName,
  isEntityGraphWorkspaceReady,
  listSpecFiles,
  ENTITY_GRAPH_DEFAULT_RESOLUTION_SPEC,
  readRunLog,
  readEntityGraphSql,
  ENTITY_GRAPH_DEFAULT_ENTITY,
} from '@/lib/entity-graph-workspace';
import { buildRunStatusText, buildResolveStats } from '@/app/entity-graph/runlog-view-model';

export const dynamic = 'force-dynamic';

type HubStats = {
  specs: number;
  clusters: number;
  queue: number;
};

async function safeCount<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function loadHubStats(): Promise<HubStats | null> {
  if (!isEntityGraphWorkspaceReady()) return null;
  const [specs, clusters, queue] = await Promise.all([
    safeCount(async () => (await listSpecFiles()).length, 0),
    safeCount(async () => {
      const rows = await readEntityGraphSql<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${formatEntityGraphTableName(ENTITY_GRAPH_DEFAULT_ENTITY, '__entity_profile')}`
      );
      return rows[0]?.n ?? 0;
    }, 0),
    safeCount(async () => {
      const rows = await readEntityGraphSql<{ n: number }>(
        `WITH latest_decisions AS (
           SELECT pair_id, decision, status
           FROM (
             SELECT
               pair_id,
               decision,
               status,
               ROW_NUMBER() OVER (PARTITION BY pair_id ORDER BY decided_at DESC, applied_at DESC) AS rn
             FROM ${formatEntityGraphTableName(ENTITY_GRAPH_DEFAULT_ENTITY, '__review_decisions')}
           ) ranked
           WHERE rn = 1
         )
         SELECT COUNT(*) AS n
         FROM ${formatEntityGraphTableName(ENTITY_GRAPH_DEFAULT_ENTITY, '__review_queue')} rq
         LEFT JOIN latest_decisions ld ON rq.pair_id = ld.pair_id
         WHERE ld.pair_id IS NULL
           OR ld.decision IN ('defer', 'escalate')
           OR ld.status IN ('proposed', 'deferred', 'escalated')`
      );
      return rows[0]?.n ?? 0;
    }, 0),
  ]);
  return { specs, clusters, queue };
}

export default async function EntityGraphHubPage() {
  const ready = isEntityGraphWorkspaceReady();
  const stats = await loadHubStats();
  let lastRun: Awaited<ReturnType<typeof readRunLog>>[number] | null = null;
  let runLogError = false;
  if (ready) {
    try {
      const runs = await readRunLog(1);
      lastRun = runs[0] ?? null;
    } catch {
      runLogError = true;
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Bobsled Core', href: '/' }, { label: 'Entity Graph' }]}
        title="Entity Graph"
        description="Design entity-resolution specs, run the pipeline, and review match results — all against a local DuckDB workspace."
      />

      {ready && (
        <p className="text-xs text-muted-foreground -mt-6">
          {buildRunStatusText(runLogError, lastRun)}
        </p>
      )}

      <SavedEntityGraphBanner />

      {!ready && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
          Entity Graph demo workspace not found at <code>workspace/entity-graph-demo/</code>. Seed
          it via the{' '}
          <Link href="/terminal" className="underline">
            terminal
          </Link>{' '}
          before continuing.
        </div>
      )}

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer Entity Graph Workflow
        </h2>
        <ol className="mt-4 space-y-3 text-sm">
          <JourneyStep
            index={1}
            title="Design"
            body="Use the Design builder to tune the resolution spec. Pick sources, standardize fields, define blocking keys, and set thresholds — every save writes directly to the workspace YAML."
            href="/entity-graph/design"
            cta="Open the design builder"
          />
          <JourneyStep
            index={2}
            title="Resolve"
            body="Run the pipeline, review queue pairs that need judgment, and inspect the mastered clusters. Workspace health surfaces here when outputs are missing or DuckDB is busy."
            href="/entity-graph/resolve"
            cta="Open the review queue"
          />
          <JourneyStep
            index={3}
            title="Inspect data"
            body="Query specs, seeds, source tables, and mastered outputs against the local DuckDB workspace using the SQL editor."
            href="/entity-graph/data"
            cta="Open the data inspector"
          />
        </ol>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {ready && (
          <>
            <HubCard
              href="/entity-graph/design"
              eyebrow="Design"
              accent="primary"
              title="Design a resolution spec"
              description="Pick sources, standardize fields, define blocking keys, and tune thresholds — the spec writes to YAML."
              stats={[
                { label: 'Specs', value: stats ? String(stats.specs) : '—' },
                { label: 'Entity', value: ENTITY_GRAPH_DEFAULT_ENTITY },
                { label: 'Spec', value: ENTITY_GRAPH_DEFAULT_RESOLUTION_SPEC },
              ]}
            />
            <HubCard
              href="/entity-graph/resolve"
              eyebrow="Resolve"
              accent="emerald"
              title="Review the queue and clusters"
              description={
                !lastRun
                  ? 'Run the pipeline to see clusters and review pairs. Head to the Resolve page and click "Run pipeline".'
                  : 'Inspect pairs that need judgment, explore resolved clusters, and override golden records.'
              }
              stats={buildResolveStats(stats, lastRun)}
            />
          </>
        )}
        {!ready && (
          <div className="rounded-lg border border-dashed border-border bg-card/60 p-5 text-sm text-muted-foreground md:col-span-2">
            The company sandbox is currently unavailable because{' '}
            <code>workspace/entity-graph-demo/</code> is missing. Rebuild a demo workspace to
            continue.
          </div>
        )}
      </section>

      {ready && (
        <>
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Recent runs
              </h2>
              <Link href="/entity-graph/resolve" className="text-xs text-primary hover:underline">
                Run pipeline →
              </Link>
            </div>
            <Suspense fallback={<div className="text-xs text-muted-foreground">Loading runs…</div>}>
              <RecentRunsStrip />
            </Suspense>
          </section>
        </>
      )}
    </div>
  );
}

function JourneyStep({
  index,
  title,
  body,
  href,
  cta,
}: {
  index: number;
  title: string;
  body: string;
  href?: string;
  cta?: string;
}) {
  return (
    <li className="flex gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {index}
      </div>
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-muted-foreground">{body}</div>
        {href ? (
          <Link
            href={href}
            className="mt-1 inline-flex text-xs font-medium text-primary hover:underline"
          >
            {cta ?? 'Open surface'} →
          </Link>
        ) : null}
      </div>
    </li>
  );
}
