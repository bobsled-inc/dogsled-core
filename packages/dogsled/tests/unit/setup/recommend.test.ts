import { describe, expect, it } from 'vitest';

import { recommendSetup } from '../../../src/setup/recommend.js';
import { SetupAnswersSchema } from '../../../src/setup/types.js';

import type {
  DestinationSetupMetadata,
  IntegrationSetupMetadata,
  SetupAnswers,
  SetupPreset,
} from '../../../src/setup/types.js';

const integrations: IntegrationSetupMetadata[] = [
  {
    name: 'stripe',
    displayName: 'Stripe',
    category: 'finance',
    tags: ['payments'],
    resourceCount: 3,
    integrationType: 'api',
    plainLanguagePurpose: 'Billing analytics',
    bestFor: ['finance'],
    authDifficulty: 'easy',
    requiresAdminAccess: false,
    recommendedSchedule: 'every 4h',
    recommendedResources: ['customers', 'subscriptions'],
    setupPrerequisites: ['Create a Stripe key'],
    secretLabels: ['STRIPE_API_KEY'],
    secretInstructions: ['STRIPE_API_KEY: Stripe secret key'],
    destinationFit: ['bigquery', 'duckdb'],
    estimatedSetupFriction: 'low',
    starterTemplateTags: ['finance'],
    keywords: ['stripe', 'billing', 'payments'],
    authSetup: [{ env: 'STRIPE_API_KEY', description: 'Stripe secret key' }],
  },
  {
    name: 'smartlead',
    displayName: 'Smartlead',
    category: 'sales',
    tags: ['outbound'],
    resourceCount: 4,
    integrationType: 'api',
    plainLanguagePurpose: 'Outbound sales analytics',
    bestFor: ['revops'],
    authDifficulty: 'easy',
    requiresAdminAccess: false,
    recommendedSchedule: 'daily',
    recommendedResources: ['campaigns'],
    setupPrerequisites: ['Create a Smartlead API key'],
    secretLabels: ['SMARTLEAD_API_KEY'],
    secretInstructions: ['SMARTLEAD_API_KEY: Smartlead API key'],
    destinationFit: ['bigquery', 'duckdb'],
    estimatedSetupFriction: 'low',
    starterTemplateTags: ['revops'],
    keywords: ['smartlead', 'outbound', 'sales'],
    authSetup: [{ env: 'SMARTLEAD_API_KEY', description: 'Smartlead API key' }],
  },
  {
    name: 'hubspot',
    displayName: 'HubSpot',
    category: 'crm',
    tags: ['crm'],
    resourceCount: 3,
    integrationType: 'api',
    plainLanguagePurpose: 'CRM analytics',
    bestFor: ['revops'],
    authDifficulty: 'medium',
    requiresAdminAccess: true,
    recommendedSchedule: 'every 4h',
    recommendedResources: ['contacts', 'deals'],
    setupPrerequisites: ['Create a HubSpot private app'],
    secretLabels: ['HUBSPOT_ACCESS_TOKEN'],
    secretInstructions: ['HUBSPOT_ACCESS_TOKEN: HubSpot token'],
    destinationFit: ['bigquery', 'postgres'],
    estimatedSetupFriction: 'medium',
    starterTemplateTags: ['crm'],
    keywords: ['hubspot', 'crm', 'deals'],
    authSetup: [{ env: 'HUBSPOT_ACCESS_TOKEN', description: 'HubSpot private app token' }],
  },
  {
    name: 'pylon',
    displayName: 'Pylon',
    category: 'support',
    tags: ['support'],
    resourceCount: 2,
    integrationType: 'api',
    plainLanguagePurpose: 'Customer support analytics',
    bestFor: ['revops'],
    authDifficulty: 'easy',
    requiresAdminAccess: false,
    recommendedSchedule: 'daily',
    recommendedResources: ['tickets'],
    setupPrerequisites: ['Create a Pylon API token'],
    secretLabels: ['PYLON_API_TOKEN'],
    secretInstructions: ['PYLON_API_TOKEN: Pylon API token'],
    destinationFit: ['bigquery', 'duckdb'],
    estimatedSetupFriction: 'low',
    starterTemplateTags: ['revops'],
    keywords: ['pylon', 'support', 'tickets'],
    authSetup: [{ env: 'PYLON_API_TOKEN', description: 'Pylon API token' }],
  },
  {
    name: 'bigquery',
    displayName: 'BigQuery (MCP)',
    category: 'analytics',
    tags: ['data-warehouse', 'sql', 'mcp'],
    resourceCount: 1,
    integrationType: 'mcp',
    plainLanguagePurpose: 'BigQuery SQL source',
    bestFor: ['warehouse extraction'],
    authDifficulty: 'hard',
    requiresAdminAccess: true,
    recommendedSchedule: 'daily',
    recommendedResources: ['query'],
    setupPrerequisites: ['Configure BigQuery credentials'],
    secretLabels: ['BIGQUERY_PROJECT_ID'],
    secretInstructions: ['BIGQUERY_PROJECT_ID: BigQuery project'],
    destinationFit: ['duckdb'],
    estimatedSetupFriction: 'high',
    starterTemplateTags: ['warehouse'],
    keywords: ['bigquery', 'google bigquery', 'warehouse'],
    authSetup: [{ env: 'BIGQUERY_PROJECT_ID', description: 'BigQuery project' }],
  },
];

const destinations: DestinationSetupMetadata[] = [
  {
    type: 'bigquery',
    displayName: 'BigQuery',
    plainLanguagePurpose: 'Warehouse',
    bestFor: ['analytics'],
    setupPrerequisites: ['Pick a project'],
    requiredFields: ['project', 'dataset'],
    defaultSchedule: 'every 4h',
    secretRefs: [
      {
        name: 'GCP_SERVICE_ACCOUNT_JSON',
        location: 'env_var',
        status: 'missing',
        description: 'BigQuery key',
      },
    ],
  },
];

const presets: SetupPreset[] = [
  {
    id: 'saas-analytics',
    displayName: 'SaaS Analytics',
    description: 'Revenue analytics',
    keywords: ['revenue', 'saas'],
    recommendedIntegrations: ['stripe', 'hubspot'],
    defaultDestination: 'bigquery',
    defaultSchedule: 'every 4h',
  },
  {
    id: 'crm-revops',
    displayName: 'CRM RevOps',
    description: 'CRM and support analytics',
    keywords: ['smartlead', 'pylon', 'crm', 'revops'],
    recommendedIntegrations: ['smartlead', 'pylon', 'hubspot', 'stripe'],
    defaultDestination: 'bigquery',
    defaultSchedule: 'daily',
  },
];

type SetupAnswersOverrides = Partial<
  Omit<SetupAnswers, 'project' | 'goals' | 'credentials' | 'status'>
> & {
  project?: Partial<SetupAnswers['project']>;
  goals?: Partial<SetupAnswers['goals']>;
  credentials?: Partial<SetupAnswers['credentials']>;
  status?: Partial<SetupAnswers['status']>;
};

function makeAnswers(overrides: SetupAnswersOverrides = {}): SetupAnswers {
  return SetupAnswersSchema.parse({
    project: {
      repo_state: 'new',
      ...overrides.project,
    },
    goals: {
      ...overrides.goals,
    },
    sources: overrides.sources ?? [],
    destination: overrides.destination,
    credentials: {
      required_secret_refs: [],
      ...overrides.credentials,
    },
    status: {
      missing_items: [],
      ...overrides.status,
    },
  });
}

describe('recommendSetup', () => {
  it('detects integrations, destination, and schedule from a plain-English goal', () => {
    const recommendation = recommendSetup({
      goal: 'Sync Stripe and HubSpot into BigQuery every 4 hours.',
      integrations,
      destinations,
      presets,
    });

    expect(recommendation.preset.id).toBe('saas-analytics');
    expect(recommendation.sources.map((source) => source.integration)).toEqual([
      'stripe',
      'hubspot',
    ]);
    expect(recommendation.destination.type).toBe('bigquery');
    expect(recommendation.sources[0]?.schedule).toBe('every 4h');
    expect(recommendation.credentialRefs.map((ref) => ref.name)).toEqual([
      'STRIPE_API_KEY',
      'HUBSPOT_ACCESS_TOKEN',
      'GCP_SERVICE_ACCOUNT_JSON',
    ]);
  });

  it('preserves explicit answers over inferred values', () => {
    const answers = makeAnswers({
      project: {
        repo_name: 'revops-pipelines',
        repo_state: 'existing',
      },
      goals: {
        summary: 'Sync billing data',
      },
      sources: [
        {
          integration: 'stripe',
          enabled: true,
          schedule: 'daily',
        },
      ],
      destination: {
        type: 'bigquery',
        project: 'acme-analytics',
        dataset: 'warehouse',
      },
      credentials: {
        required_secret_refs: [
          {
            name: 'STRIPE_API_KEY',
            location: 'env_var',
            status: 'configured',
          },
        ],
      },
      status: {
        missing_items: [],
      },
    });

    const recommendation = recommendSetup({
      answers,
      integrations,
      destinations,
      presets,
    });

    expect(recommendation.repoName).toBe('revops-pipelines');
    expect(recommendation.sources).toEqual([
      {
        integration: 'stripe',
        enabled: true,
        schedule: 'daily',
        resources: undefined,
      },
    ]);
    expect(recommendation.destination.project).toBe('acme-analytics');
    expect(recommendation.credentialRefs.find((ref) => ref.name === 'STRIPE_API_KEY')?.status).toBe(
      'configured'
    );
  });

  it('uses only explicit sources for credentials when answers.sources is populated', () => {
    const answers = makeAnswers({
      project: { repo_name: 'gtm-quick-pipeline', repo_state: 'new' },
      goals: { summary: 'smartlead and pylon data to bigquery', preset: 'crm-revops' },
      sources: [
        { integration: 'smartlead', enabled: true, schedule: 'daily' },
        { integration: 'pylon', enabled: true, schedule: 'daily' },
      ],
      destination: { type: 'bigquery', project: 'my-project', dataset: 'raw' },
      credentials: { required_secret_refs: [] },
      status: { missing_items: [] },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });

    const secretNames = result.credentialRefs.map((ref) => ref.name);
    expect(secretNames).toContain('SMARTLEAD_API_KEY');
    expect(secretNames).toContain('PYLON_API_TOKEN');
    expect(secretNames).toContain('GCP_SERVICE_ACCOUNT_JSON');
    expect(secretNames).not.toContain('HUBSPOT_ACCESS_TOKEN');
    expect(secretNames).not.toContain('STRIPE_API_KEY');
  });

  it('ignores disabled explicit sources when computing credential refs', () => {
    const answers = makeAnswers({
      project: { repo_name: 'gtm-quick-pipeline', repo_state: 'new' },
      goals: { summary: 'smartlead and pylon data to bigquery', preset: 'crm-revops' },
      sources: [
        { integration: 'smartlead', enabled: false, schedule: 'daily' },
        { integration: 'pylon', enabled: true, schedule: 'daily' },
      ],
      destination: { type: 'bigquery', project: 'my-project', dataset: 'raw' },
      credentials: { required_secret_refs: [] },
      status: { missing_items: [] },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });
    const secretNames = result.credentialRefs.map((ref) => ref.name);

    expect(secretNames).toContain('PYLON_API_TOKEN');
    expect(secretNames).toContain('GCP_SERVICE_ACCOUNT_JSON');
    expect(secretNames).not.toContain('SMARTLEAD_API_KEY');
  });

  it('extracts explicit repo name from goal text', () => {
    const answers = makeAnswers({
      goals: { summary: 'I want a new repo called gtm-quick-pipeline with stripe data' },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });
    expect(result.repoName).toBe('gtm-quick-pipeline');
  });

  it('slugifies multi-word repo names mentioned in natural language', () => {
    const answers = makeAnswers({
      goals: { summary: 'Please create a project named "GTM Quick Pipeline" for stripe data' },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });
    expect(result.repoName).toBe('gtm-quick-pipeline');
  });

  it('keeps explicit quoted repo names when the goal continues with a conjunction', () => {
    const answers = makeAnswers({
      goals: { summary: 'Please create a project named "GTM Quick Pipeline" and sync stripe data' },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });
    expect(result.repoName).toBe('gtm-quick-pipeline');
  });

  it('falls back to the derived repo name when the explicit repo phrase slugifies to empty', () => {
    const answers = makeAnswers({
      goals: { summary: 'Please create a repo called "你好"' },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });
    expect(result.repoName).toBe('stripe-hubspot-please-create-a-repo');
  });

  it('ignores incidental called phrasing that is not about a repo or project', () => {
    const answers = makeAnswers({
      goals: { summary: 'Sync Stripe data for a customer called Acme Corp.' },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });

    expect(result.repoName).not.toBe('acme-corp');
    expect(result.repoName).toMatch(/^stripe-/);
  });

  it('does not override an explicit project.repo_name with goal-text detection', () => {
    const answers = makeAnswers({
      project: { repo_name: 'my-custom-name', repo_state: 'new' },
      goals: { summary: 'I want a repo called something-else' },
    });

    const result = recommendSetup({ answers, integrations, destinations, presets });
    expect(result.repoName).toBe('my-custom-name');
  });
});
