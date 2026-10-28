'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { getJourneyById } from '@/lib/journeys';
import { useJourney } from '@/lib/use-journey';

export default function JourneyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const journeyId = typeof params.id === 'string' ? params.id : '';
  const journey = getJourneyById(journeyId);
  const {
    startJourney,
    setCurrentStep,
    activeJourney,
    activeStepIndex,
    getProgress,
    markStepComplete,
    state,
  } = useJourney();

  if (!journey) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader
          title="Journey not found"
          description="The requested journey does not exist in this explorer build."
          breadcrumbs={[
            { label: 'Dashboard', href: '/' },
            { label: 'Journeys', href: '/journeys' },
            { label: 'Missing Journey' },
          ]}
        />
        <Link href="/journeys" className="text-sm text-primary hover:underline">
          Back to journeys
        </Link>
      </div>
    );
  }

  const progress = getProgress(journey.id);
  const rawStepIndex = activeJourney?.id === journey.id ? activeStepIndex : progress.currentStep;
  const maxStepIndex = Math.max(journey.steps.length - 1, 0);
  const currentStepIndex = Math.min(Math.max(rawStepIndex, 0), maxStepIndex);
  const currentStep = journey.steps[currentStepIndex];
  const completedSteps = state.journeys[journey.id]?.completedSteps ?? [];

  if (!currentStep) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader
          title={journey.title}
          description="This journey does not currently have any steps configured."
          breadcrumbs={[
            { label: 'Dashboard', href: '/' },
            { label: 'Journeys', href: '/journeys' },
            { label: journey.title },
          ]}
        />
        <Link href="/journeys" className="text-sm text-primary hover:underline">
          Back to journeys
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title={journey.title}
        description={journey.description}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Journeys', href: '/journeys' },
          { label: journey.title },
        ]}
        actions={
          <button
            type="button"
            onClick={() => {
              startJourney(journey.id, { reset: true });
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Reset Journey
          </button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-[28px] border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <Badge variant="primary">{journey.estimatedMinutes} min</Badge>
            <Badge variant="accent">{journey.steps.length} steps</Badge>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{journey.outcome}</p>

          <div className="mt-5 space-y-2">
            {journey.steps.map((step, index) => {
              const isCurrent = index === currentStepIndex;
              const isComplete = completedSteps.includes(index);

              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => {
                    setCurrentStep(index, journey.id);
                  }}
                  className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                    isCurrent
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-secondary/20 hover:bg-secondary/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium">
                      {index + 1}. {step.title}
                    </div>
                    {isComplete && <Badge variant="success">Done</Badge>}
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {step.instruction}
                  </p>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="rounded-[28px] border border-border bg-card p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="primary">
              Step {currentStepIndex + 1} of {journey.steps.length}
            </Badge>
            {currentStep.pipelinePreset && (
              <Badge variant="accent">{currentStep.pipelinePreset} preset</Badge>
            )}
            {currentStep.terminalCmd && <Badge variant="warning">terminal step</Badge>}
          </div>

          <h2 className="mt-4 text-2xl font-semibold">{currentStep.title}</h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
            {currentStep.instruction}
          </p>

          {currentStep.terminalCmd && (
            <div className="mt-5 rounded-2xl border border-border bg-secondary/30 p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Prefilled Command
              </div>
              <code className="mt-2 block overflow-x-auto text-sm text-primary">
                {currentStep.terminalCmd}
              </code>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                startJourney(journey.id);
                router.push(currentStep.page);
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Go to Page
            </button>
            <button
              type="button"
              onClick={() => {
                markStepComplete(currentStepIndex, journey.id);
              }}
              className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              Mark Step Complete
            </button>
            <Link
              href="/journeys"
              className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              Back to All Journeys
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
