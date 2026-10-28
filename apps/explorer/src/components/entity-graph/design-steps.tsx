'use client';

import {
  ENTITY_GRAPH_DESIGN_STEPS,
  type EntityGraphDesignStep,
} from '@/lib/entity-graph-design-flow';

export type DesignStep = EntityGraphDesignStep;
export const DESIGN_STEPS = ENTITY_GRAPH_DESIGN_STEPS;

export interface DesignStepsProps {
  current: DesignStep;
  onChange: (step: DesignStep) => void;
}

export function DesignSteps({ current, onChange }: DesignStepsProps) {
  const activeIndex = DESIGN_STEPS.findIndex((step) => step.id === current);
  const hasActiveStep = activeIndex >= 0;
  const stepNumber = hasActiveStep ? activeIndex + 1 : null;
  const totalSteps = DESIGN_STEPS.length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground" aria-live="polite">
        <span className="sr-only">Design wizard progress: </span>
        {stepNumber !== null ? `Step ${stepNumber} of ${totalSteps}` : `${totalSteps} steps`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {DESIGN_STEPS.map((step, idx) => {
          const isActive = hasActiveStep && step.id === current;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onChange(step.id)}
              aria-current={isActive ? 'step' : undefined}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
                isActive
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              }`}
            >
              <span
                className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                  isActive ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                }`}
              >
                {idx + 1}
              </span>
              <span className="flex items-center gap-1.5">
                <span>{step.label}</span>
                {'optional' in step && step.optional ? (
                  <span className="text-[10px] text-muted-foreground">(optional)</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
