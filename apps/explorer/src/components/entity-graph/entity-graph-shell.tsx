'use client';

import { Suspense, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { deriveEntityGraphCtx, type EntityGraphCtx } from '@/lib/entity-graph-assistant-ctx';
import { readEntityGraphSelection, type EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';
import { AssistantRail } from './assistant-rail';
import {
  EntityGraphAssistantProvider,
  useEntityGraphAssistantContext,
} from './entity-graph-assistant-context';

interface EntityGraphShellProps {
  children: ReactNode;
}

// Surfaces where the assistant rail has spec/queue/cluster context worth
// surfacing. On view-only surfaces (hub, lineage, demo data) the rail adds
// nothing, so we hide it entirely — including the collapsed sliver — and let
// the main content reclaim the horizontal space.
const EDIT_SURFACES: Set<EntityGraphCtx> = new Set([
  'design',
  'resolve.queue',
  'resolve.clusters',
  'resolve.cluster_detail',
]);

function EntityGraphShellLayout({
  children,
  ctx,
  scenario,
  entity,
  selectedPairId,
}: EntityGraphShellProps & {
  ctx: ReturnType<typeof deriveEntityGraphCtx>;
  scenario: EntityGraphScenarioId;
  entity: 'company' | 'customer' | 'location';
  selectedPairId: string | null;
}) {
  const { specName, specYaml, selectedPair } = useEntityGraphAssistantContext();
  const showRail = EDIT_SURFACES.has(ctx);

  return (
    <div className="flex h-full w-full min-h-screen">
      <main className="flex-1 overflow-auto">{children}</main>
      {showRail && (
        <AssistantRail
          ctx={ctx}
          scenario={scenario}
          entity={entity}
          specName={specName}
          specYaml={specYaml}
          selectedPairId={selectedPairId}
          selectedPair={selectedPair}
        />
      )}
    </div>
  );
}

function EntityGraphShellInner({ children }: EntityGraphShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab');
  const ctx = deriveEntityGraphCtx(pathname, tab);
  const querySelection = readEntityGraphSelection(searchParams);
  const scenarioId = querySelection.scenarioId;
  const entityId = querySelection.entityId;
  const selectedPairId = searchParams.get('pair');

  return (
    <EntityGraphAssistantProvider>
      <EntityGraphShellLayout
        ctx={ctx}
        scenario={scenarioId}
        entity={entityId}
        selectedPairId={selectedPairId}
      >
        {children}
      </EntityGraphShellLayout>
    </EntityGraphAssistantProvider>
  );
}

export function EntityGraphShell({ children }: EntityGraphShellProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full min-h-screen">
          <main className="flex-1 overflow-auto" aria-busy="true" />
        </div>
      }
    >
      <EntityGraphShellInner>{children}</EntityGraphShellInner>
    </Suspense>
  );
}
