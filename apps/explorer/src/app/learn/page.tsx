'use client';

import { PageHeader } from '@/components/ui/page-header';
import { LearnModuleCard } from '@/components/learn/learn-module-card';
import { LEARN_MODULE_GROUPS, LEARN_MODULES } from '@/lib/learn-curriculum';
import { useLearnProgress } from '@/lib/learn-progress';

export default function LearnPage() {
  const { getSummary } = useLearnProgress();

  const totalSteps = LEARN_MODULES.reduce((sum, m) => sum + m.steps.length, 0);
  const completedSteps = LEARN_MODULES.reduce((sum, m) => sum + getSummary(m.id).completedCount, 0);
  const completedModules = LEARN_MODULES.filter((m) => getSummary(m.id).isComplete).length;
  const overallPercent = totalSteps === 0 ? 0 : Math.round((completedSteps / totalSteps) * 100);

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <PageHeader
        title="Learn"
        description="A visual curriculum for Bobsled Core concepts, runnable commands, local SQL inspection, Entity Graph outputs, and credential-aware extraction paths."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Learn' }]}
      />

      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium">
            {completedModules} of {LEARN_MODULES.length} modules complete
          </div>
          <div className="text-sm text-muted-foreground">
            {completedSteps} / {totalSteps} steps · {overallPercent}%
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${overallPercent}%` }}
          />
        </div>
      </div>

      {LEARN_MODULE_GROUPS.map((group) => {
        const modules = LEARN_MODULES.filter((module) => module.group === group.id);
        if (modules.length === 0) {
          return null;
        }

        return (
          <section key={group.id} className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold">{group.label}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {modules.map((module) => {
                const summary = getSummary(module.id);
                return (
                  <LearnModuleCard
                    key={module.id}
                    module={module}
                    completedCount={summary.completedCount}
                    percent={summary.percent}
                    isComplete={summary.isComplete}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
