'use client';

import React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ENTITY_GRAPH_TABLE_ATLAS, type LearnModule, type LearnStep } from '@/lib/learn-curriculum';

export interface LearnStepPanelProps {
  module: LearnModule;
  step: LearnStep;
  nextStep: LearnStep | null;
  completed: boolean;
  onComplete: (stepId: string) => void;
  onNext: () => void;
}

export function LearnStepPanel({
  module,
  step,
  nextStep,
  completed,
  onComplete,
  onNext,
}: LearnStepPanelProps) {
  const atlasEntry = step.tableSuffix
    ? ENTITY_GRAPH_TABLE_ATLAS.find((entry) => entry.suffix === step.tableSuffix)
    : null;

  return (
    <section className="rounded-2xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="primary">{step.kind}</Badge>
        {step.cliLessonId && <Badge variant="accent">{step.cliLessonId}</Badge>}
        {completed && <Badge variant="success">Complete</Badge>}
      </div>
      <h2 className="mt-4 text-2xl font-semibold">{step.title}</h2>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">{step.body}</p>

      {step.command && (
        <div className="mt-5 rounded-2xl border border-border bg-secondary/30 p-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Prefilled command
          </div>
          <code className="mt-2 block overflow-x-auto text-sm text-primary">
            dogsled {step.command.command} {step.command.args.join(' ')}
          </code>
        </div>
      )}

      {step.sql && (
        <div className="mt-5 rounded-2xl border border-border bg-secondary/30 p-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {step.kind === 'spec' ? 'Example' : 'SQL inspection'}
          </div>
          <code className="mt-2 block overflow-x-auto whitespace-pre text-sm text-primary">
            {step.sql}
          </code>
        </div>
      )}

      {atlasEntry && (
        <div className="mt-5 rounded-2xl border border-border bg-secondary/30 p-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Entity Graph table
          </div>
          <div className="mt-2 text-sm font-medium">{atlasEntry.label}</div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {atlasEntry.stage}: {atlasEntry.description}
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        {step.action && (
          <Link
            href={step.action.href}
            onClick={() => {
              if (step.action?.autoCompletes) {
                onComplete(step.id);
              }
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          >
            {step.action.label}
          </Link>
        )}
        <button
          type="button"
          onClick={() => {
            onComplete(step.id);
          }}
          className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {completed
            ? 'Completed'
            : step.kind === 'concept'
              ? 'Mark Concept Read'
              : 'Mark Complete'}
        </button>
        {nextStep && (
          <button
            type="button"
            onClick={() => {
              onComplete(step.id);
              onNext();
            }}
            className="rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
          >
            Next: {nextStep.title} →
          </button>
        )}
        <Link
          href="/learn"
          className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          All Modules
        </Link>
      </div>

      {module.credentialEnvVars && (step.kind === 'check' || step.kind === 'command') && (
        <p className="mt-5 text-xs leading-5 text-muted-foreground">
          Credentialed branches only check presence for {module.credentialEnvVars.join(', ')}.
        </p>
      )}
    </section>
  );
}
