interface StepIndicatorItem {
  key: string;
  label: string;
}

interface StepIndicatorProps {
  steps: readonly StepIndicatorItem[];
  currentIndex: number;
  onStepClick?: (index: number) => void;
  allowSkipAhead?: boolean;
}

export function StepIndicator({
  steps,
  currentIndex,
  onStepClick,
  allowSkipAhead = false,
}: StepIndicatorProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {steps.map((step, index) => {
        const isCurrent = index === currentIndex;
        const isComplete = index < currentIndex;
        const canNavigate =
          typeof onStepClick === 'function' && (allowSkipAhead || index <= currentIndex);

        return (
          <div key={step.key} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onStepClick?.(index)}
              disabled={!canNavigate}
              aria-current={isCurrent ? 'step' : undefined}
              className={`rounded-full px-2.5 py-1 text-[10px] transition-colors ${
                isCurrent
                  ? 'bg-primary text-primary-foreground font-semibold ring-1 ring-primary/30'
                  : isComplete
                    ? 'bg-accent/20 text-accent'
                    : 'bg-secondary text-muted-foreground'
              } ${canNavigate ? 'cursor-pointer' : 'cursor-default'}`}
            >
              {index + 1}. {step.label}
            </button>
            {index < steps.length - 1 && (
              <span aria-hidden="true" className="text-[10px] text-muted-foreground/50">
                ›
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
