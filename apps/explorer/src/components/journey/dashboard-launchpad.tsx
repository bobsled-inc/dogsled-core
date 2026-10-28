'use client';

import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { FEATURED_JOURNEY_ID, JOURNEYS } from '@/lib/journeys';
import { useJourney } from '@/lib/use-journey';

function JourneyActionButton({
  journeyId,
  reset,
  label,
  className,
}: {
  journeyId: string;
  reset: boolean;
  label: string;
  className: string;
}) {
  const router = useRouter();
  const { startJourney } = useJourney();

  return (
    <button
      type="button"
      onClick={() => {
        startJourney(journeyId, { reset });
        router.push(`/journeys/${journeyId}`);
      }}
      className={className}
    >
      {label}
    </button>
  );
}

export function DashboardLaunchpad() {
  const { state, getProgress } = useJourney();
  const featuredJourney = JOURNEYS.find((journey) => journey.id === FEATURED_JOURNEY_ID);

  if (!featuredJourney) return null;

  const otherJourneys = JOURNEYS.filter((journey) => journey.id !== featuredJourney.id);
  const activeJourney = state.activeJourneyId
    ? (JOURNEYS.find((journey) => journey.id === state.activeJourneyId) ?? null)
    : null;
  const activeProgress = activeJourney ? getProgress(activeJourney.id) : null;
  const showContinue = activeJourney && activeProgress && !activeProgress.isComplete;

  return (
    <section className="space-y-4">
      {showContinue && activeJourney && activeProgress && (
        <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-primary">
                Continue where you left off
              </div>
              <div className="mt-1 text-lg font-semibold">{activeJourney.title}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Step {activeProgress.currentStep + 1} of {activeProgress.totalSteps}
              </p>
            </div>
            <JourneyActionButton
              journeyId={activeJourney.id}
              reset={false}
              label="Resume Journey"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            />
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <div className="overflow-hidden rounded-[28px] border border-border bg-[linear-gradient(135deg,rgba(99,102,241,0.18),rgba(59,130,246,0.08),var(--background))] p-6">
          <div className="max-w-2xl">
            <div className="text-[10px] uppercase tracking-[0.2em] text-primary">Start Here</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">{featuredJourney.title}</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {featuredJourney.description}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge variant="primary">{featuredJourney.estimatedMinutes} min</Badge>
              <Badge variant="accent">{featuredJourney.steps.length} steps</Badge>
            </div>
            <p className="mt-5 text-sm text-foreground/90">{featuredJourney.outcome}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <JourneyActionButton
                journeyId={featuredJourney.id}
                reset={true}
                label="Start Journey"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
              />
              <JourneyActionButton
                journeyId={featuredJourney.id}
                reset={false}
                label="Continue"
                className="rounded-md border border-border bg-card/60 px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              />
            </div>
          </div>
        </div>

        <div className="rounded-[28px] border border-border bg-card p-6">
          <div className="text-sm font-semibold">What you’ll build</div>
          <div className="mt-4 space-y-3">
            {featuredJourney.steps.map((step, index) => (
              <div key={step.title} className="rounded-xl border border-border bg-secondary/35 p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Step {index + 1}
                </div>
                <div className="mt-1 text-sm font-medium">{step.title}</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.instruction}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {otherJourneys.map((journey) => {
          const progress = getProgress(journey.id);
          const ctaLabel = progress.isActive
            ? 'Resume'
            : progress.completedCount > 0
              ? 'Continue'
              : 'Start';
          return (
            <div key={journey.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{journey.title}</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {journey.description}
                  </p>
                </div>
                <Badge variant={progress.isActive ? 'primary' : 'default'}>
                  {journey.estimatedMinutes} min
                </Badge>
              </div>
              <div className="mt-4 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>
                  {progress.completedCount}/{journey.steps.length} complete
                </span>
                {progress.isComplete && <Badge variant="success">Done</Badge>}
              </div>
              <JourneyActionButton
                journeyId={journey.id}
                reset={progress.completedCount === 0}
                label={ctaLabel}
                className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
