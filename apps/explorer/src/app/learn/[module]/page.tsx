'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { LearnStepPanel } from '@/components/learn/learn-step-panel';
import {
  ENTITY_GRAPH_TABLE_ATLAS,
  LEARN_MODULES,
  getLearnGroupById,
  getLearnModuleById,
} from '@/lib/learn-curriculum';
import { useLearnProgress } from '@/lib/learn-progress';

export default function LearnModulePage() {
  const params = useParams();
  const moduleId = typeof params.module === 'string' ? params.module : '';
  const module = getLearnModuleById(moduleId);
  const { getModuleProgress, getSummary, markStepComplete, setLastStep, resetModule } =
    useLearnProgress();

  if (!module) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader
          title="Learn module not found"
          description="The requested learning module does not exist in this explorer build."
          breadcrumbs={[
            { label: 'Dashboard', href: '/' },
            { label: 'Learn', href: '/learn' },
            { label: 'Missing Module' },
          ]}
        />
        <Link href="/learn" className="text-sm text-primary hover:underline">
          Back to Learn
        </Link>
      </div>
    );
  }

  const group = getLearnGroupById(module.group);
  const progress = getModuleProgress(module.id);
  const summary = getSummary(module.id);
  const activeStepId = progress.lastStepId ?? module.steps[0]?.id ?? null;
  const activeStep = module.steps.find((step) => step.id === activeStepId) ?? module.steps[0];
  const completedStepIds = progress.completedStepIds;

  const currentModuleIndex = LEARN_MODULES.findIndex((m) => m.id === module.id);
  const nextModule = LEARN_MODULES[currentModuleIndex + 1] ?? null;

  const activeStepIndex = activeStep ? module.steps.findIndex((s) => s.id === activeStep.id) : -1;
  const nextStep = activeStepIndex >= 0 ? (module.steps[activeStepIndex + 1] ?? null) : null;

  if (!activeStep) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader
          title={module.title}
          description="This Learn module does not currently have steps configured."
          breadcrumbs={[
            { label: 'Dashboard', href: '/' },
            { label: 'Learn', href: '/learn' },
            { label: module.title },
          ]}
        />
        <Link href="/learn" className="text-sm text-primary hover:underline">
          Back to Learn
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title={module.title}
        description={module.description}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Learn', href: '/learn' },
          { label: module.title },
        ]}
        actions={
          <button
            type="button"
            onClick={() => resetModule(module.id)}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Reset Module
          </button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <aside className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="primary">{group.label}</Badge>
            <Badge variant="accent">{module.estimatedMinutes} min</Badge>
            {summary.isComplete && <Badge variant="success">Complete</Badge>}
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{module.outcome}</p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${summary.percent}%` }}
            />
          </div>

          <div className="mt-5 space-y-2">
            {module.steps.map((step, index) => {
              const isCurrent = step.id === activeStep.id;
              const isComplete = completedStepIds.includes(step.id);
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setLastStep(module.id, step.id)}
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
                  <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {step.kind}
                  </p>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="space-y-5">
          <LearnStepPanel
            module={module}
            step={activeStep}
            nextStep={nextStep}
            completed={completedStepIds.includes(activeStep.id)}
            onComplete={(stepId) => markStepComplete(module.id, stepId)}
            onNext={() => {
              if (nextStep) setLastStep(module.id, nextStep.id);
            }}
          />

          {summary.isComplete && nextModule && (
            <section className="rounded-2xl border border-primary/30 bg-primary/5 p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest text-primary">
                    Module complete
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">Up next: {nextModule.title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{nextModule.description}</p>
                </div>
                <Link
                  href={`/learn/${nextModule.id}`}
                  className="shrink-0 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                >
                  Start {nextModule.title} →
                </Link>
              </div>
            </section>
          )}

          {summary.isComplete && !nextModule && (
            <section className="rounded-2xl border border-primary/30 bg-primary/5 p-6">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Curriculum complete
              </p>
              <h2 className="mt-1 text-lg font-semibold">You've finished all Learn modules</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Return to the overview to review your progress or reset any module.
              </p>
              <Link
                href="/learn"
                className="mt-4 inline-flex rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                Back to Learn
              </Link>
            </section>
          )}

          {module.id === 'entity-graph-deep-dive' && (
            <section className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">Entity Graph Table Atlas</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Full output pipeline reference, including audit, lineage, relationships, and
                    metadata tables.
                  </p>
                </div>
                <Link href="/entity-graph/data" className="text-xs text-primary hover:underline">
                  Open Data
                </Link>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {ENTITY_GRAPH_TABLE_ATLAS.map((entry) => (
                  <div
                    key={entry.suffix}
                    className="rounded-2xl border border-border bg-secondary/20 p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="default">{entry.stage}</Badge>
                      <code className="text-xs text-primary">{entry.suffix}</code>
                    </div>
                    <div className="mt-2 text-sm font-medium">{entry.label}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {entry.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
