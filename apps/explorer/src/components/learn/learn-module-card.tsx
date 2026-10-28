import React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { LearnModule } from '@/lib/learn-curriculum';

export interface LearnModuleCardProps {
  module: LearnModule;
  completedCount: number;
  percent: number;
  isComplete: boolean;
}

export function LearnModuleCard({
  module,
  completedCount,
  percent,
  isComplete,
}: LearnModuleCardProps) {
  return (
    <article className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="primary">{module.estimatedMinutes} min</Badge>
        <Badge variant="accent">{module.steps.length} steps</Badge>
        {module.credentialEnvVars && <Badge variant="warning">credentials optional</Badge>}
        {isComplete && <Badge variant="success">Complete</Badge>}
      </div>
      <h3 className="mt-4 text-lg font-semibold">{module.title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{module.description}</p>
      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {completedCount}/{module.steps.length} complete
          </span>
          <span>{percent}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <p className="mt-4 text-sm text-foreground/90">{module.outcome}</p>
      <Link
        href={`/learn/${module.id}`}
        className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
      >
        {completedCount === 0 ? 'Start Module' : 'Resume Module'}
      </Link>
    </article>
  );
}
