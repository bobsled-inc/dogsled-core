import Link from 'next/link';
import type { ReactNode } from 'react';

export interface HubCardStat {
  label: string;
  value: string;
}

export type HubCardProps = {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  stats?: HubCardStat[];
  accent?: 'primary' | 'amber' | 'emerald';
  icon?: ReactNode;
};

const ACCENT_BG: Record<NonNullable<HubCardProps['accent']>, string> = {
  primary: 'bg-primary/10 text-primary',
  amber: 'bg-amber-500/10 text-amber-500',
  emerald: 'bg-emerald-500/10 text-emerald-500',
};

export function HubCard({
  href,
  eyebrow,
  title,
  description,
  stats = [],
  accent = 'primary',
  icon,
}: HubCardProps) {
  return (
    <Link
      href={href}
      className="group relative flex flex-col rounded-lg border border-border bg-card p-5 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${ACCENT_BG[accent]}`}
          >
            {icon}
            {eyebrow}
          </div>
          <h3 className="mt-3 text-lg font-semibold tracking-tight">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <span className="mt-1 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground">
          →
        </span>
      </div>
      {stats.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <div className="truncate text-lg font-semibold tabular-nums" title={s.value}>
                {s.value}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}
