'use client';

import { useMemo } from 'react';
import { GRAPH_LAYERS, graphLayerTitle, type GraphEdge, type GraphNode } from '@/lib/model-graph';

function cardColor(layer: GraphNode['layer']): string {
  if (layer === 'source') return 'border-info/30 bg-info/10';
  if (layer === 'staging') return 'border-warning/30 bg-warning/10';
  if (layer === 'dimension')
    return 'border-emerald-300/40 bg-emerald-50/70 dark:border-emerald-400/30 dark:bg-emerald-950/25';
  if (layer === 'fact')
    return 'border-cyan-300/40 bg-cyan-50/70 dark:border-cyan-400/30 dark:bg-cyan-950/25';
  if (layer === 'profile')
    return 'border-indigo-300/40 bg-indigo-50/70 dark:border-indigo-400/30 dark:bg-indigo-950/25';
  if (layer === 'entity_graph')
    return 'border-amber-300/40 bg-amber-50/70 dark:border-amber-400/30 dark:bg-amber-950/25';
  if (layer === 'golden')
    return 'border-rose-300/40 bg-rose-50/70 dark:border-rose-400/30 dark:bg-rose-950/25';
  return 'border-accent/30 bg-accent/10';
}

export function LineageGraph({
  edges,
  nodes,
  onNodeSelect,
}: {
  edges: GraphEdge[];
  nodes: GraphNode[];
  onNodeSelect?: (node: GraphNode) => void;
}) {
  const nodesByLayer = useMemo(() => {
    const next = new Map<GraphNode['layer'], GraphNode[]>();
    for (const layer of GRAPH_LAYERS) {
      next.set(layer, []);
    }
    for (const node of nodes) {
      next.get(node.layer)?.push(node);
    }
    return next;
  }, [nodes]);
  const upstreamByNode = useMemo(() => {
    const labelsById = new Map(nodes.map((node) => [node.id, node.label]));
    const next = new Map<string, string[]>();

    for (const edge of edges) {
      const upstream = next.get(edge.to) ?? [];
      upstream.push(labelsById.get(edge.from) ?? edge.from);
      next.set(edge.to, upstream);
    }

    return next;
  }, [edges, nodes]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {GRAPH_LAYERS.map((layer) => {
        const layerNodes = nodesByLayer.get(layer) ?? [];
        if (layerNodes.length === 0) {
          return null;
        }

        return (
          <div key={layer} className="space-y-3">
            <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {graphLayerTitle(layer)}
            </div>
            {layerNodes.map((node) => {
              const upstream = upstreamByNode.get(node.id) ?? [];
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onNodeSelect?.(node)}
                  className={`w-full rounded-2xl border p-4 text-left transition-colors hover:border-primary/40 ${cardColor(node.layer)}`}
                >
                  <div className="font-mono text-xs font-medium">{node.label}</div>
                  {upstream.length > 0 && (
                    <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
                      {upstream.map((entry) => (
                        <div key={`${node.id}-${entry}`}>← {entry}</div>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
