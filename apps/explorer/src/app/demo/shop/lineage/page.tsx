import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { LineageGraph } from '@/components/lineage-graph';
import { ModelDag } from '@/components/model-dag';
import { buildShopModelGraph } from '@/lib/shop-demo-workspace';
import type { GraphEdge, GraphNode } from '@/lib/model-graph';

export const dynamic = 'force-dynamic';

export default async function ShopDemoLineagePage() {
  const { nodes: rawNodes, edges: rawEdges } = await buildShopModelGraph();

  // Map shop layer names to the shared GraphNode layer union
  const layerMap: Record<string, GraphNode['layer']> = {
    source: 'source',
    staging: 'staging',
    fact: 'mart',
    dimension: 'mart',
  };
  const nodes: GraphNode[] = rawNodes.map((n) => ({
    id: n.id,
    label: n.label,
    layer: layerMap[n.layer] ?? 'source',
  }));
  const edges: GraphEdge[] = rawEdges;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Bobsled Core', href: '/' },
          { label: 'Demo', href: '/demo/shop' },
          { label: 'Lineage' },
        ]}
        title="Shop Lineage"
        description="The full data path from raw seed CSVs through staging models to mart tables."
        actions={
          <Link
            href="/demo/shop/models"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            Inspect Models
          </Link>
        }
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold">DAG</h2>
        <ModelDag nodes={nodes} edges={edges} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Layer view</h2>
        <LineageGraph nodes={nodes} edges={edges} />
      </section>
    </div>
  );
}
