'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ResolvePageInner } from '@/components/entity-graph/resolve-page-surface';
import { readEntityGraphSelection } from '@/lib/entity-graph-scenarios';

export default function ResolvePage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading resolve…</div>}>
      <ResolvePageLoader />
    </Suspense>
  );
}

function ResolvePageLoader() {
  const searchParams = useSearchParams();
  const { scenarioId, entityId } = readEntityGraphSelection(searchParams);
  return (
    <ResolvePageInner
      key={`${scenarioId}:${entityId}`}
      scenarioId={scenarioId}
      entityId={entityId}
    />
  );
}
