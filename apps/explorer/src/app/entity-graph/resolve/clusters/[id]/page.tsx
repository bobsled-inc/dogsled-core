import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { ClusterDetail } from '@/components/entity-graph/cluster-detail';
import {
  buildEntityGraphHref,
  getEntityGraphOverviewHref,
  readEntityGraphSelection,
} from '@/lib/entity-graph-scenarios';
import {
  buildClusterBreadcrumbLabel,
  fetchEntityGraphClusterDisplayName,
} from '@/lib/entity-graph-workspace';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function toSearchLike(searchParams: Record<string, string | string[] | undefined>): {
  get(name: string): string | null;
} {
  return {
    get(name: string): string | null {
      const value = searchParams[name];
      if (Array.isArray(value)) return value[0] ?? null;
      return typeof value === 'string' ? value : null;
    },
  };
}

export default async function ClusterPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  const { id } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const { scenarioId, entityId } = readEntityGraphSelection(toSearchLike(resolvedSearchParams));
  const displayName = await fetchEntityGraphClusterDisplayName(id, scenarioId, entityId);
  const breadcrumbLabel = buildClusterBreadcrumbLabel(displayName, id);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Bobsled Core', href: '/' },
          { label: 'Entity Graph', href: getEntityGraphOverviewHref(scenarioId, entityId) },
          {
            label: 'Resolve',
            href: buildEntityGraphHref('/entity-graph/resolve', {
              scenario: scenarioId,
              entity: entityId,
              params: { tab: 'clusters' },
            }),
          },
          { label: breadcrumbLabel },
        ]}
        title="Cluster"
        description="Permanent URL for this cluster. Survives future splits — if the cluster is no longer current, we show a tombstone."
        actions={
          <Link
            href={buildEntityGraphHref('/entity-graph/resolve', {
              scenario: scenarioId,
              entity: entityId,
              params: { tab: 'clusters' },
            })}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            ← All clusters
          </Link>
        }
      />
      <div className="min-h-[500px]">
        <ClusterDetail clusterId={id} scenario={scenarioId} entity={entityId} />
      </div>
    </div>
  );
}
