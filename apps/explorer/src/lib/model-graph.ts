export interface GraphNode {
  id: string;
  label: string;
  layer:
    'dimension' | 'fact' | 'golden' | 'mart' | 'entity_graph' | 'profile' | 'source' | 'staging';
  filePath?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export const GRAPH_LAYERS = [
  'source',
  'staging',
  'dimension',
  'fact',
  'profile',
  'entity_graph',
  'golden',
  'mart',
] as const satisfies readonly GraphNode['layer'][];

const LAYER_TITLES: Record<GraphNode['layer'], string> = {
  source: 'Sources',
  staging: 'Staging',
  dimension: 'Dimensions',
  fact: 'Facts',
  profile: 'Source Models',
  entity_graph: 'Entity Graph',
  golden: 'Golden Records',
  mart: 'Marts',
};

export function graphLayerTitle(layer: GraphNode['layer']): string {
  return LAYER_TITLES[layer];
}

function normalizeTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/^(raw_|src_|source_|stg_|stage_|dim_|fct_|mart_)/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function overlapScore(left: string, right: string): number {
  const leftTokens = new Set(normalizeTokens(left));
  const rightTokens = new Set(normalizeTokens(right));
  let score = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function findRelatedNodes(
  sources: GraphNode[],
  target: GraphNode,
  maxMatches: number
): GraphNode[] {
  return sources
    .map((source, index) => ({
      index,
      score: overlapScore(source.label, target.label),
      source,
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .filter((_, index) => index < maxMatches)
    .map((entry) => entry.source);
}

function filePathForName(name: string, files: Array<{ path: string }>): string | undefined {
  return files.find(
    (file) =>
      file.path
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') === name
  )?.path;
}

export function buildModelGraph(options: {
  files: Array<{ path: string }>;
  marts: Array<{ name: string }>;
  sources: Array<{ name: string }>;
  staging: Array<{ name: string }>;
}): { edges: GraphEdge[]; nodes: GraphNode[] } {
  const sourceNodes = options.sources.map((spec) => ({
    id: spec.name,
    label: spec.name,
    layer: 'source' as const,
    filePath: filePathForName(spec.name, options.files),
  }));
  const stagingNodes = options.staging.map((spec) => ({
    id: spec.name,
    label: spec.name,
    layer: 'staging' as const,
    filePath: filePathForName(spec.name, options.files),
  }));
  const martNodes = options.marts.map((spec) => ({
    id: spec.name,
    label: spec.name,
    layer: 'mart' as const,
    filePath: filePathForName(spec.name, options.files),
  }));

  const edges: GraphEdge[] = [];
  for (const stagingNode of stagingNodes) {
    for (const sourceNode of findRelatedNodes(sourceNodes, stagingNode, 2)) {
      edges.push({ from: sourceNode.id, to: stagingNode.id });
    }
  }
  for (const martNode of martNodes) {
    for (const stagingNode of findRelatedNodes(stagingNodes, martNode, 3)) {
      edges.push({ from: stagingNode.id, to: martNode.id });
    }
  }

  return {
    nodes: [...sourceNodes, ...stagingNodes, ...martNodes],
    edges,
  };
}
