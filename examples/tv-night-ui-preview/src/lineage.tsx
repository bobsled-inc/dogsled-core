import { useState, type ReactElement } from 'react';
import { EmptyState } from '@dogsled/ui/EmptyState';
import { GraphNode } from '@dogsled/ui/GraphNode';
import { Database } from '@dogsled/ui/icons/Database';
import { Table } from '@dogsled/ui/icons/Table';
import type { Snapshot } from './contract';

export function layoutLineage(graph: NonNullable<Snapshot['lineage']>): {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
} | null {
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) return null;
  const remaining = new Set(ids);
  const levels = new Map<string, number>();
  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      graph.edges.filter((edge) => edge.to === id).every((edge) => levels.has(edge.from))
    );
    if (!ready.length) return null;
    for (const id of ready) {
      const incoming = graph.edges.filter((edge) => edge.to === id);
      levels.set(
        id,
        incoming.length ? Math.max(...incoming.map((edge) => levels.get(edge.from)!)) + 1 : 0
      );
      remaining.delete(id);
    }
  }
  const ranks = [...new Set(levels.values())];
  const maxRows = Math.max(
    1,
    ...ranks.map((rank) => [...levels.values()].filter((level) => level === rank).length)
  );
  const positions = new Map<string, { x: number; y: number }>();
  for (const rank of ranks) {
    const nodes = graph.nodes.filter((node) => levels.get(node.id) === rank);
    nodes.forEach((node, index) =>
      positions.set(node.id, {
        x: 24 + rank * 312,
        y: 24 + (maxRows - nodes.length) * 88 + index * 176,
      })
    );
  }
  return { positions, width: Math.max(1, ranks.length) * 312 - 24, height: maxRows * 176 + 48 };
}

export function LineagePreview({
  snapshot,
  onFile,
  emptyDescription,
}: {
  snapshot: Snapshot;
  onFile: (path: string) => void;
  emptyDescription: string;
}): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const graph = snapshot.lineage;
  if (!graph?.nodes.length)
    return (
      <EmptyState
        size="sm"
        icon={<Database color="secondary" />}
        title="No dependencies for this step yet"
        description={emptyDescription}
      />
    );
  const layout = layoutLineage(graph);
  if (!layout)
    return (
      <EmptyState
        size="sm"
        icon={<Database color="secondary" />}
        title="Check the dependencies"
        description="A definition is missing or the graph contains a cycle. Ask your agent to check the source files."
      />
    );
  const activate = (id: string) => {
    const node = graph.nodes.find((item) => item.id === id);
    setSelected(id);
    if (node?.available) onFile(id);
  };
  return (
    <figure className="lineage-figure">
      <div className="lineage-scroll" role="group" aria-label="Declared model dependencies">
        <div className="lineage-stage" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="lineage-connectors"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="lineage-arrow"
                viewBox="0 0 10 10"
                refX="7"
                refY="5"
                markerWidth="10"
                markerHeight="10"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M 1 1 L 7 5 L 1 9" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const from = layout.positions.get(edge.from)!;
              const to = layout.positions.get(edge.to)!;
              const sourceX = from.x + 240;
              const sourceY = from.y + 66;
              const targetY = to.y + 66;
              const middleX = (sourceX + to.x) / 2;
              const direction = Math.sign(targetY - sourceY);
              const radius = Math.min(8, Math.abs(targetY - sourceY) / 2, (to.x - sourceX) / 2);
              const path =
                direction === 0
                  ? `M ${sourceX} ${sourceY} H ${to.x}`
                  : `M ${sourceX} ${sourceY} H ${middleX - radius} Q ${middleX} ${sourceY} ${middleX} ${sourceY + direction * radius} V ${targetY - direction * radius} Q ${middleX} ${targetY} ${middleX + radius} ${targetY} H ${to.x}`;
              return (
                <path key={`${edge.from}:${edge.to}`} d={path} markerEnd="url(#lineage-arrow)" />
              );
            })}
          </svg>
          {graph.nodes.map((node) => {
            const position = layout.positions.get(node.id)!;
            const isSource = !graph.edges.some((edge) => edge.to === node.id);
            return (
              <div
                className="lineage-node-position"
                key={node.id}
                style={{ left: position.x, top: position.y }}
              >
                <GraphNode
                  title={node.label}
                  subtitle={node.kind}
                  eyebrow={isSource ? 'Input' : 'Output'}
                  icon={isSource ? <Database /> : <Table />}
                  categoryKey={node.kind}
                  width={240}
                  minHeight={132}
                  selected={selected === node.id}
                  meta={{ text: node.available ? 'Inspect definition' : 'Definition unavailable' }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Inspect ${node.label} definition`}
                  aria-disabled={!node.available}
                  onClick={() => activate(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate(node.id);
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="text-caption text-secondary">
        {graph.edges.length
          ? 'Arrows show declared inputs. Select a node to inspect its file.'
          : 'Saved inputs for this step. Select a node to inspect its file.'}
      </figcaption>
      <ul className="sr-only">
        {graph.edges.map((edge) => (
          <li key={`${edge.from}:${edge.to}`}>
            {graph.nodes.find((node) => node.id === edge.from)?.label} supplies{' '}
            {graph.nodes.find((node) => node.id === edge.to)?.label}.
          </li>
        ))}
      </ul>
    </figure>
  );
}
