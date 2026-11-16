export const CUSTOMER_RESOLUTION_STEPS = [
  { key: 'overview', label: 'Overview' },
  { key: 'sources', label: 'Sources' },
  { key: 'spec', label: 'Spec' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'verify', label: 'Verify' },
] as const;

export type CustomerResolutionStep = (typeof CUSTOMER_RESOLUTION_STEPS)[number]['key'];
export type CustomerResolutionStepEntry = (typeof CUSTOMER_RESOLUTION_STEPS)[number];

export interface PipelineSubStep {
  label: string;
  command: string;
  explanation: string;
  artifact?: string;
}

export const PIPELINE_SUBSTEPS: readonly PipelineSubStep[] = [
  {
    label: 'Validate specs',
    command: [
      'bobsled model resolve validate customer --dialect duckdb',
      'bobsled model survivorship validate customer --dialect duckdb',
      'bobsled model truthset validate customer',
    ].join('\n'),
    explanation:
      'Validate seeds, resolution, survivorship, and truthset assets before writing anything to the warehouse.',
    artifact: 'review/artifacts/01-*-validate.json',
  },
  {
    label: 'Load seed data',
    command: 'bobsled model seed load --runner ./runner.duckdb.js --dialect duckdb',
    explanation:
      'Create the raw.* source tables from committed CSV seeds so both DuckDB and BigQuery start from the same synthetic inputs.',
    artifact: 'review/artifacts/02-seed-load.json',
  },
  {
    label: 'Run resolution',
    command: 'bobsled model resolve run customer --runner ./runner.duckdb.js --dialect duckdb',
    explanation:
      'Build standardized rows, blocking pairs, scored pairs, and the review queue up through threshold routing.',
    artifact: 'entity_graph_test.customer__scored_pairs, entity_graph_test.customer__review_queue',
  },
  {
    label: 'Inspect resolve status',
    command: 'bobsled model resolve status customer --runner ./runner.duckdb.js --dialect duckdb',
    explanation:
      'Confirm that the early-stage runtime tables are populated before any review decisions are applied.',
  },
  {
    label: 'Agent triage',
    command: 'bobsled model agent triage customer --runner ./runner.duckdb.js --dialect duckdb',
    explanation:
      'Ask the bounded agent workflow what the next action should be based on the live review queue and truthset posture.',
  },
  {
    label: 'Propose agent decisions',
    command: [
      'bobsled model agent review-batch --entity customer \\',
      '  --runner ./runner.duckdb.js --mode propose \\',
      '  --output-bundle review/customer_agent_bundle.yml \\',
      '  --dialect duckdb',
    ].join('\n'),
    explanation:
      'Generate a review bundle for the agent-review band without mutating warehouse state yet.',
    artifact: 'review/customer_agent_bundle.yml',
  },
  {
    label: 'Apply decisions and cluster',
    command: [
      'bobsled model review apply --input review/customer_agent_bundle.yml \\',
      '  --entity customer --runner ./runner.duckdb.js --dialect duckdb',
      'bobsled model resolve cluster customer --runner ./runner.duckdb.js --dialect duckdb',
    ].join('\n'),
    explanation:
      'Apply the proposed review bundle, run clustering, then measure distinct clusters from the live warehouse.',
    artifact: 'entity_graph_test.customer__clusters',
  },
  {
    label: 'Run survivorship',
    command: [
      'bobsled model agent survivorship-refresh customer \\',
      '  --runner ./runner.duckdb.js --dialect duckdb',
    ].join('\n'),
    explanation:
      'Refresh the golden-record outputs after clustering so each cluster has source-prioritized customer attributes.',
    artifact: 'entity_graph_test.customer__golden_record',
  },
  {
    label: 'Regress truthset',
    command: [
      'bobsled model agent truthset-regress customer \\',
      '  --runner ./runner.duckdb.js --dialect duckdb',
    ].join('\n'),
    explanation:
      'Score the committed truthset labels against current pair scores so threshold quality stays measurable.',
  },
];

const CUSTOMER_RESOLUTION_STEP_KEYS: ReadonlySet<string> = new Set(
  CUSTOMER_RESOLUTION_STEPS.map((step) => step.key)
);

export function isCustomerResolutionStep(value: string | null): value is CustomerResolutionStep {
  return value !== null && CUSTOMER_RESOLUTION_STEP_KEYS.has(value);
}
