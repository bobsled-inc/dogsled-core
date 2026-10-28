import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

import {
  buildIndexedSourceRegistry,
  type SourceSpec,
  type SupportedDialect,
  SourceSpecSchema,
} from '@bobsled-inc/model-spec';
import { entriesOfKind, resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';
import { buildAgentTaskResult } from '../compiler/agent/types.js';
import {
  analyzeEntitySchema,
  normalizeFieldName,
  type EntityTypeHint,
  type ResourceSchema,
} from '../compiler/identity/entity-detection.js';
import {
  scaffoldResolutionSpec,
  type EntityFieldMapping,
  type InputSourceConfig,
} from '../compiler/identity/scaffold.js';
import { discoverResolutionSpecs, resolveResolutionSpec } from '../compiler/identity/parser.js';
import {
  loadProjectConfig,
  loadRunnerModule,
  resolveConfig,
  resolvePathWithinDir,
} from '@bobsled-inc/model-spec/shared';
import { CommandError } from '@bobsled-inc/protocol';

import type { AgentEntityOptions } from './agent-support.js';
import {
  assertProfileOperation,
  emitAgentResult,
  fetchResolveEstimateRows,
  loadAgentTaskProfile,
  requireQueryRunner,
  requireRunnerPath,
} from './agent-support.js';

interface OnboardResourceSummary {
  name: string;
  ref: string;
  source_file: string;
  entity_type_hint: EntityTypeHint;
  confidence: number;
  detected_id_fields: string[];
  field_count: number;
  review_markers: string[];
  role?: 'internal' | 'provider';
  trust_tier?: 'bronze' | 'silver' | 'gold';
  columns: Array<{ name: string; type: string }>;
}

interface OnboardManifest {
  version: '1.0';
  entity: string;
  discovery_timestamp: string;
  connection: string;
  status: 'discovered' | 'generated' | 'verified';
  resources: OnboardResourceSummary[];
  field_mapping?: EntityFieldMapping;
  generated_artifacts?: string[];
  validation_results?: Array<{
    file: string;
    valid: boolean;
    review_marker_count: number;
    message?: string;
  }>;
}

const OnboardEntityTypeSchema = z.enum(['company', 'person', 'account', 'contact', 'unknown']);
const OnboardResourceSummarySchema = z.object({
  name: z.string().min(1),
  ref: z.string().min(1),
  source_file: z.string().min(1),
  entity_type_hint: OnboardEntityTypeSchema,
  confidence: z.number().min(0).max(1),
  detected_id_fields: z.array(z.string()),
  field_count: z.number().int().nonnegative(),
  review_markers: z.array(z.string()),
  role: z.enum(['internal', 'provider']).optional(),
  trust_tier: z.enum(['bronze', 'silver', 'gold']).optional(),
  columns: z.array(
    z.object({
      name: z.string().min(1),
      type: z.string().min(1),
    })
  ),
});
const OnboardFieldMappingSchema = z.object({
  nameFields: z.array(z.string()),
  domainField: z.string().optional(),
  emailField: z.string().optional(),
  phoneField: z.string().optional(),
  countryField: z.string().optional(),
  reviewMarkers: z.array(z.string()).optional(),
  standardizeRules: z
    .array(
      z.object({
        field: z.string().min(1),
        transforms: z.array(z.string().min(1)).min(1),
      })
    )
    .optional(),
});
const OnboardValidationResultSchema = z.object({
  file: z.string().min(1),
  valid: z.boolean(),
  review_marker_count: z.number().int().nonnegative(),
  message: z.string().optional(),
});
const OnboardManifestSchema = z.object({
  version: z.literal('1.0'),
  entity: z.string().min(1),
  discovery_timestamp: z.string().min(1),
  connection: z.string().min(1),
  status: z.enum(['discovered', 'generated', 'verified']),
  resources: z.array(OnboardResourceSummarySchema),
  field_mapping: OnboardFieldMappingSchema.optional(),
  generated_artifacts: z.array(z.string().min(1)).optional(),
  validation_results: z.array(OnboardValidationResultSchema).optional(),
});

export interface OnboardCommandOptions extends AgentEntityOptions {
  connection?: string;
  entity?: string;
}

export interface OnboardVerifyOptions extends OnboardCommandOptions {
  runner?: string;
}

export async function onboardDiscoverHandler(
  options: OnboardCommandOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile } = loadAgentTaskProfile(options.profile);
  if (profile) {
    assertProfileOperation(profile, 'onboard_discover');
  }

  const entity = options.entity ?? profile?.entity;
  if (!entity) {
    throw new CommandError(
      'Entity name is required either via --entity or an onboarding agent task profile.',
      2
    );
  }
  const connection = options.connection;
  if (!connection) {
    throw new CommandError('--connection is required for agent onboard-discover.', 2);
  }

  const { index } = resolveProjectPaths();
  const sourceSpecs = loadSourceSpecsForConnection(index, connection);
  if (sourceSpecs.length === 0) {
    throw new CommandError(`No source specs found for connection "${connection}".`, 2);
  }

  const resources = sourceSpecs.map((sourceSpec) => toOnboardResourceSummary(sourceSpec));
  const normalizedEntityHint = normalizeEntityHint(entity);
  const directMatches = resources.filter(
    (resource) => normalizeEntityHint(resource.entity_type_hint) === normalizedEntityHint
  );
  const unknownMatches = resources.filter((resource) => resource.entity_type_hint === 'unknown');
  const manifestResources =
    directMatches.length > 0
      ? directMatches
      : unknownMatches.length > 0
        ? unknownMatches
        : resources;
  const manifest: OnboardManifest = {
    version: '1.0',
    entity,
    discovery_timestamp: new Date().toISOString(),
    connection,
    status: 'discovered',
    resources: manifestResources,
  };
  const manifestPath = writeManifest(manifest);
  const warnings =
    directMatches.length > 0
      ? []
      : [
          `No discovered sources matched entity "${entity}" directly; manifest includes ${manifestResources.length} fallback resource(s) for manual curation.`,
        ];

  emitAgentResult(
    buildAgentTaskResult({
      command: 'agent.onboard-discover',
      operation: 'onboard_discover',
      entity,
      executed: true,
      status: warnings.length > 0 ? 'needs_human' : 'ok',
      summary: {
        discovered_resources: manifestResources.map((resource) => ({
          name: resource.name,
          ref: resource.ref,
          field_count: resource.field_count,
          detected_id_fields: resource.detected_id_fields,
          review_markers: resource.review_markers,
        })),
        entity_candidates: manifestResources.map((resource) => ({
          name: resource.name,
          entity_type_hint: resource.entity_type_hint,
          confidence: resource.confidence,
        })),
        auth_requirements: {
          type: 'existing_source_specs',
          connection,
        },
      },
      recommended_next_action: 'onboard_generate',
      artifacts: {
        manifest_path: manifestPath,
      },
      warnings,
    }),
    options.json ?? globalOptions.quiet
  );
}

export async function onboardGenerateHandler(
  options: OnboardCommandOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile } = loadAgentTaskProfile(options.profile);
  if (profile) {
    assertProfileOperation(profile, 'onboard_generate');
  }

  const entity = options.entity ?? profile?.entity;
  if (!entity) {
    throw new CommandError(
      'Entity name is required either via --entity or an onboarding agent task profile.',
      2
    );
  }

  const manifest = readManifest(entity);
  if (manifest.status !== 'discovered') {
    throw new CommandError(
      `Manifest ${entity} is in status "${manifest.status}". Run onboard-discover before onboard-generate.`,
      2
    );
  }

  const { index, entityGraphDir, dialect, schema } = resolveProjectPaths(options);
  const mapping = buildEntityFieldMapping(manifest.resources, entity);
  const inputSources: InputSourceConfig[] = manifest.resources.map((resource) => ({
    ref: resource.ref,
    role: resource.role,
    trustTier: resource.trust_tier,
    idFields: resource.detected_id_fields,
  }));
  const scaffold = scaffoldResolutionSpec(
    entity,
    mapManifestEntityType(entity, manifest.resources),
    mapping,
    inputSources
  );
  fs.mkdirSync(entityGraphDir, { recursive: true });
  const resolutionPath = resolvePathWithinDir(
    entityGraphDir,
    `${entity}_resolution.yml`,
    'Generated resolution path'
  );
  fs.writeFileSync(resolutionPath, scaffold, 'utf-8');

  const validation = validateGeneratedResolutionSpec({
    resolutionPath,
    index,
    dialect,
    schema,
  });
  const validationResults = [
    {
      file: resolutionPath,
      valid: validation.valid,
      review_marker_count: countReviewMarkers(scaffold),
      ...(validation.message ? { message: validation.message } : {}),
    },
  ];

  const nextManifest: OnboardManifest = {
    ...manifest,
    status: validation.valid ? 'generated' : 'discovered',
    field_mapping: mapping,
    generated_artifacts: [resolutionPath],
    validation_results: validationResults,
  };
  writeManifest(nextManifest);

  emitAgentResult(
    buildAgentTaskResult({
      command: 'agent.onboard-generate',
      operation: 'onboard_generate',
      entity,
      executed: true,
      status: validation.valid ? 'ok' : 'needs_human',
      summary: {
        validation_results: validationResults,
      },
      recommended_next_action: validation.valid ? 'onboard_verify' : 'onboard_generate',
      artifacts: {
        generated_artifacts: [resolutionPath],
      },
      warnings: validation.valid
        ? []
        : [validation.message ?? 'Generated resolution scaffold did not validate.'],
    }),
    options.json ?? globalOptions.quiet
  );
}

export async function onboardVerifyHandler(
  options: OnboardVerifyOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile } = loadAgentTaskProfile(options.profile);
  if (profile) {
    assertProfileOperation(profile, 'onboard_verify');
  }

  const entity = options.entity ?? profile?.entity;
  if (!entity) {
    throw new CommandError(
      'Entity name is required either via --entity or an onboarding agent task profile.',
      2
    );
  }

  const manifest = readManifest(entity);
  if (manifest.status !== 'generated' && manifest.status !== 'verified') {
    throw new CommandError(
      `Manifest ${entity} is in status "${manifest.status}". Run onboard-generate before onboard-verify, or re-run onboard-discover to refresh the manifest.`,
      2
    );
  }

  const runnerPath = requireRunnerPath(options.runner, 'agent onboard-verify');
  const runner = await loadRunnerModule(runnerPath);
  const query = requireQueryRunner(runner, 'agent onboard-verify');
  const { index, entityGraphDir, dialect, schema } = resolveProjectPaths(options);
  const resolutionPath = resolvePathWithinDir(
    entityGraphDir,
    `${entity}_resolution.yml`,
    'Generated resolution path'
  );
  const resolvedSpec = resolveGeneratedSpec(resolutionPath, index, dialect, schema);
  const estimate = await fetchResolveEstimateRows(resolvedSpec, dialect, query);
  const validation = validateGeneratedResolutionSpec({
    resolutionPath,
    index,
    dialect,
    schema,
  });
  const attributeCoverage = computeAttributeCoverage(
    mapManifestEntityType(entity, manifest.resources),
    manifest.field_mapping
  );
  const candidateLimit = resolvedSpec.blocking?.candidateLimit ?? Number.POSITIVE_INFINITY;
  const hardFailures: string[] = [];
  const qualityAssessment = [
    {
      gate: 'resolution_spec_valid',
      status: validation.valid ? 'pass' : 'fail',
      reason: validation.message ?? 'Resolution spec validated successfully.',
    },
    {
      gate: 'pair_volume',
      status: estimate.total_pairs <= candidateLimit ? 'pass' : 'fail',
      reason:
        estimate.total_pairs <= candidateLimit
          ? `Estimated ${estimate.total_pairs} candidate pairs are within candidate_limit=${candidateLimit}.`
          : `Estimated ${estimate.total_pairs} candidate pairs exceeds candidate_limit=${candidateLimit}.`,
    },
    {
      gate: 'profile_attribute_coverage',
      status: attributeCoverage >= 0.5 ? 'pass' : 'warn',
      reason: `Mapped attribute coverage is ${attributeCoverage.toFixed(2)}.`,
    },
  ];

  for (const assessment of qualityAssessment) {
    if (assessment.status === 'fail') {
      hardFailures.push(assessment.reason);
    }
  }

  if (hardFailures.length === 0) {
    writeManifest({
      ...manifest,
      status: 'verified',
    });
  }

  emitAgentResult(
    buildAgentTaskResult({
      command: 'agent.onboard-verify',
      operation: 'onboard_verify',
      entity,
      executed: true,
      status: hardFailures.length === 0 ? 'ok' : 'blocked',
      summary: {
        resolution_summary: {
          total_pairs: estimate.total_pairs,
          auto_merge_count: estimate.auto_merge_count,
          review_queue_size_estimate: estimate.review_count,
          auto_reject_count: estimate.auto_reject_count,
        },
        quality_assessment: qualityAssessment,
      },
      recommended_next_action: hardFailures.length === 0 ? 'triage' : 'onboard_generate',
      artifacts: {
        manifest_path: getManifestPath(entity),
        generated_artifacts: manifest.generated_artifacts ?? [],
      },
      warnings:
        hardFailures.length === 0 && attributeCoverage < 0.5
          ? [`Profile attribute coverage is ${attributeCoverage.toFixed(2)}; review the scaffold.`]
          : hardFailures,
    }),
    options.json ?? globalOptions.quiet
  );
}

function resolveProjectPaths(options?: { dialect?: string; schema?: string }): {
  index: ProjectIndex;
  entityGraphDir: string;
  dialect: SupportedDialect;
  schema: string;
} {
  const cwd = process.cwd();
  const index = resolveProjectIndex(cwd);
  const { config } = loadProjectConfig(cwd, { index });
  const resolved = resolveConfig(
    {
      dialect: options?.dialect as SupportedDialect | undefined,
      schema: options?.schema,
    },
    config
  );

  return {
    index,
    entityGraphDir: resolvePathWithinDir(cwd, resolved.entityGraphDir, 'Entity Graph directory'),
    dialect: resolved.dialect,
    schema: resolved.schema,
  };
}

function loadSourceSpecsForConnection(index: ProjectIndex, connection: string): SourceSpec[] {
  const sourceSpecs: SourceSpec[] = [];
  for (const entry of entriesOfKind(index, 'source')) {
    const parsed = SourceSpecSchema.safeParse(entry.document);
    if (!parsed.success || parsed.data.connection !== connection) {
      continue;
    }
    sourceSpecs.push(parsed.data);
  }

  return sourceSpecs;
}

function toOnboardResourceSummary(sourceSpec: SourceSpec): OnboardResourceSummary {
  const schema: ResourceSchema = {
    name: sourceSpec.name,
    columns: sourceSpec.schema.columns.map((column) => ({
      name: column.name,
      type: column.type,
    })),
  };
  const analysis = analyzeEntitySchema(schema);

  return {
    name: sourceSpec.name,
    ref: `${sourceSpec.connection}.${sourceSpec.name}`,
    source_file: sourceSpec.name,
    entity_type_hint: analysis.entityType,
    confidence: analysis.confidence,
    detected_id_fields: analysis.idFields,
    field_count: sourceSpec.schema.columns.length,
    review_markers: analysis.reviewMarkers,
    trust_tier: sourceSpec.trust_tier,
    columns: sourceSpec.schema.columns.map((column) => ({
      name: column.name,
      type: column.type,
    })),
  };
}

function buildEntityFieldMapping(
  resources: OnboardResourceSummary[],
  entity: string
): EntityFieldMapping {
  const entityType = normalizeEntityHint(entity);
  const reviewMarkers = resources.flatMap((resource) => resource.review_markers);
  const standardizeRules = resources.flatMap(
    (resource) =>
      analyzeEntitySchema({
        name: resource.name,
        columns: resource.columns,
      }).standardizeRules
  );

  return {
    nameFields: pickFields(
      resources,
      entityType === 'person'
        ? ['first_name', 'last_name', 'given_name', 'family_name', 'name']
        : ['company_name', 'account_name', 'organization', 'name']
    ),
    domainField: pickField(resources, ['domain', 'website', 'web_site', 'company_domain']),
    emailField: pickField(resources, ['email', 'email_address']),
    phoneField: pickField(resources, ['phone', 'phone_number', 'mobile', 'mobile_phone']),
    countryField: pickField(resources, ['country', 'billing_country', 'hq_country']),
    reviewMarkers,
    standardizeRules,
  };
}

function pickField(resources: OnboardResourceSummary[], candidates: string[]): string | undefined {
  return pickFields(resources, candidates)[0];
}

function pickFields(resources: OnboardResourceSummary[], candidates: string[]): string[] {
  const normalizedCandidates = new Set(
    candidates.map((candidate) => normalizeFieldName(candidate))
  );
  const matches: string[] = [];

  for (const resource of resources) {
    for (const column of resource.columns) {
      const normalized = normalizeFieldName(column.name);
      if (!normalizedCandidates.has(normalized)) {
        continue;
      }
      if (!matches.includes(column.name)) {
        matches.push(column.name);
      }
    }
  }

  return matches;
}

function validateGeneratedResolutionSpec(input: {
  resolutionPath: string;
  index: ProjectIndex;
  dialect: SupportedDialect;
  schema: string;
}): { valid: boolean; message?: string } {
  try {
    const registryResult = buildIndexedSourceRegistry(input.index);
    if (!registryResult.ok) {
      return { valid: false, message: registryResult.error };
    }

    const parsedSpecs = discoverResolutionSpecs(path.dirname(input.resolutionPath));
    const parsedSpec = parsedSpecs.find(
      (spec) => path.resolve(spec.filePath) === input.resolutionPath
    );
    if (!parsedSpec) {
      return {
        valid: false,
        message: `Generated resolution spec ${input.resolutionPath} was not discoverable.`,
      };
    }

    resolveResolutionSpec(
      parsedSpec,
      registryResult.registry,
      input.dialect,
      input.schema,
      registryResult.columnRegistry
    );
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

function resolveGeneratedSpec(
  resolutionPath: string,
  index: ProjectIndex,
  dialect: SupportedDialect,
  schema: string
) {
  const registryResult = buildIndexedSourceRegistry(index);
  if (!registryResult.ok) {
    throw new CommandError(registryResult.error, 2);
  }
  const parsedSpecs = discoverResolutionSpecs(path.dirname(resolutionPath));
  const parsedSpec = parsedSpecs.find(
    (spec) => path.resolve(spec.filePath) === path.resolve(resolutionPath)
  );
  if (!parsedSpec) {
    throw new CommandError(`No generated resolution spec found at ${resolutionPath}.`, 2);
  }

  return resolveResolutionSpec(
    parsedSpec,
    registryResult.registry,
    dialect,
    schema,
    registryResult.columnRegistry
  );
}

function computeAttributeCoverage(
  entityType: EntityTypeHint,
  fieldMapping?: EntityFieldMapping
): number {
  if (!fieldMapping) {
    return 0;
  }

  const expectedSlots =
    normalizeEntityHint(entityType) === 'person'
      ? [
          fieldMapping.nameFields.length > 0,
          fieldMapping.emailField != null,
          fieldMapping.phoneField != null,
        ]
      : [
          fieldMapping.nameFields.length > 0,
          fieldMapping.domainField != null,
          fieldMapping.phoneField != null,
        ];

  const satisfied = expectedSlots.filter(Boolean).length;
  return expectedSlots.length === 0 ? 0 : satisfied / expectedSlots.length;
}

function mapManifestEntityType(
  entity: string,
  resources: OnboardResourceSummary[]
): EntityTypeHint {
  const directMatch = resources.find(
    (resource) => normalizeEntityHint(resource.entity_type_hint) === normalizeEntityHint(entity)
  );
  return directMatch?.entity_type_hint ?? (normalizeEntityHint(entity) as EntityTypeHint);
}

function normalizeEntityHint(value: string | EntityTypeHint): 'company' | 'person' | 'unknown' {
  const normalized = normalizeFieldName(String(value).replace(/_resolution$/i, ''));
  if (normalized === 'company' || normalized === 'account') {
    return 'company';
  }
  if (normalized === 'person' || normalized === 'contact') {
    return 'person';
  }
  return 'unknown';
}

function countReviewMarkers(content: string): number {
  return (content.match(/#\s*REVIEW:/g) ?? []).length;
}

function getManifestPath(entity: string): string {
  return path.join(process.cwd(), '.dogsled', 'onboard', `${entity}.json`);
}

function writeManifest(manifest: OnboardManifest): string {
  const manifestPath = getManifestPath(manifest.entity);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, manifestPath);
  return manifestPath;
}

function readManifest(entity: string): OnboardManifest {
  const manifestPath = getManifestPath(entity);
  if (!fs.existsSync(manifestPath)) {
    throw new CommandError(
      `Onboarding manifest not found at ${manifestPath}. Run onboard-discover first.`,
      2
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new CommandError(
      `Onboarding manifest at ${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`,
      2
    );
  }

  const manifest = OnboardManifestSchema.safeParse(parsedJson);
  if (!manifest.success) {
    const details = manifest.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CommandError(`Onboarding manifest at ${manifestPath} is invalid: ${details}`, 2);
  }

  return manifest.data as OnboardManifest;
}
