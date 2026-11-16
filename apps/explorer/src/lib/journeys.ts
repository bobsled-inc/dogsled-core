import { buildTerminalHref } from './command-links.js';
import {
  buildPipelineRunArgs,
  buildPipelineRunCommands,
  type PipelineConfig,
} from './pipelineExport.js';
import { shellQuote } from './pipeline-export-content.js';

export interface JourneyStep {
  title: string;
  page: string;
  instruction: string;
  terminalCmd?: string;
  pipelinePreset?: string;
}

export interface Journey {
  id: string;
  title: string;
  description: string;
  estimatedMinutes: number;
  outcome: string;
  steps: JourneyStep[];
}

const SAAS_PIPELINE_CONFIG: PipelineConfig = {
  selectedIntegrations: ['stripe', 'hubspot', 'github'],
  resources: {
    stripe: ['customers', 'subscriptions', 'invoices'],
    hubspot: ['contacts', 'companies'],
    github: ['repositories', 'pull_requests'],
  },
  destination: { type: 'duckdb', db_path: './pipeline.duckdb' },
  schedule: 'every 4h',
};

const SAAS_PIPELINE_TERMINAL_COMMAND = buildPipelineRunCommands(SAAS_PIPELINE_CONFIG)
  .map(({ command, args }) => `dogsled ${command} ${args.map(shellQuote).join(' ')}`.trim())
  .join('\n');

export const FEATURED_JOURNEY_ID = 'saas-pipeline';

export const JOURNEYS: Journey[] = [
  {
    id: 'bobsled-overview',
    title: 'What can Dogsled do?',
    description: 'Take a fast product tour from the dashboard through a concrete Stripe example.',
    estimatedMinutes: 6,
    outcome: 'You will see how integrations, models, and guided exploration connect together.',
    steps: [
      {
        title: 'Start on the dashboard',
        page: '/',
        instruction: 'Scan the launchpad to understand the five core ways to explore Dogsled.',
      },
      {
        title: 'Browse integrations',
        page: '/integrations?category=payments',
        instruction:
          'Open the integrations catalog and narrow down to the connectors you would likely reach for first.',
      },
      {
        title: 'Inspect Stripe',
        page: '/integrations/stripe',
        instruction:
          'Review the Stripe resource list, auth setup, and incremental extraction hints.',
      },
      {
        title: 'Follow the model bundle',
        page: '/models/stripe',
        instruction:
          'Jump from the raw Stripe connector into the pre-built analytics bundle that sits on top of it.',
      },
    ],
  },
  {
    id: 'saas-pipeline',
    title: 'Build a SaaS Pipeline',
    description: 'Walk through a realistic Stripe + HubSpot + GitHub pipeline and run it locally.',
    estimatedMinutes: 12,
    outcome: 'You will build a DuckDB-backed SaaS pipeline and know where to inspect the results.',
    steps: [
      {
        title: 'Load the SaaS preset',
        page: '/pipelines/new?preset=saas-analytics&step=integrations',
        instruction:
          'Start from the SaaS Analytics preset so Stripe, HubSpot, and GitHub are already selected.',
        pipelinePreset: 'saas-analytics',
      },
      {
        title: 'Choose resources',
        page: '/pipelines/new?preset=saas-analytics&step=resources',
        instruction: 'Trim the preset to the resources you actually want to land in DuckDB.',
        pipelinePreset: 'saas-analytics',
      },
      {
        title: 'Pick DuckDB',
        page: '/pipelines/new?preset=saas-analytics&step=destination',
        instruction: 'Keep the destination local so you can inspect the output immediately.',
        pipelinePreset: 'saas-analytics',
      },
      {
        title: 'Review and export',
        page: '/pipelines/new?preset=saas-analytics&step=review',
        instruction:
          'Confirm the generated bobsled.yml and open the export options from the review step.',
        pipelinePreset: 'saas-analytics',
      },
      {
        title: 'Run the pipeline in Terminal',
        page: buildTerminalHref(buildPipelineRunArgs(SAAS_PIPELINE_CONFIG)),
        instruction:
          'Run the prefilled Stripe, HubSpot, and GitHub pipeline commands in sequence and watch the output stream land everything into DuckDB.',
        terminalCmd: SAAS_PIPELINE_TERMINAL_COMMAND,
      },
      {
        title: 'Query the results',
        page: '/data?db=./pipeline.duckdb',
        instruction: 'Open Data Preview against the DuckDB file and verify the landed tables.',
      },
    ],
  },
  {
    id: 'explore-models',
    title: 'Explore Models',
    description: 'Move from a bundle list into the DAG, compiled files, and source integration.',
    estimatedMinutes: 8,
    outcome: 'You will know how Dogsled bundles source, staging, and mart layers for a connector.',
    steps: [
      {
        title: 'Open the catalog',
        page: '/models',
        instruction:
          'Browse the available analytics bundles and spot the ones tied to connectors you already know.',
      },
      {
        title: 'Open the Stripe bundle',
        page: '/models/stripe',
        instruction:
          'Start with Stripe so you can compare the model graph to a familiar integration.',
      },
      {
        title: 'Browse the DAG',
        page: '/models/stripe?tab=overview',
        instruction:
          'Use the DAG overview to understand how source specs fan into staging and marts.',
      },
      {
        title: 'Inspect generated files',
        page: '/models/stripe?tab=files',
        instruction:
          'Read the generated SQL and YAML files to see how the bundle is actually composed.',
      },
      {
        title: 'Jump back to the integration',
        page: '/integrations/stripe',
        instruction:
          'Cross-reference the bundle with the underlying extraction resources and auth requirements.',
      },
    ],
  },
  {
    id: 'entity-resolution',
    title: 'Entity Resolution',
    description: 'Step through the full Entity Graph configurator from overview to generated YAML.',
    estimatedMinutes: 10,
    outcome: 'You will understand how Dogsled’s resolution pipeline is assembled stage by stage.',
    steps: [
      {
        title: 'Overview',
        page: '/entity-graph?step=overview',
        instruction: 'Read the eight-stage resolution flow before configuring anything.',
      },
      {
        title: 'Define the entity',
        page: '/entity-graph?step=entity',
        instruction: 'Set the entity name and description for the records you want to resolve.',
      },
      {
        title: 'Add input sources',
        page: '/entity-graph?step=inputs',
        instruction: 'List the tables or feeds that contribute records to the resolution job.',
      },
      {
        title: 'Standardize fields',
        page: '/entity-graph?step=standardize',
        instruction: 'Apply cleanup transforms so comparisons happen on normalized values.',
      },
      {
        title: 'Create blocking rules',
        page: '/entity-graph?step=blocking',
        instruction: 'Define how candidate pairs are generated before scoring begins.',
      },
      {
        title: 'Weight scoring features',
        page: '/entity-graph?step=scoring',
        instruction: 'Combine exact and fuzzy algorithms into a weighted score.',
      },
      {
        title: 'Set thresholds',
        page: '/entity-graph?step=thresholds',
        instruction: 'Route high-confidence pairs to auto-merge and ambiguous pairs to review.',
      },
      {
        title: 'Export the YAML',
        page: '/entity-graph?step=review',
        instruction:
          'Copy the generated resolution spec and use it as a starting point in the CLI.',
      },
    ],
  },
  {
    id: 'cli-power-user',
    title: 'CLI Power User',
    description: 'Use the embedded terminal to tour the highest-value Dogsled CLI entrypoints.',
    estimatedMinutes: 7,
    outcome: 'You will leave with a mental map of the CLI surface area and where to go next.',
    steps: [
      {
        title: 'List integrations',
        page: buildTerminalHref({ command: 'integrations', args: ['list'] }),
        instruction:
          'Start broad and confirm how to inspect the available connectors from the CLI.',
        terminalCmd: 'dogsled integrations list',
      },
      {
        title: 'Show Stripe',
        page: buildTerminalHref({ command: 'integrations', args: ['show', 'stripe'] }),
        instruction:
          'Inspect one connector deeply so you can see the resource and auth metadata the CLI exposes.',
        terminalCmd: 'dogsled integrations show stripe',
      },
      {
        title: 'Check extract help',
        page: buildTerminalHref({ command: 'extract', args: ['--help'] }),
        instruction: 'Jump to the extraction command surface and note the operational flags.',
        terminalCmd: 'dogsled extract --help',
      },
      {
        title: 'Describe setup catalog',
        page: buildTerminalHref({ command: 'setup', args: ['describe', '--json'] }),
        instruction:
          'Use the machine-readable setup catalog to understand how Dogsled exposes structured config.',
        terminalCmd: 'dogsled setup describe --json',
      },
    ],
  },
];

export function getJourneyById(id: string): Journey | undefined {
  return JOURNEYS.find((journey) => journey.id === id);
}
