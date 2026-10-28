'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { EntityGraphDesignPageInner } from '@/components/entity-graph/design-page-surface';
import { readEntityGraphSelection } from '@/lib/entity-graph-scenarios';

export default function EntityGraphDesignPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading design…</div>}>
      <EntityGraphDesignPageLoader />
    </Suspense>
  );
}

function EntityGraphDesignPageLoader() {
  const searchParams = useSearchParams();
  const { scenarioId, entityId } = readEntityGraphSelection(searchParams);
  return (
    <EntityGraphDesignPageInner
      key={`${scenarioId}:${entityId}`}
      scenarioId={scenarioId}
      entityId={entityId}
    />
  );
}
