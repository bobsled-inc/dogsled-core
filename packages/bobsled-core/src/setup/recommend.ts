import { parse, stringify } from 'yaml';

import { CommandError } from '@bobsled-inc/protocol';

import { readFileSync, writeFileSync } from 'node:fs';

import { buildIntegrationSetupCatalog, getDestinationCatalog, getSetupPresets } from './catalog.js';
import { SetupAnswersSchema } from './types.js';

import type {
  DestinationSetupMetadata,
  IntegrationSetupMetadata,
  SetupAnswers,
  SetupDestination,
  SetupDestinationType,
  SetupPreset,
  SetupRecommendation,
  SetupSecretRef,
  SetupSource,
} from './types.js';

/** Convert free-form text into a Bobsled Core-safe repo slug. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Deduplicate an array while preserving first-seen order. */
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Infer a recommended schedule from natural-language setup goals. */
function detectSchedule(goal: string, fallback: string): string {
  const normalized = goal.toLowerCase();
  const everyHoursMatch = normalized.match(/every\s+(\d+)\s*h(?:ours?)?/);
  if (everyHoursMatch?.[1]) {
    return `every ${everyHoursMatch[1]}h`;
  }
  const everyWordHoursMatch = normalized.match(/every\s+(\d+)\s+hours?/);
  if (everyWordHoursMatch?.[1]) {
    return `every ${everyWordHoursMatch[1]}h`;
  }
  if (normalized.includes('hourly') || normalized.includes('every hour')) {
    return 'hourly';
  }
  if (normalized.includes('every 4 hours') || normalized.includes('every four hours')) {
    return 'every 4h';
  }
  if (normalized.includes('weekly')) {
    return 'weekly';
  }
  if (normalized.includes('daily')) {
    return 'daily';
  }
  return fallback;
}

/** Pick the best preset based on keyword overlap with the goal text. */
function detectPreset(goal: string, presets: SetupPreset[]): SetupPreset {
  const normalized = goal.toLowerCase();
  const scored = presets
    .map((preset) => ({
      preset,
      score: preset.keywords.filter((keyword) => normalized.includes(keyword)).length,
    }))
    .sort((left, right) => right.score - left.score);
  return scored[0]?.score ? scored[0].preset : presets[0]!;
}

/** Infer the target destination from the goal or preset defaults. */
function detectDestination(
  goal: string,
  preset: SetupPreset,
  destinations: DestinationSetupMetadata[]
): DestinationSetupMetadata {
  const normalized = goal.toLowerCase();
  const explicit =
    destinations.find((destination) => normalized.includes(destination.type)) ??
    (normalized.includes('google cloud') || normalized.includes('warehouse')
      ? destinations.find((destination) => destination.type === 'bigquery')
      : undefined) ??
    (normalized.includes('local') || normalized.includes('duckdb')
      ? destinations.find((destination) => destination.type === 'duckdb')
      : undefined);

  return (
    explicit ?? destinations.find((destination) => destination.type === preset.defaultDestination)!
  );
}

/** Match setup keywords using substring and word-boundary fallbacks. */
function matchesKeyword(goal: string, keyword: string): boolean {
  if (goal.includes(keyword)) return true;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(goal);
}

function isDestinationPhrase(goal: string, destinationType: SetupDestinationType): boolean {
  const destination = destinationType.replace(/_/g, '[\\s_-]+');
  return new RegExp(`\\b(?:into|to|in|on)\\s+(?:google\\s+cloud\\s+)?${destination}\\b`, 'i').test(
    goal
  );
}

/** Infer the source integrations implied by a setup goal or preset. */
function detectIntegrations(
  goal: string,
  preset: SetupPreset,
  catalog: IntegrationSetupMetadata[],
  destinationType?: SetupDestinationType
): IntegrationSetupMetadata[] {
  const normalized = goal.toLowerCase();
  const destinationMentionedAsTarget =
    destinationType !== undefined && isDestinationPhrase(normalized, destinationType);
  const matched = catalog.filter((integration) => {
    if (destinationMentionedAsTarget && integration.name === destinationType) return false;
    return integration.keywords.some((keyword) => matchesKeyword(normalized, keyword));
  });
  if (matched.length > 0) return matched;
  return preset.recommendedIntegrations
    .map((name) => catalog.find((integration) => integration.name === name))
    .filter((value): value is IntegrationSetupMetadata => value !== undefined);
}

/** Seed destination config with placeholders appropriate for the chosen type. */
function destinationDefaults(type: SetupDestinationType): SetupDestination {
  switch (type) {
    case 'bigquery':
      return {
        type,
        project: 'your-gcp-project',
        dataset: 'raw',
        location: 'US',
        credentials_secret: 'GCP_SERVICE_ACCOUNT_JSON',
      };
    case 'duckdb':
      return {
        type,
        db_path: './data.duckdb',
      };
    case 'snowflake':
      return {
        type,
        account: 'your-account',
        username: 'BOBSLED',
        warehouse: 'COMPUTE_WH',
        database: 'RAW',
        schema: 'PUBLIC',
        password: '$SNOWFLAKE_PASSWORD',
      };
    case 'postgres':
      return {
        type,
        host: 'db.example.com',
        port: 5432,
        database: 'analytics',
        schema: 'public',
        username: 'bobsled',
        password: '$PG_PASSWORD',
      };
    case 'clickhouse':
      return {
        type,
        host: 'ch.example.com',
        port: 8443,
        database: 'analytics',
        username: 'default',
        password: '$CLICKHOUSE_PASSWORD',
        ssl: true,
      };
    case 'turbopuffer':
      return {
        type,
        api_key: '$TURBOPUFFER_API_KEY',
        region: 'gcp-us-central1',
        namespace_prefix: 'raw_',
      };
    case 'local':
      return {
        type,
        format: 'parquet',
      };
    case 's3':
      return {
        type,
        bucket: 'replace-me-bucket',
        prefix: 'raw',
        format: 'parquet',
      };
    case 'gcs':
      return {
        type,
        bucket: 'replace-me-bucket',
        prefix: 'raw',
        format: 'parquet',
      };
  }
}

/** Merge integration and destination secrets with any existing secret ref state. */
function buildSecretRefs(
  integrations: IntegrationSetupMetadata[],
  destination: DestinationSetupMetadata,
  existing: SetupSecretRef[]
): SetupSecretRef[] {
  const existingMap = new Map(existing.map((ref) => [ref.name, ref]));
  const refs = [
    ...integrations.flatMap((integration) =>
      integration.authSetup.map((entry) => ({
        name: entry.env,
        location: 'env_var' as const,
        status: 'missing' as const,
        description: entry.description,
        instructions: entry.docsUrl ? `See ${entry.docsUrl}` : undefined,
      }))
    ),
    ...destination.secretRefs,
  ];

  return unique(refs.map((ref) => ref.name)).map((name) => {
    const found = refs.find((ref) => ref.name === name)!;
    return existingMap.get(name) ?? found;
  });
}

/** Normalize explicit or inferred sources into the setup answers shape. */
function normalizeSources(
  explicitSources: SetupAnswers['sources'],
  recommended: IntegrationSetupMetadata[],
  schedule: string
): SetupSource[] {
  if (explicitSources.length > 0) {
    return explicitSources.map((source) => ({
      integration: source.integration,
      enabled: source.enabled,
      schedule: source.schedule ?? schedule,
      resources: source.resources,
    }));
  }

  return recommended.map((integration) => ({
    integration: integration.name,
    enabled: true,
    schedule: integration.recommendedSchedule ?? schedule,
    resources:
      integration.recommendedResources.length > 0 ? integration.recommendedResources : undefined,
  }));
}

/** Extract an explicitly named repo or project from a natural-language goal. */
function extractExplicitRepoName(goal: string): string | undefined {
  const patterns = [
    /(?:repo|project)\s+(?:called|named)\s+["']?([^"'\n.,;:!?]+?)["']?(?=\s+(?:with|for|to|into|using|on|and|or|then|that|which)\b|[.!,;:]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = goal.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      const normalized = slugify(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

/** Build a fallback repo name when the user has not named the repo directly. */
function deriveRepoName(goal: string, sources: SetupSource[]): string {
  if (sources.length === 0) return 'bobsled-pipelines';
  const integrationPart = sources
    .slice(0, 2)
    .map((source) => source.integration)
    .join('-');
  const goalPart = slugify(goal).slice(0, 20);
  return slugify(`${integrationPart}-${goalPart || 'pipelines'}`) || 'bobsled-pipelines';
}

/** Compute remaining setup blockers from the normalized answers state. */
function computeMissingItems(
  answers: SetupAnswers,
  destinationMeta: DestinationSetupMetadata,
  refs: SetupSecretRef[]
): string[] {
  const missing = new Set<string>();

  if (!answers.goals.summary) missing.add('Setup goal');
  if (!answers.project.repo_name) missing.add('Repository name');
  if (answers.sources.length === 0) missing.add('At least one integration');
  if (!answers.destination) missing.add('Destination configuration');

  for (const field of destinationMeta.requiredFields) {
    const value = answers.destination?.[field as keyof SetupDestination];
    if (value === undefined || value === null || value === '') {
      missing.add(`${destinationMeta.displayName} ${field}`);
    }
  }

  for (const ref of refs) {
    if (ref.status === 'missing') {
      missing.add(ref.name);
    }
  }

  return [...missing];
}

/** Render a compact recommendation summary for setup UI surfaces. */
function buildSummary(
  goal: string,
  preset: SetupPreset,
  sources: SetupSource[],
  destination: SetupDestination,
  missingItems: string[]
): string {
  const sourceNames = sources.map((source) => source.integration).join(', ');
  const destinationLabel = destination.type;
  const suffix =
    missingItems.length === 0
      ? 'No blocking setup items remain.'
      : `Still needed: ${missingItems.slice(0, 4).join(', ')}${missingItems.length > 4 ? ', ...' : ''}.`;

  return `Preset: ${preset.displayName}. Goal: ${goal}. Recommended sources: ${sourceNames}. Destination: ${destinationLabel}. ${suffix}`;
}

/** Parse and validate a setup answers YAML file from disk. */
export function parseSetupAnswersFile(filePath: string): SetupAnswers {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw);
  const result = SetupAnswersSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new CommandError(`Invalid setup answers file: ${issues}`, 2);
  }
  return result.data;
}

/** Persist a validated setup answers object to disk as YAML. */
export function writeSetupAnswersFile(filePath: string, answers: SetupAnswers): void {
  writeFileSync(filePath, stringify(answers), 'utf-8');
}

/** Recommend setup defaults from either a free-form goal or an existing answers file. */
export function recommendSetup(input: {
  goal?: string;
  answers?: SetupAnswers;
  integrations?: IntegrationSetupMetadata[];
  destinations?: DestinationSetupMetadata[];
  presets?: SetupPreset[];
}): SetupRecommendation {
  const integrations = input.integrations ?? buildIntegrationSetupCatalog();
  const destinations = input.destinations ?? getDestinationCatalog();
  const presets = input.presets ?? getSetupPresets();
  const answers =
    input.answers ??
    SetupAnswersSchema.parse({
      project: {
        repo_state: 'new',
      },
      goals: {},
      sources: [],
      credentials: { required_secret_refs: [] },
      status: { missing_items: [] },
    });

  const goal = input.goal ?? answers.goals.summary ?? 'Set up a new Bobsled Core repo.';
  const explicitPreset = answers.goals.preset
    ? presets.find((entry) => entry.id === answers.goals.preset)
    : undefined;
  const preset = explicitPreset ?? detectPreset(goal, presets);
  const detectedDestination = detectDestination(goal, preset, destinations);
  const recommendedIntegrations = detectIntegrations(
    goal,
    preset,
    integrations,
    detectedDestination.type
  );
  const schedule = detectSchedule(goal, preset.defaultSchedule);
  const sources = normalizeSources(answers.sources, recommendedIntegrations, schedule);
  const repoName =
    answers.project.repo_name ?? extractExplicitRepoName(goal) ?? deriveRepoName(goal, sources);
  const destination = {
    ...destinationDefaults(detectedDestination.type),
    ...(answers.destination ?? {}),
    type: answers.destination?.type ?? detectedDestination.type,
  };
  const enabledSourceNames = new Set(
    sources.filter((source) => source.enabled).map((source) => source.integration)
  );
  const integrationsForCreds =
    answers.sources.length > 0
      ? integrations.filter((integration) => enabledSourceNames.has(integration.name))
      : recommendedIntegrations;
  const credentialRefs = buildSecretRefs(
    integrationsForCreds,
    destinations.find((entry) => entry.type === destination.type)!,
    answers.credentials.required_secret_refs
  );

  const normalizedAnswers = SetupAnswersSchema.parse({
    ...answers,
    project: {
      ...answers.project,
      repo_name: repoName,
    },
    goals: {
      ...answers.goals,
      summary: goal,
      preset: preset.id,
    },
    sources,
    destination,
    credentials: {
      required_secret_refs: credentialRefs,
    },
  });

  const missingItems = computeMissingItems(
    normalizedAnswers,
    destinations.find((entry) => entry.type === destination.type)!,
    credentialRefs
  );

  return {
    goal,
    preset,
    repoName,
    sources,
    destination,
    credentialRefs,
    missingItems,
    nextActions:
      missingItems.length > 0
        ? [
            'Confirm or update the generated answers file.',
            'Add the missing secret references or environment variable names.',
            'Run `bobsled setup render` once the answers look right.',
          ]
        : [
            'Run `bobsled setup render`.',
            'Run `bobsled setup doctor` to verify the generated repo state.',
          ],
    summary: buildSummary(goal, preset, sources, destination, missingItems),
  };
}
