'use client';

import Link from 'next/link';
import { useJourney } from '@/lib/use-journey';

export function JourneyBanner() {
  const { activeJourney, activeStep, activeStepIndex, markStepComplete, advanceStep } =
    useJourney();

  if (!activeJourney || !activeStep) return null;

  return (
    <div className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Active Journey
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{activeJourney.title}</span>
            <span className="text-xs text-muted-foreground">
              Step {activeStepIndex + 1} of {activeJourney.steps.length}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{activeStep.instruction}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              markStepComplete();
              advanceStep();
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/85"
          >
            Mark Step Complete
          </button>
          <Link
            href={`/journeys/${activeJourney.id}`}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Back to Journey
          </Link>
        </div>
      </div>
    </div>
  );
}
