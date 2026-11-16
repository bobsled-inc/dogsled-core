import { type EntityGraphEntityId, type EntityGraphScenarioId } from './entity-graph-scenarios';

export { ENTITY_GRAPH_DEFAULT_ENTITY } from './entity-graph-constants';

export type EntityGraphCtx =
  'hub' | 'design' | 'resolve.queue' | 'resolve.clusters' | 'resolve.cluster_detail';

/**
 * One record-field comparison (A vs B) inside a selected queue pair. Matches
 * the shape of `EntityGraphCompareFieldValue` from `entity_graph-scenarios.ts` but is exported
 * separately so the assistant prompt builder, rail, and API validation share a
 * named contract instead of repeating an inline structural type.
 */
export interface EntityGraphSelectedPairField {
  key: string;
  label: string;
  a: string | null;
  b: string | null;
}

/**
 * One per-feature similarity contribution inside a selected queue pair. Mirrors
 * `EntityGraphFeatureContribution` from `entity_graph-scenarios.ts` but is exported alongside
 * `EntityGraphSelectedPairField` so the prompt builder and route handler can validate
 * against a single named shape.
 */
export interface EntityGraphSelectedPairFeatureContribution {
  key: string;
  label: string;
  score: number | null;
  a: string | null;
  b: string | null;
}

/**
 * Compact summary of the queue pair the user has selected, surfaced to the
 * assistant rail so click-to-fill prompts can ask targeted questions and the
 * system prompt can reason about a concrete pair (record A/B values, score,
 * blocking rules, feature contributions) instead of generic queue advice.
 */
export interface EntityGraphSelectedPairContext {
  pairId: string;
  compositeScore: number;
  thresholdBand: string;
  sourceA: string | null;
  sourceB: string | null;
  recordALabel: string | null;
  recordBLabel: string | null;
  blockingRules: string | null;
  fields: EntityGraphSelectedPairField[];
  featureContributions: EntityGraphSelectedPairFeatureContribution[];
}

export interface EntityGraphCtxTips {
  title: string;
  summary: string;
  lead: string;
  bullets: string[];
  suggestedPrompts: string[];
  focus: string;
}

/**
 * Options for {@link buildSelectedPairPrompts}. Exported so callers, tests,
 * and any future validation share one shape — inline object types crossing
 * module boundaries get duplicated as soon as a third caller appears.
 */
export interface BuildSelectedPairPromptsOptions {
  /** The pair the rail is currently scoped to. Used to inject pair-specific
   * cues into the prompt strings so the assistant gets concrete context. */
  selectedPair?: EntityGraphSelectedPairContext | null;
  /** Auto-merge threshold for the active spec. When provided, the
   * lower-threshold prompt suggests a concrete value 0.05 below it. */
  thresholdHint?: number | null;
}

/**
 * Click-to-fill prompts shown in the assistant rail when a queue pair is
 * selected. Wording references the selected pair so the resulting message has
 * enough context for the assistant to give a concrete answer (e.g. simulating
 * a lower threshold or drafting a YAML edit). Threshold value is computed by
 * the caller from the current spec when known. Prompt text varies per pair so
 * dismissals scope naturally to that pair instead of muting every later one.
 */
export function buildSelectedPairPrompts(options: BuildSelectedPairPromptsOptions): string[] {
  const lowerThreshold =
    typeof options.thresholdHint === 'number' && Number.isFinite(options.thresholdHint)
      ? Math.max(0, +(options.thresholdHint - 0.05).toFixed(2))
      : null;
  const thresholdPrompt =
    lowerThreshold !== null
      ? `What if I lower the auto-merge threshold to ${lowerThreshold.toFixed(2)}?`
      : 'What if I lower the auto-merge threshold?';
  // Pair-specific suffix so the prompts (and the dismissed-set keys) differ
  // per pair. Falls back to a generic shape when no pair is selected.
  const pair = options.selectedPair;
  const pairTag = pair?.pairId ? ` (pair ${pair.pairId.slice(0, 8)}…)` : '';
  const bandTag = pair?.thresholdBand ? ` (band: ${pair.thresholdBand})` : '';
  return [
    `What features matter here?${pairTag}`,
    thresholdPrompt,
    `Suggest a YAML edit to handle this pair.${pairTag}`,
    `Why is this pair in review?${bandTag}`,
  ];
}

function buildDefaultTips(ctx: EntityGraphCtx): EntityGraphCtxTips {
  const sharedTitle = 'Entity Graph';
  switch (ctx) {
    case 'design':
      return {
        title: 'Design',
        summary: 'Bobsled Core Explorer Entity Graph Design builder',
        lead: 'Tune the resolution spec. Each step maps directly to YAML, so every edit stays explainable and reversible.',
        bullets: [
          'Standardize cleans fields before comparison.',
          'Blocking narrows candidate pairs so scoring stays cheap.',
          'Thresholds separate auto-merge, review, and reject bands.',
        ],
        suggestedPrompts: [
          'What should my auto-merge threshold be?',
          'How do I add another scoring feature?',
          'Which transforms help company names the most?',
        ],
        focus:
          'Focus: guide the user through the design builder, explain tradeoffs in weighting and thresholds, and propose YAML edits when they ask to change configuration.',
      };
    case 'resolve.queue':
      return {
        title: 'Queue',
        summary: 'Bobsled Core Explorer Entity Graph Resolve - Queue tab',
        lead: 'Each pair sits between auto-reject and auto-merge. Help the user decide merge, not_match, or defer.',
        bullets: [
          'Feature contributions explain why a pair scored the way it did.',
          'Agent sample proposals are evidence only; human decisions remain final.',
          'Merge and not_match decisions can trigger re-clustering.',
        ],
        suggestedPrompts: [
          'What does this score mean?',
          'What did the agent proposal mean?',
          'When should I choose not_match over defer?',
          'Which fields are doing the most work here?',
        ],
        focus:
          'Focus: pair review. Explain selected-pair evidence, agent proposals when present, and the safest next human action.',
      };
    case 'resolve.clusters':
      return {
        title: 'Clusters',
        summary: 'Bobsled Core Explorer Entity Graph Resolve - Clusters tab',
        lead: 'Clusters group records that the resolver now treats as the same entity. Trust tiers help users spot where to inspect next.',
        bullets: [
          'Larger clusters are not automatically lower quality.',
          'Trust tier reflects identity confidence, freshness, and source diversity.',
          'A not_match decision can split future cluster runs.',
        ],
        suggestedPrompts: [
          'Which clusters should I inspect first?',
          'How is trust tier calculated?',
          'Why is this cluster size bigger than expected?',
        ],
        focus:
          'Focus: cluster quality. Help the user scan for outliers, explain trust metrics, and identify clusters that deserve a closer look.',
      };
    case 'resolve.cluster_detail':
      return {
        title: 'Cluster detail',
        summary: 'Bobsled Core Explorer Entity Graph Resolve - Cluster detail',
        lead: 'Golden record values are selected per attribute using the survivorship spec, so every winning value should be explainable.',
        bullets: [
          'Members show which source rows contribute to the cluster.',
          'Golden record rows show the value chosen for each attribute.',
          'Survivorship audit explains which strategy won and from where.',
        ],
        suggestedPrompts: [
          'Why did this source win for the name?',
          'How do I change survivorship for phone?',
          'Which attributes still look risky here?',
        ],
        focus:
          'Focus: golden record and survivorship. Explain why each chosen value won and what to edit if the user wants a different outcome.',
      };
    case 'hub':
    default:
      return {
        title: sharedTitle,
        summary: 'Bobsled Core Explorer Entity Graph hub - explain the flow',
        lead: 'Design once, resolve continuously. Bobsled Core Entity Graph standardizes records, scores candidates, and surfaces golden records across sources.',
        bullets: [
          'Design builds the YAML spec: sources, standardization, blocking, scoring, thresholds.',
          'Resolve runs the pipeline in DuckDB and routes ambiguous pairs to review.',
          'Clusters and survivorship produce the mastered entity for downstream use.',
        ],
        suggestedPrompts: [
          'Walk me through the Entity Graph flow.',
          'When should I start in Design versus Resolve?',
          'How do auto-merge and review thresholds work?',
        ],
        focus:
          'Focus: explain the overall Entity Graph mental model and steer the user to the next surface that best matches where they are in the workflow.',
      };
  }
}

export function getEntityGraphCtxTips(
  ctx: EntityGraphCtx,
  _scenarioValue?: EntityGraphScenarioId | string | null,
  _entityValue?: EntityGraphEntityId | string | null
): EntityGraphCtxTips {
  return buildDefaultTips(ctx);
}

export function deriveEntityGraphCtx(pathname: string, tab?: string | null): EntityGraphCtx {
  if (pathname.startsWith('/entity-graph/design')) return 'design';
  if (pathname.startsWith('/entity-graph/resolve/clusters/')) return 'resolve.cluster_detail';
  if (pathname.startsWith('/entity-graph/resolve')) {
    return tab === 'clusters' ? 'resolve.clusters' : 'resolve.queue';
  }
  return 'hub';
}

export function isValidEntityGraphCtx(v: unknown): v is EntityGraphCtx {
  return (
    v === 'hub' ||
    v === 'design' ||
    v === 'resolve.queue' ||
    v === 'resolve.clusters' ||
    v === 'resolve.cluster_detail'
  );
}
