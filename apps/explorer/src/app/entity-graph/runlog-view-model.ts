import { formatRelative } from '@/lib/format-relative';
import { ENTITY_GRAPH_SCHEMA } from '@/lib/entity-graph-workspace';

export interface LastRun {
  finished_at: string;
}

export interface ResolveCounts {
  clusters: number;
  queue: number;
}

export interface ResolveStatItem {
  label: string;
  value: string;
}

export function buildRunStatusText(runLogError: boolean, lastRun: LastRun | null): string {
  if (runLogError) return 'Run log unavailable — check workspace/entity-graph-demo/ is accessible.';
  if (lastRun) return `Last run: ${formatRelative(lastRun.finished_at)}`;
  return 'No pipeline runs yet — design a spec and run the pipeline from Resolve.';
}

export function buildResolveStats(
  stats: ResolveCounts | null,
  lastRun: LastRun | null
): ResolveStatItem[] {
  if (!stats || !lastRun) return [];
  return [
    { label: 'Clusters', value: String(stats.clusters) },
    { label: 'Pending review', value: String(stats.queue) },
    { label: 'Schema', value: ENTITY_GRAPH_SCHEMA },
  ];
}
