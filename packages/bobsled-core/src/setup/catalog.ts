import { getIntegration, listIntegrations } from '@bobsled-inc/integrations';

import type {
  DestinationSetupMetadata,
  IntegrationSetupMetadata,
  SetupDescribePayload,
  SetupDestinationType,
  SetupPreset,
  SetupQuestion,
} from './types.js';

interface IntegrationOverride {
  plainLanguagePurpose?: string;
  bestFor?: string[];
  authDifficulty?: 'easy' | 'medium' | 'hard';
  requiresAdminAccess?: boolean;
  recommendedSchedule?: string;
  recommendedResources?: string[];
  setupPrerequisites?: string[];
  destinationFit?: SetupDestinationType[];
  estimatedSetupFriction?: 'low' | 'medium' | 'high';
  starterTemplateTags?: string[];
  keywords?: string[];
}

const INTEGRATION_OVERRIDES: Record<string, IntegrationOverride> = {
  stripe: {
    plainLanguagePurpose: 'Revenue, billing, subscription, and payment lifecycle reporting.',
    bestFor: ['SaaS revenue analytics', 'billing operations', 'MRR reporting'],
    recommendedSchedule: 'every 4h',
    recommendedResources: ['customers', 'subscriptions', 'invoices'],
    setupPrerequisites: ['Create a restricted Stripe secret key with read access to billing data.'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['stripe', 'payments', 'billing', 'subscriptions', 'checkout'],
  },
  hubspot: {
    plainLanguagePurpose: 'CRM, marketing funnel, lifecycle, and deal pipeline reporting.',
    bestFor: ['RevOps analytics', 'CRM reporting', 'marketing attribution'],
    authDifficulty: 'medium',
    requiresAdminAccess: true,
    recommendedSchedule: 'every 4h',
    recommendedResources: ['contacts', 'companies', 'deals'],
    setupPrerequisites: ['Create a HubSpot private app token with CRM read scopes.'],
    destinationFit: ['bigquery', 'snowflake', 'postgres'],
    keywords: ['hubspot', 'crm', 'contacts', 'deals', 'marketing'],
  },
  github: {
    plainLanguagePurpose: 'Engineering productivity, repository activity, and issue reporting.',
    bestFor: ['engineering analytics', 'repo activity', 'team delivery tracking'],
    recommendedSchedule: 'daily',
    recommendedResources: ['repositories', 'issues', 'pull_requests'],
    setupPrerequisites: ['Create a GitHub token or app installation with repo read access.'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['github', 'repos', 'pull requests', 'issues', 'engineering'],
  },
  linear: {
    plainLanguagePurpose: 'Product planning, issue health, cycle progress, and roadmap reporting.',
    bestFor: ['product operations', 'sprint reporting', 'issue analytics'],
    recommendedSchedule: 'every 4h',
    recommendedResources: ['issues', 'cycles', 'projects'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['linear', 'issues', 'cycles', 'sprints', 'product'],
  },
  notion: {
    plainLanguagePurpose: 'Workspace content, docs, and knowledge-base reporting.',
    bestFor: ['knowledge operations', 'workspace inventory', 'doc analytics'],
    authDifficulty: 'medium',
    recommendedSchedule: 'daily',
    recommendedResources: ['pages', 'databases', 'users'],
    destinationFit: ['bigquery', 'duckdb', 'local'],
    keywords: ['notion', 'docs', 'wiki', 'knowledge base'],
  },
  slack: {
    plainLanguagePurpose: 'Channel activity, workspace operations, and engagement reporting.',
    bestFor: ['workspace reporting', 'channel activity', 'internal operations'],
    authDifficulty: 'medium',
    requiresAdminAccess: true,
    recommendedSchedule: 'daily',
    recommendedResources: ['channels', 'messages', 'users'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['slack', 'messages', 'channels', 'workspace'],
  },
  google_ads: {
    plainLanguagePurpose: 'Paid search campaign, spend, and conversion reporting.',
    bestFor: ['ad spend reporting', 'marketing performance', 'campaign analytics'],
    authDifficulty: 'hard',
    requiresAdminAccess: true,
    recommendedSchedule: 'daily',
    recommendedResources: ['campaigns', 'ad_groups', 'ad_group_ads'],
    destinationFit: ['bigquery', 'snowflake', 's3'],
    keywords: ['google ads', 'adwords', 'campaigns', 'paid search'],
  },
  facebook_ads: {
    plainLanguagePurpose: 'Paid social spend, campaign, and creative performance reporting.',
    bestFor: ['ad spend reporting', 'paid social analytics', 'campaign analytics'],
    authDifficulty: 'hard',
    requiresAdminAccess: true,
    recommendedSchedule: 'daily',
    recommendedResources: ['campaigns', 'adsets', 'ads'],
    destinationFit: ['bigquery', 'snowflake', 's3'],
    keywords: ['facebook ads', 'meta ads', 'paid social'],
  },
  salesforce: {
    plainLanguagePurpose: 'Accounts, pipeline, opportunities, and sales reporting.',
    bestFor: ['enterprise CRM reporting', 'pipeline analytics', 'sales operations'],
    authDifficulty: 'hard',
    requiresAdminAccess: true,
    recommendedSchedule: 'every 4h',
    recommendedResources: ['accounts', 'contacts', 'opportunities'],
    destinationFit: ['bigquery', 'snowflake', 'postgres'],
    keywords: ['salesforce', 'crm', 'accounts', 'opportunities'],
  },
  jira: {
    plainLanguagePurpose: 'Ticket flow, sprint progress, and engineering delivery reporting.',
    bestFor: ['ticket analytics', 'project delivery tracking', 'support engineering metrics'],
    authDifficulty: 'medium',
    recommendedSchedule: 'every 4h',
    recommendedResources: ['projects', 'issues', 'sprints'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['jira', 'tickets', 'projects', 'sprints'],
  },
  zendesk: {
    plainLanguagePurpose: 'Support ticket, SLA, and help-center reporting.',
    bestFor: ['support operations', 'ticket health', 'customer support analytics'],
    authDifficulty: 'medium',
    recommendedSchedule: 'every 4h',
    recommendedResources: ['tickets', 'users', 'ticket_metrics'],
    destinationFit: ['bigquery', 'snowflake', 'postgres'],
    keywords: ['zendesk', 'support', 'tickets', 'help center'],
  },
  intercom: {
    plainLanguagePurpose:
      'Support conversations, teammate activity, and customer engagement reporting.',
    bestFor: ['support analytics', 'customer messaging', 'conversation reporting'],
    authDifficulty: 'medium',
    recommendedSchedule: 'every 4h',
    recommendedResources: ['conversations', 'contacts', 'admins'],
    destinationFit: ['bigquery', 'snowflake', 'postgres'],
    keywords: ['intercom', 'support', 'conversations', 'customers'],
  },
  quickbooks: {
    plainLanguagePurpose: 'Accounting, invoice, and finance operations reporting.',
    bestFor: ['finance operations', 'invoice reporting', 'accounting analytics'],
    authDifficulty: 'hard',
    recommendedSchedule: 'daily',
    recommendedResources: ['customers', 'invoices', 'payments'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['quickbooks', 'accounting', 'invoices', 'finance'],
  },
  vantage: {
    plainLanguagePurpose: 'Cloud cost, commitment, and FinOps reporting.',
    bestFor: ['cloud cost reporting', 'finops reviews', 'budget tracking'],
    recommendedSchedule: 'daily',
    recommendedResources: ['costs', 'financial_commitments', 'budgets'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['vantage', 'cloud costs', 'finops', 'aws costs'],
  },
  shopify: {
    plainLanguagePurpose: 'Store, order, and ecommerce reporting.',
    bestFor: ['ecommerce analytics', 'order reporting', 'store operations'],
    authDifficulty: 'medium',
    recommendedSchedule: 'every 4h',
    recommendedResources: ['orders', 'customers', 'products'],
    destinationFit: ['bigquery', 'snowflake', 'duckdb'],
    keywords: ['shopify', 'store', 'orders', 'ecommerce'],
  },
};

const DESTINATIONS: DestinationSetupMetadata[] = [
  {
    type: 'bigquery',
    displayName: 'BigQuery',
    plainLanguagePurpose: 'Managed analytics warehouse for shared reporting.',
    bestFor: ['central analytics', 'BI dashboards', 'shared warehouse reporting'],
    setupPrerequisites: [
      'Pick a Google Cloud project and dataset.',
      'Create a service account key.',
    ],
    requiredFields: ['project', 'dataset'],
    defaultSchedule: 'every 4h',
    secretRefs: [
      {
        name: 'GCP_SERVICE_ACCOUNT_JSON',
        location: 'env_var',
        status: 'missing',
        description: 'BigQuery service account key JSON',
      },
    ],
  },
  {
    type: 'duckdb',
    displayName: 'DuckDB',
    plainLanguagePurpose: 'Local zero-infra warehouse for prototypes and small teams.',
    bestFor: ['local development', 'quick demos', 'single-user analytics'],
    setupPrerequisites: ['Choose where the local database file should live.'],
    requiredFields: ['db_path'],
    defaultSchedule: 'daily',
    secretRefs: [],
  },
  {
    type: 'snowflake',
    displayName: 'Snowflake',
    plainLanguagePurpose: 'Enterprise cloud warehouse for governed analytics.',
    bestFor: ['enterprise analytics', 'multi-team reporting', 'governed data access'],
    setupPrerequisites: [
      'Collect Snowflake account, warehouse, database, and a password or keypair.',
    ],
    requiredFields: ['account', 'username', 'warehouse', 'database'],
    defaultSchedule: 'every 4h',
    secretRefs: [
      {
        name: 'SNOWFLAKE_PASSWORD',
        location: 'env_var',
        status: 'missing',
        description: 'Snowflake password for the Bobsled Core user',
      },
    ],
  },
  {
    type: 'postgres',
    displayName: 'Postgres',
    plainLanguagePurpose: 'Operational analytics destination for smaller warehouse needs.',
    bestFor: ['internal apps', 'reverse ETL adjacent workflows', 'simple hosted analytics'],
    setupPrerequisites: ['Collect host, database, username, and password.'],
    requiredFields: ['host', 'database', 'username'],
    defaultSchedule: 'every 4h',
    secretRefs: [
      {
        name: 'PG_PASSWORD',
        location: 'env_var',
        status: 'missing',
        description: 'Postgres password for the Bobsled Core user',
      },
    ],
  },
  {
    type: 'clickhouse',
    displayName: 'ClickHouse',
    plainLanguagePurpose: 'Column-oriented OLAP database for fast analytical queries.',
    bestFor: ['high-volume analytics', 'event data', 'low-latency OLAP queries'],
    setupPrerequisites: ['Collect the ClickHouse host, port, and database name.'],
    requiredFields: ['host', 'database'],
    defaultSchedule: 'every 4h',
    secretRefs: [
      {
        name: 'CLICKHOUSE_PASSWORD',
        location: 'env_var',
        status: 'missing',
        description: 'ClickHouse password for the Bobsled Core user',
      },
    ],
  },
  {
    type: 'turbopuffer',
    displayName: 'Turbopuffer',
    plainLanguagePurpose: 'Serverless vector and full-text search store for embeddings.',
    bestFor: ['semantic search', 'RAG retrieval', 'embedding-powered analytics'],
    setupPrerequisites: ['Create a Turbopuffer API key and choose a region.'],
    requiredFields: ['api_key'],
    defaultSchedule: 'every 4h',
    secretRefs: [
      {
        name: 'TURBOPUFFER_API_KEY',
        location: 'env_var',
        status: 'missing',
        description: 'Turbopuffer API key',
      },
    ],
  },
  {
    type: 'local',
    displayName: 'Local Files',
    plainLanguagePurpose: 'Parquet, JSONL, or CSV files written directly into the repo workspace.',
    bestFor: ['simple exports', 'file handoff', 'local inspection'],
    setupPrerequisites: ['Pick the file format.'],
    requiredFields: ['format'],
    defaultSchedule: 'daily',
    secretRefs: [],
  },
  {
    type: 's3',
    displayName: 'S3',
    plainLanguagePurpose: 'Analytics file lake in AWS object storage.',
    bestFor: ['lakehouse staging', 'downstream ELT', 'cross-tool file delivery'],
    setupPrerequisites: ['Pick the S3 bucket and prefix.'],
    requiredFields: ['bucket'],
    defaultSchedule: 'daily',
    secretRefs: [
      {
        name: 'AWS_ACCESS_KEY_ID',
        location: 'env_var',
        status: 'missing',
        description: 'AWS access key for S3 writes',
      },
      {
        name: 'AWS_SECRET_ACCESS_KEY',
        location: 'env_var',
        status: 'missing',
        description: 'AWS secret key for S3 writes',
      },
    ],
  },
  {
    type: 'gcs',
    displayName: 'GCS',
    plainLanguagePurpose: 'Analytics file lake in Google Cloud Storage.',
    bestFor: ['lakehouse staging', 'file delivery', 'Google Cloud-native storage'],
    setupPrerequisites: [
      'Pick the GCS bucket and prefix.',
      'Create a Google Cloud service account key.',
    ],
    requiredFields: ['bucket'],
    defaultSchedule: 'daily',
    secretRefs: [
      {
        name: 'GCP_SERVICE_ACCOUNT_JSON',
        location: 'env_var',
        status: 'missing',
        description: 'GCS service account key JSON',
      },
    ],
  },
];

const PRESETS: SetupPreset[] = [
  {
    id: 'saas-analytics',
    displayName: 'SaaS Analytics',
    description: 'Product, revenue, and growth reporting for SaaS teams.',
    keywords: ['saas', 'revenue', 'subscriptions', 'mrr', 'product analytics'],
    recommendedIntegrations: ['stripe', 'hubspot', 'github'],
    defaultDestination: 'bigquery',
    defaultSchedule: 'every 4h',
  },
  {
    id: 'crm-revops',
    displayName: 'CRM RevOps',
    description: 'CRM, pipeline, and GTM reporting for revenue teams.',
    keywords: ['crm', 'revops', 'sales', 'pipeline', 'marketing ops'],
    recommendedIntegrations: ['hubspot', 'salesforce', 'stripe'],
    defaultDestination: 'bigquery',
    defaultSchedule: 'every 4h',
  },
  {
    id: 'ad-spend',
    displayName: 'Ad Spend',
    description: 'Paid media spend and campaign performance reporting.',
    keywords: ['ads', 'ad spend', 'paid media', 'campaigns', 'marketing'],
    recommendedIntegrations: ['google_ads', 'facebook_ads', 'hubspot'],
    defaultDestination: 'bigquery',
    defaultSchedule: 'daily',
  },
  {
    id: 'support-ops',
    displayName: 'Support Ops',
    description: 'Support health, ticket flow, and customer experience reporting.',
    keywords: ['support', 'tickets', 'customer success', 'sla', 'help desk'],
    recommendedIntegrations: ['zendesk', 'intercom', 'slack'],
    defaultDestination: 'postgres',
    defaultSchedule: 'every 4h',
  },
  {
    id: 'finance-ops',
    displayName: 'Finance Ops',
    description: 'Accounting, billing, spend, and cloud cost reporting.',
    keywords: ['finance', 'accounting', 'billing', 'cloud cost', 'finops'],
    recommendedIntegrations: ['stripe', 'quickbooks', 'vantage'],
    defaultDestination: 'bigquery',
    defaultSchedule: 'daily',
  },
];

const QUESTIONS: SetupQuestion[] = [
  {
    id: 'goal',
    field: 'goals.summary',
    prompt: 'What business outcome do you want this repo to deliver?',
    recommended: 'Describe the source tools, destination, and cadence in one sentence.',
  },
  {
    id: 'repo-state',
    field: 'project.repo_state',
    prompt: 'Is this a brand new repo or an existing repo?',
    recommended: 'new',
  },
  {
    id: 'sources',
    field: 'sources',
    prompt: 'Which systems should Bobsled Core sync data from first?',
    recommended: 'Start with 2-3 systems you use every day.',
  },
  {
    id: 'destination',
    field: 'destination.type',
    prompt: 'Where should the data land?',
    recommended: 'Accept the recommended destination unless you already have a warehouse standard.',
  },
  {
    id: 'credentials',
    field: 'credentials.required_secret_refs',
    prompt: 'Which credentials are still missing?',
    recommended: 'Store only secret references or placeholders, never raw values.',
  },
];

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function guessAuthDifficulty(secretCount: number, tags: string[]): 'easy' | 'medium' | 'hard' {
  if (secretCount >= 3) return 'hard';
  if (tags.some((tag) => ['oauth', 'enterprise', 'ads'].includes(tag))) return 'hard';
  if (secretCount === 2) return 'medium';
  return 'easy';
}

function guessRequiresAdminAccess(tags: string[]): boolean {
  return tags.some((tag) =>
    ['ads', 'crm', 'workspace', 'enterprise', 'support'].includes(tag.toLowerCase())
  );
}

function guessSchedule(category: string): string {
  if (category === 'ads' || category === 'support') return 'every 4h';
  if (category === 'finance') return 'daily';
  return 'daily';
}

function guessDestinationFit(category: string): SetupDestinationType[] {
  if (category === 'ads') return ['bigquery', 'snowflake', 's3'];
  if (category === 'crm' || category === 'sales') return ['bigquery', 'snowflake', 'postgres'];
  if (category === 'support') return ['bigquery', 'postgres', 'snowflake'];
  if (category === 'finance') return ['bigquery', 'snowflake', 'duckdb'];
  return ['bigquery', 'duckdb', 'snowflake'];
}

function guessFriction(authDifficulty: 'easy' | 'medium' | 'hard'): 'low' | 'medium' | 'high' {
  if (authDifficulty === 'hard') return 'high';
  if (authDifficulty === 'medium') return 'medium';
  return 'low';
}

export function getDestinationCatalog(): DestinationSetupMetadata[] {
  return DESTINATIONS;
}

export function getSetupPresets(): SetupPreset[] {
  return PRESETS;
}

export function buildIntegrationSetupCatalog(): IntegrationSetupMetadata[] {
  return listIntegrations()
    .map((summary) => {
      const integration = getIntegration(summary.name);
      const override = INTEGRATION_OVERRIDES[summary.name] ?? {};
      // `auth_setup` is optional (self-describing custom_api sources declare
      // their env vars inline in source.yml instead), so default to [].
      const authSetup = integration.meta.auth_setup ?? [];
      const authDifficulty =
        override.authDifficulty ?? guessAuthDifficulty(authSetup.length, summary.tags);

      return {
        name: summary.name,
        displayName: summary.display_name,
        category: summary.category,
        tags: summary.tags,
        docsUrl: integration.meta.docs_url,
        resourceCount: summary.resource_count,
        integrationType: summary.integration_type,
        plainLanguagePurpose:
          override.plainLanguagePurpose ??
          `Sync ${summary.display_name} data into Bobsled Core for reporting and automation.`,
        bestFor: override.bestFor ?? [
          `${summary.display_name} reporting`,
          `${summary.category} analytics`,
        ],
        authDifficulty,
        requiresAdminAccess: override.requiresAdminAccess ?? guessRequiresAdminAccess(summary.tags),
        recommendedSchedule: override.recommendedSchedule ?? guessSchedule(summary.category),
        recommendedResources:
          override.recommendedResources ?? integration.resource_names.slice(0, 3),
        setupPrerequisites: override.setupPrerequisites ?? [
          `Create or locate a ${summary.display_name} credential with read access.`,
        ],
        secretLabels: authSetup.map((entry) => entry.env),
        secretInstructions:
          override.setupPrerequisites ??
          authSetup.map((entry) => `${entry.env}: ${entry.description}`),
        destinationFit: override.destinationFit ?? guessDestinationFit(summary.category),
        estimatedSetupFriction: override.estimatedSetupFriction ?? guessFriction(authDifficulty),
        starterTemplateTags: override.starterTemplateTags ?? summary.tags.slice(0, 4),
        keywords: unique([
          summary.name,
          summary.display_name.toLowerCase(),
          ...summary.tags.map((tag) => tag.toLowerCase()),
          ...(override.keywords ?? []),
        ]),
        authSetup: authSetup.map((entry) => ({
          env: entry.env,
          description: entry.description,
          docsUrl: entry.docs_url,
        })),
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function buildSetupDescribePayload(): SetupDescribePayload {
  return {
    version: 1,
    questionnaire: QUESTIONS,
    integrations: buildIntegrationSetupCatalog(),
    destinations: getDestinationCatalog(),
    presets: getSetupPresets(),
    defaults: {
      schedule: 'daily',
      repoState: 'new',
    },
    validationRules: {
      'project.repo_name': 'Should be a short Git-friendly slug.',
      'goals.summary': 'Describe sources, destination, and cadence in plain English.',
      sources: 'Pick at least one integration.',
      destination: 'Pick one supported destination and fill its required fields.',
      credentials:
        'Persist only secret references or placeholders, never raw secret values in repo files.',
    },
  };
}
