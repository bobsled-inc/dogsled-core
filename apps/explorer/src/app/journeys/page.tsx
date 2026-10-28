'use client';

import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { JOURNEYS } from '@/lib/journeys';
import { useJourney } from '@/lib/use-journey';

export default function JourneysPage() {
  const router = useRouter();
  const { startJourney, getProgress } = useJourney();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Journeys"
        description="Follow a guided path through Dogsled Explorer instead of piecing the demo together page by page."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {JOURNEYS.map((journey) => {
          const progress = getProgress(journey.id);
          const ctaLabel = progress.completedCount === 0 ? 'Start Journey' : 'Resume Journey';

          return (
            <div key={journey.id} className="rounded-[28px] border border-border bg-card p-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={progress.isActive ? 'primary' : 'default'}>
                  {journey.estimatedMinutes} min
                </Badge>
                <Badge variant="accent">{journey.steps.length} steps</Badge>
                {progress.isComplete && <Badge variant="success">Complete</Badge>}
              </div>

              <h2 className="mt-4 text-xl font-semibold">{journey.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{journey.description}</p>

              <div className="mt-4 rounded-2xl border border-border bg-secondary/30 p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Progress
                </div>
                <div className="mt-2 text-sm">
                  {progress.completedCount}/{progress.totalSteps} steps complete
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>

              <p className="mt-4 text-sm text-foreground/90">{journey.outcome}</p>

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    startJourney(journey.id, { reset: progress.completedCount === 0 });
                    router.push(`/journeys/${journey.id}`);
                  }}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                >
                  {ctaLabel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    startJourney(journey.id, { reset: true });
                    router.push(`/journeys/${journey.id}`);
                  }}
                  className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  Restart
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
