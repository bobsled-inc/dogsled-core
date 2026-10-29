import type { ProjectLineage } from './workspace.js';
import { escapeHtml as e } from './html.js';

/** Layer declared dependencies without guessing missing edges or hiding cycles. */
export function renderGraph(graph: ProjectLineage | undefined): string {
  if (!graph?.nodes.length) return '<p>No definitions yet.</p>';
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
    positions.set(node.id, { x: 24 + level * 260, y: 24 + row * 110 });
    counts.set(level, row + 1);
  }
  const width = (Math.max(...levels.values()) + 1) * 260 + 24;
  const height = Math.max(...counts.values()) * 110 + 24;
  const paths = graph.edges
    .map((edge) => {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      return `<path d="M${a.x + 210},${a.y + 36} C${a.x + 240},${a.y + 36} ${b.x - 30},${b.y + 36} ${b.x},${b.y + 36}" marker-end="url(#dag-arrow)"/>`;
    })
    .join('');
  const nodes = graph.nodes
    .map((node) => {
      const p = positions.get(node.id)!;
      const content = `<title>${e(node.label)} — ${e(node.description)}${node.available ? '' : ' (definition missing)'}</title><rect x="${p.x}" y="${p.y}" width="210" height="72" rx="8"/><text x="${p.x + 12}" y="${p.y + 27}">${e(node.label.length > 25 ? node.label.slice(0, 24) + '…' : node.label)}</text><text class="dag-kind" x="${p.x + 12}" y="${p.y + 51}">${e(node.available ? node.kind : 'definition missing')}</text>`;
      return node.available
        ? `<a href="#files" data-file="${e(node.id)}" aria-label="Inspect ${e(node.label)}">${content}</a>`
        : `<g class="dag-missing">${content}</g>`;
    })
    .join('');
  return `<div class="dag-scroll" tabindex="0" role="region" aria-label="Model dependency graph"><svg class="lineage-dag" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Sources and models connected by dependency arrows"><defs><marker id="dag-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs><g class="dag-links">${paths}</g><g class="dag-nodes">${nodes}</g></svg></div>`;
}
