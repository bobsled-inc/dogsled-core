import { z } from 'zod';

export const SetupDestinationTypeSchema = z.enum([
  'bigquery',
  'duckdb',
  'snowflake',
  'postgres',
  'clickhouse',
  'turbopuffer',
  'local',
  's3',
  'gcs',
]);

export const SetupSecretLocationSchema = z.enum(['env_var', 'secret_manager']);
export const SetupSecretStatusSchema = z.enum(['missing', 'provided', 'configured']);
export const SetupRepoStateSchema = z.enum(['new', 'existing']);
export const SetupPhaseSchema = z.enum([
  'gathering-inputs',
  'recommended',
  'rendered',
  'ready-to-run',
  'blocked',
]);

export const SetupSecretRefSchema = z
  .object({
    name: z.string().min(1),
    location: SetupSecretLocationSchema.default('env_var'),
    status: SetupSecretStatusSchema.default('missing'),
    description: z.string().optional(),
    instructions: z.string().optional(),
  })
  .strict();

export const SetupSourceSchema = z
  .object({
    integration: z.string().min(1),
    enabled: z.boolean().default(true),
    schedule: z.string().optional(),
    resources: z.array(z.string()).optional(),
  })
  .strict();

export const SetupDestinationSchema = z
  .object({
    type: SetupDestinationTypeSchema,
    project: z.string().optional(),
    dataset: z.string().optional(),
    location: z.string().optional(),
    credentials_secret: z.string().optional(),
    db_path: z.string().optional(),
    bucket: z.string().optional(),
    prefix: z.string().optional(),
    format: z.enum(['parquet', 'jsonl', 'csv']).optional(),
    account: z.string().optional(),
    username: z.string().optional(),
    warehouse: z.string().optional(),
    database: z.string().optional(),
    schema: z.string().optional(),
    password: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    ssl: z.boolean().optional(),
    api_key: z.string().optional(),
    region: z.string().optional(),
    namespace_prefix: z.string().optional(),
  })
  .strict();

export const SetupProjectSchema = z
  .object({
    repo_name: z.string().optional(),
    repo_state: SetupRepoStateSchema.default('new'),
  })
  .strict()
  .default({
    repo_state: 'new',
  });

export const SetupGoalsSchema = z
  .object({
    summary: z.string().optional(),
    preset: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict()
  .default({});

export const SetupCredentialsSchema = z
  .object({
    required_secret_refs: z.array(SetupSecretRefSchema).default([]),
  })
  .strict()
  .default({
    required_secret_refs: [],
  });

export const SetupStatusSchema = z
  .object({
    setup_phase: SetupPhaseSchema.optional(),
    missing_items: z.array(z.string()).default([]),
  })
  .strict()
  .default({
    missing_items: [],
  });

export const SetupAnswersSchema = z
  .object({
    project: SetupProjectSchema,
    goals: SetupGoalsSchema,
    sources: z.array(SetupSourceSchema).default([]),
    destination: SetupDestinationSchema.optional(),
    credentials: SetupCredentialsSchema,
    status: SetupStatusSchema,
  })
  .strict();

export type SetupDestinationType = z.infer<typeof SetupDestinationTypeSchema>;
export type SetupSecretRef = z.infer<typeof SetupSecretRefSchema>;
export type SetupSource = z.infer<typeof SetupSourceSchema>;
export type SetupDestination = z.infer<typeof SetupDestinationSchema>;
export type SetupAnswers = z.infer<typeof SetupAnswersSchema>;

export interface IntegrationSetupMetadata {
  name: string;
  displayName: string;
  category: string;
  tags: string[];
  docsUrl?: string;
  resourceCount: number;
  integrationType: 'api' | 'mcp' | 'db';
  plainLanguagePurpose: string;
  bestFor: string[];
  authDifficulty: 'easy' | 'medium' | 'hard';
  requiresAdminAccess: boolean;
  recommendedSchedule: string;
  recommendedResources: string[];
  setupPrerequisites: string[];
  secretLabels: string[];
  secretInstructions: string[];
  destinationFit: SetupDestinationType[];
  estimatedSetupFriction: 'low' | 'medium' | 'high';
  starterTemplateTags: string[];
  keywords: string[];
  authSetup: Array<{
    env: string;
    description: string;
    docsUrl?: string;
  }>;
}

export interface DestinationSetupMetadata {
  type: SetupDestinationType;
  displayName: string;
  plainLanguagePurpose: string;
  bestFor: string[];
  setupPrerequisites: string[];
  requiredFields: string[];
  defaultSchedule: string;
  secretRefs: SetupSecretRef[];
}

export interface SetupPreset {
  id: string;
  displayName: string;
  description: string;
  keywords: string[];
  recommendedIntegrations: string[];
  defaultDestination: SetupDestinationType;
  defaultSchedule: string;
}

export interface SetupQuestion {
  id: string;
  prompt: string;
  field: string;
  recommended: string;
}

export interface SetupDescribePayload {
  version: number;
  questionnaire: SetupQuestion[];
  integrations: IntegrationSetupMetadata[];
  destinations: DestinationSetupMetadata[];
  presets: SetupPreset[];
  defaults: {
    schedule: string;
    repoState: z.infer<typeof SetupRepoStateSchema>;
  };
  validationRules: Record<string, string>;
}

export interface SetupRecommendation {
  goal: string;
  preset: SetupPreset;
  repoName: string;
  sources: SetupSource[];
  destination: SetupDestination;
  credentialRefs: SetupSecretRef[];
  missingItems: string[];
  nextActions: string[];
  summary: string;
}

export interface SetupDoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export interface SetupDoctorReport {
  status: 'ready' | 'blocked';
  summary: string;
  checks: SetupDoctorCheck[];
  nextActions: string[];
  blockers: string[];
}

export interface RenderedSetupFile {
  path: string;
  content: string;
  preserveExisting?: boolean;
}

export interface RenderedSetupWriteResult {
  written: string[];
  preserved: string[];
}
