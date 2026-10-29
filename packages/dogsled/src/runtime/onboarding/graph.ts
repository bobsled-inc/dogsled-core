import type { ProjectLineage } from './workspace.js';
import { escapeHtml as e } from './html.js';

/** Layer declared dependencies without guessing missing edges or hiding cycles. */
export function renderGraph(graph: ProjectLineage | undefined): string {
  if (!graph?.nodes.length) return '<p>No definitions yet.</p>';
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (
    ids.size !== graph.nodes.length ||
    graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
  ) {
    return '<p>These definitions contain a cycle or an unknown dependency. Ask your agent to inspect the model definitions before rendering lineage.</p>';
  }
  const levels = new Map<string, number>();
  const remaining = new Set(graph.nodes.map((node) => node.id));
  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      graph.edges.filter((edge) => edge.to === id).every((edge) => levels.has(edge.from))
    );
    if (!ready.length) {
      return '<p>These definitions contain a cycle or an unknown dependency. Ask your agent to inspect the model definitions before rendering lineage.</p>';
    }
    for (const id of ready) {
      const parents = graph.edges.filter((edge) => edge.to === id);
      levels.set(
        id,
        parents.length ? Math.max(...parents.map((edge) => levels.get(edge.from)!)) + 1 : 0
      );
      remaining.delete(id);
    }
  }
  const counts = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const level = levels.get(node.id)!;
    const row = counts.get(level) ?? 0;
    positions.set(node.id, { x: 24 + level * 312, y: 24 + row * 176 });
    counts.set(level, row + 1);
  }
  const maximumRows = Math.max(...counts.values());
  for (const node of graph.nodes) {
    positions.get(node.id)!.y += (maximumRows - counts.get(levels.get(node.id)!)!) * 88;
  }
  const width = (Math.max(...levels.values()) + 1) * 312 + 24;
  const height = Math.max(...counts.values()) * 176 + 24;
  const paths = graph.edges
    .map((edge) => {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      const sourceX = a.x + 240;
      const sourceY = a.y + 66;
      const targetY = b.y + 66;
      const middleX = (sourceX + b.x) / 2;
      const direction = Math.sign(targetY - sourceY);
      const radius = Math.min(8, Math.abs(targetY - sourceY) / 2);
      const path =
        direction === 0
          ? `M ${sourceX} ${sourceY} H ${b.x}`
          : `M ${sourceX} ${sourceY} H ${middleX - radius} Q ${middleX} ${sourceY} ${middleX} ${sourceY + direction * radius} V ${targetY - direction * radius} Q ${middleX} ${targetY} ${middleX + radius} ${targetY} H ${b.x}`;
      return `<path d="${path}" marker-end="url(#dag-arrow)"/>`;
    })
    .join('');
  const nodes = graph.nodes
    .map((node) => {
      const p = positions.get(node.id)!;
      const content = `<title>${e(node.label)} — ${e(node.description)}${node.available ? '' : ' (definition missing)'}</title><rect x="${p.x}" y="${p.y}" width="240" height="132"/><text x="${p.x + 12}" y="${p.y + 44}">${e(node.label.length > 25 ? node.label.slice(0, 24) + '…' : node.label)}</text><text class="dag-kind" x="${p.x + 12}" y="${p.y + 68}">${e(node.available ? node.kind : 'definition missing')}</text><text class="dag-meta" x="${p.x + 12}" y="${p.y + 108}">${node.available ? 'Inspect definition' : 'Definition unavailable'}</text>`;
      return node.available
        ? `<a href="#files" data-file="${e(node.id)}" aria-label="Inspect ${e(node.label)}">${content}</a>`
        : `<g class="dag-missing">${content}</g>`;
    })
    .join('');
  return `<div class="dag-scroll" tabindex="0" role="region" aria-label="Model dependency graph"><svg class="lineage-dag" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Sources and models connected by dependency arrows"><defs><marker id="dag-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1 1 L7 5 L1 9"/></marker></defs><g class="dag-links">${paths}</g><g class="dag-nodes">${nodes}</g></svg></div>`;
}
