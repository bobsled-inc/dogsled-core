'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  describePersistedEntityGraphWizardState,
  loadPersistedEntityGraphWizardStateForContext,
  type EntityGraphWizardContext,
  type PersistedEntityGraphWizardState,
} from '@/lib/entity-graph-wizard-state';
import { buildEntityGraphHref } from '@/lib/entity-graph-scenarios';

interface SavedEntityGraphBannerProps {
  context?: EntityGraphWizardContext;
  initialSavedState?: PersistedEntityGraphWizardState | null;
  loadState?: () => PersistedEntityGraphWizardState | null;
  describeState?: (state: PersistedEntityGraphWizardState) => {
    entityLabel: string;
    stepIndex: number;
    stepCount: number;
  };
}

const DEFAULT_CONTEXT: EntityGraphWizardContext = { scenarioId: 'default', entityId: 'company' };

export function SavedEntityGraphBanner({
  context,
  initialSavedState,
  loadState,
  describeState,
}: SavedEntityGraphBannerProps = {}) {
  const resolvedContext = context ?? DEFAULT_CONTEXT;
  const describeSavedState = describeState ?? describePersistedEntityGraphWizardState;
  const [savedState, setSavedState] = useState<PersistedEntityGraphWizardState | null>(
    initialSavedState ?? null
  );

  useEffect(() => {
    if (initialSavedState !== undefined) {
      setSavedState(initialSavedState);
      return;
    }

    if (loadState) {
      setSavedState(loadState());
      return;
    }

    setSavedState(loadPersistedEntityGraphWizardStateForContext(resolvedContext));
  }, [initialSavedState, loadState, resolvedContext.entityId, resolvedContext.scenarioId]);

  if (!savedState) return null;

  const summary = describeSavedState(savedState);

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            Saved Entity Graph draft
          </div>
          <div className="text-sm">
            {summary.entityLabel} is saved through step {summary.stepIndex} of {summary.stepCount}.
          </div>
          <div className="text-xs text-muted-foreground">
            Resume the in-progress wizard exactly where you left it.
          </div>
        </div>
        <Link
          href={buildEntityGraphHref('/entity-graph/design', {
            scenario: savedState.scenarioId ?? resolvedContext.scenarioId,
            entity: savedState.entityId ?? resolvedContext.entityId,
            params: { step: savedState.step },
          })}
          className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Load saved
        </Link>
      </div>
    </div>
  );
}
