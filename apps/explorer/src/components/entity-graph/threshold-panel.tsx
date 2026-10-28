'use client';

export interface Thresholds {
  auto_merge: number;
  review: number;
  auto_reject: number;
}

export interface ThresholdPanelProps {
  values: Thresholds;
  onChange: (next: Thresholds) => void;
}

const BANDS: Array<{ key: keyof Thresholds; label: string; tone: string; description: string }> = [
  {
    key: 'auto_merge',
    label: 'Auto-merge',
    tone: 'bg-emerald-500/15 text-emerald-500',
    description: 'Pairs at or above this score are merged without review.',
  },
  {
    key: 'review',
    label: 'Review',
    tone: 'bg-amber-500/15 text-amber-500',
    description: 'Pairs between review and auto-merge land in the queue.',
  },
  {
    key: 'auto_reject',
    label: 'Auto-reject',
    tone: 'bg-red-500/15 text-red-500',
    description: 'Pairs below this score are rejected automatically.',
  },
];

function clampThreshold(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function sanitizeThresholds(next: Thresholds): Thresholds {
  const autoReject = clampThreshold(next.auto_reject);
  const reviewFloor = Math.max(clampThreshold(next.review), autoReject);
  const autoMerge = Math.max(clampThreshold(next.auto_merge), Math.min(1, reviewFloor + 0.01));
  const review = Math.min(reviewFloor, Math.max(0, autoMerge - 0.01));

  return {
    auto_merge: autoMerge,
    review,
    auto_reject: Math.min(autoReject, review),
  };
}

export function ThresholdPanel({ values, onChange }: ThresholdPanelProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {BANDS.map(({ key, label, tone, description }) => (
        <div key={key} className="rounded-md border border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
              {label}
            </span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={values[key].toFixed(2)}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                const clamped = clampThreshold(nextValue);
                onChange(sanitizeThresholds({ ...values, [key]: clamped }));
              }}
              className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right font-mono text-xs outline-none focus:border-primary"
              aria-label={`${label} numeric threshold`}
            />
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={values[key]}
            onChange={(e) =>
              onChange(sanitizeThresholds({ ...values, [key]: Number(e.target.value) }))
            }
            className="mt-3 w-full"
            aria-label={`${label} threshold`}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">{description}</p>
        </div>
      ))}
    </div>
  );
}
