import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import YAML from 'yaml';
import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';

import type {
  ModelExecutionResult,
  SourceColumnRegistry,
  SourceRegistry,
  SqlQueryRunner,
  SqlRunnerModule,
  SupportedDialect,
} from '@bobsled-inc/model-spec';
import { buildIndexedSourceRegistry, executeSqlStatements } from '@bobsled-inc/model-spec';
import { resolveProjectIndex } from '@bobsled-inc/project-index';
import type {
  AgentTaskMode,
  AgentTaskProfile,
  AgentThresholdBand,
} from '../compiler/agent/schema.js';
import { AGENT_THRESHOLD_BANDS } from '../compiler/agent/schema.js';
import { AgentTaskProfileSchema } from '../compiler/agent/schema.js';
import type {
  AgentDecisionBundleDecision,
  AgentDecisionBundleV1,
  AgentTaskResultV1,
} from '../compiler/agent/types.js';
import { reviewBandMidpoint } from '../compiler/identity/codegen-threshold.js';
import { ReviewQueueRowSchema } from '../compiler/identity/agent-review-fetch.js';
import { generateExportQuery } from '../compiler/identity/review-export.js';
import { discoverResolutionSpecs, resolveResolutionSpec } from '../compiler/identity/parser.js';
import type {
  ResolvedResolutionSpec,
  ReviewExportRow,
  SqlStatement,
} from '../compiler/identity/types.js';
import { outputTableName } from '../compiler/output-tables/index.js';
import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';
import {
  discoverSurvivorshipSpecs,
  resolveSurvivorshipSpec,
} from '../compiler/survivorship/parser.js';
import type { ResolvedSurvivorshipSpec } from '../compiler/survivorship/types.js';
import {
  discoverTruthsetSpecs,
  loadTruthsetLabels,
  resolveTruthsetSpec,
  type ResolvedTruthsetSpec,
} from '../compiler/truthset/parser.js';
import { loadProjectConfig, resolveConfig } from '@bobsled-inc/model-spec/shared';
import { out } from '@bobsled-inc/model-spec/shared';

import { buildResolveEstimateQuery } from './resolve.js';
import { runResolveStatusQuery } from './resolve-support.js';
import { buildPairScoreQuery, resolveThresholds, scoreLabels, tuneThresholds } from './truthset.js';
import { parseGlobalFlags, resolvePathWithinDir } from '@bobsled-inc/model-spec/shared';
export { parsePositiveIntOption } from '@bobsled-inc/model-spec/shared';

// One queue-row source of truth: the base columns come from
// `ReviewQueueRowSchema` (compiler/identity/agent-review-fetch.ts); this
// export reader only adds the decision columns its query joins in.
const ReviewExportRowsSchema = z.array(
  ReviewQueueRowSchema.extend({
    decision: z.enum(['merge', 'not_match', 'defer']).nullable().optional(),
    confidence: z.coerce.number().min(0).max(1).nullable().optional(),
    reviewer: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    proposed_decision: z.enum(['merge', 'not_match', 'defer']).nullable().optional(),
    proposed_confidence: z.coerce.number().min(0).max(1).nullable().optional(),
    confidence_gap: z.coerce.number().nullable().optional(),
    decided_at: z.string().nullable().optional(),
    decision_source: z.string().nullable().optional(),
    decision_batch_id: z.string().nullable().optional(),
    applied_at: z.string().nullable().optional(),
  })
);

const ResolveStatusRowsSchema = z.array(
  z.object({
    stage: z.string(),
    row_count: z.coerce.number(),
  })
);

const ResolveEstimateRowsSchema = z.array(
  z.object({
    total_pairs: z.coerce.number(),
    auto_merge_count: z.coerce.number(),
    review_count: z.coerce.number(),
    auto_reject_count: z.coerce.number(),
  })
);

const SurvivorshipSummaryRowsSchema = z.array(
  z.object({
    section: z.enum(['golden_record', 'golden_history', 'survivorship_audit']),
    row_count: z.coerce.number(),
  })
);

const TruthsetScoreRowsSchema = z.array(
  z.object({
    pair_id: z.string(),
    composite_score: z.coerce.number(),
  })
);

export const AgentActionPriority: Record<AgentTaskResultV1['recommended_next_action'], number> = {
  triage: 8,
  onboard_generate: 7,
  onboard_verify: 6,
  run_resolution: 5,
  agent_review_batch: 4,
  cluster: 3,
  survivorship_refresh: 2,
  truthset_regress: 1,
  noop: 0,
};

export const ACCEPTED_REVIEW_BANDS: readonly AgentThresholdBand[] = [...AGENT_THRESHOLD_BANDS];

export interface AgentResolutionContext {
  specs: ResolvedResolutionSpec[];
  dialect: SupportedDialect;
  targetSchema: string;
  entityGraphDir: string;
  quiet: boolean;
}

export interface ReviewBatchResolvedConfig {
  mode: AgentTaskMode;
  thresholdBands: AgentThresholdBand[];
  limit: number;
  allowWrites: boolean;
  maxApplyCount: number | null;
  requireTruthsetPrecision: number | null;
  autoApplyThreshold: number;
  /**
   * Confidence below which the agent itself returns `defer` rather than
   * committing to a merge / not_match call. Defaults to 0.5 when neither the
   * profile nor the spec provides an override.
   */
  agentConfidenceFloor: number;
  postApply: {
    cluster: boolean;
    survivorship: boolean;
  };
  decisionSource: string;
  outputBundlePath?: string;
}

export interface ReviewBatchOptions {
  entity?: string;
  runner?: string;
  profile?: string;
  mode?: AgentTaskMode;
  limit?: number;
  decisionSource?: string;
  postApply?: 'none' | 'cluster' | 'cluster,survivorship';
  outputBundle?: string;
  schema?: string;
  dialect?: SupportedDialect;
  json?: boolean;
}

export interface AgentEntityOptions {
  runner?: string;
  profile?: string;
  schema?: string;
  dialect?: SupportedDialect;
  json?: boolean;
}

export interface InitProfileOptions extends AgentEntityOptions {
  entity?: string;
  operation?:
    | 'triage'
    | 'review_batch'
    | 'survivorship_refresh'
    | 'truthset_regress'
    | 'onboard_discover'
    | 'onboard_generate'
    | 'onboard_propose_cleaning'
    | 'onboard_verify';
  mode?: AgentTaskMode;
}

export interface TruthsetInsight {
  spec: ResolvedTruthsetSpec;
  labelCount: number;
  currentThresholds: {
    auto_merge: number;
    review: number;
    auto_reject: number;
  };
  currentMetrics: {
    matched_label_count: number;
    missing_pair_count: number;
    auto_merge_precision: number;
    auto_merge_recall: number;
    review_recall: number;
    auto_reject_precision: number;
  };
  recommendedThresholds: {
    auto_merge: number;
    review: number;
    auto_reject: number;
  };
  recommendedMetrics: {
    matched_label_count: number;
    missing_pair_count: number;
    auto_merge_precision: number;
    auto_merge_recall: number;
    review_recall: number;
    auto_reject_precision: number;
  };
  requiredPrecision: number;
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function emitAgentResult(result: AgentTaskResultV1, json = false): void {
  if (json) {
    out.json(result);
    return;
  }

  out.info(`${result.command} [${result.status}]`);
  if (result.entity) {
    out.info(`entity=${result.entity}`);
  } else if (result.entities) {
    out.info(`entities=${result.entities.join(', ')}`);
  }
  out.info(`recommended_next_action=${result.recommended_next_action}`);
  out.info(`summary:\n${YAML.stringify(result.summary, { indent: 2, lineWidth: 120 }).trimEnd()}`);
  for (const warning of result.warnings) {
    out.warn(warning);
  }
}

export function requireRunnerPath(runnerPath: string | undefined, commandName: string): string {
  if (!runnerPath) {
    throw new CommandError(`--runner is required for ${commandName}.`);
  }
  return runnerPath;
}

export function requireQueryRunner(runner: SqlRunnerModule, commandName: string): SqlQueryRunner {
  if (runner.query == null) {
    throw new CommandError(`${commandName} requires a runner module with query(sql).`);
  }
  return runner.query;
}

export function loadAgentTaskProfile(profilePath?: string): {
  profile?: AgentTaskProfile;
  profilePath?: string;
} {
  if (!profilePath) {
    return {};
  }

  const resolvedPath = path.resolve(profilePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new CommandError(`Agent task profile not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const raw = YAML.parse(content) as unknown;
  const parsed = AgentTaskProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CommandError(
      `Invalid agent task profile ${resolvedPath}: ${issue?.path.join('.') ?? 'profile'} ${issue?.message ?? 'is invalid'}`
    );
  }

  return {
    profile: parsed.data,
    profilePath: resolvedPath,
  };
}

export function assertProfileOperation(
  profile: AgentTaskProfile | undefined,
  operation: AgentTaskProfile['operation']
): void {
  if (profile && profile.operation !== operation) {
    throw new CommandError(
      `Profile ${profile.name} is for operation ${profile.operation}, not ${operation}.`,
      2
    );
  }
}

export function resolveSingleEntity(
  entity: string | undefined,
  profile: AgentTaskProfile | undefined
): string {
  const resolved = entity ?? profile?.entity;
  if (!resolved) {
    throw new CommandError('Entity name is required either via CLI flag/argument or --profile.');
  }
  return resolved;
}

export function resolveEntityNames(
  entityNames: string[],
  profile: AgentTaskProfile | undefined
): string[] {
  if (entityNames.length > 0) {
    return entityNames;
  }
  if (profile?.entity) {
    return [profile.entity];
  }
  throw new CommandError('At least one entity name is required either via CLI or --profile.');
}

export function buildAgentResolutionContext(
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions: { dialect?: SupportedDialect; schema?: string },
  entityNames: string[]
): AgentResolutionContext {
  const flags = parseGlobalFlags(globalOptions);
  const cwd = process.cwd();
  const index = resolveProjectIndex(cwd);
  const { config } = loadProjectConfig(cwd, { index });

  const resolved = resolveConfig(
    {
      dialect: localOptions.dialect,
      schema: localOptions.schema,
    },
    config
  );

  const registryResult = buildIndexedSourceRegistry(index);
  if (!registryResult.ok) {
    throw new CommandError(registryResult.error, 2);
  }
  const sourceRegistry: SourceRegistry = registryResult.registry;
  const columnRegistry: SourceColumnRegistry | undefined = registryResult.columnRegistry;

  const entityGraphDir = resolvePathWithinDir(
    cwd,
    resolved.entityGraphDir,
    'Entity Graph directory'
  );
  if (!fs.existsSync(entityGraphDir)) {
    throw new CommandError(`No ${resolved.entityGraphDir}/ directory found.`, 2);
  }

  let specs = discoverResolutionSpecs(entityGraphDir).map((spec) =>
    resolveResolutionSpec(spec, sourceRegistry, resolved.dialect, resolved.schema, columnRegistry)
  );

  if (entityNames.length > 0) {
    const requested = new Set(entityNames.map((name) => name.toLowerCase()));
    specs = specs.filter(
      (spec) => requested.has(spec.entity.toLowerCase()) || requested.has(spec.name.toLowerCase())
    );
  }

  if (specs.length === 0) {
    throw new CommandError(`No resolution specs found matching: ${entityNames.join(', ')}`, 2);
  }

  return {
    specs,
    dialect: resolved.dialect,
    targetSchema: resolved.schema,
    entityGraphDir,
    quiet: flags.quiet,
  };
}

export function buildTruthsetMap(entityGraphDir: string): Map<string, ResolvedTruthsetSpec> {
  return new Map(
    discoverTruthsetSpecs(entityGraphDir)
      .map((spec) => resolveTruthsetSpec(spec, entityGraphDir))
      .flatMap((spec) => [
        [spec.entity.toLowerCase(), spec] as const,
        [spec.resolutionEntity.toLowerCase(), spec] as const,
        [spec.name.toLowerCase(), spec] as const,
      ])
  );
}

export function buildSurvivorshipMap(
  entityGraphDir: string,
  defaultSchema: string
): Map<string, ResolvedSurvivorshipSpec> {
  return new Map(
    discoverSurvivorshipSpecs(entityGraphDir)
      .map((spec) => resolveSurvivorshipSpec(spec, entityGraphDir, defaultSchema))
      .flatMap((spec) => [
        [spec.entity.toLowerCase(), spec] as const,
        [spec.resolutionEntity.toLowerCase(), spec] as const,
        [spec.name.toLowerCase(), spec] as const,
      ])
  );
}

function buildPostApplySelection(value?: 'none' | 'cluster' | 'cluster,survivorship'): {
  cluster: boolean;
  survivorship: boolean;
} {
  if (!value || value === 'none') {
    return { cluster: false, survivorship: false };
  }
  if (value === 'cluster') {
    return { cluster: true, survivorship: false };
  }
  return { cluster: true, survivorship: true };
}

export function buildReviewBatchConfig(
  spec: ResolvedResolutionSpec,
  profile: AgentTaskProfile | undefined,
  options: ReviewBatchOptions,
  profilePath?: string
): ReviewBatchResolvedConfig {
  const mode = options.mode ?? profile?.mode ?? 'propose';
  const thresholdBands = profile?.selection?.threshold_bands ?? [...ACCEPTED_REVIEW_BANDS];
  const limit =
    options.limit ?? profile?.selection?.limit ?? spec.agentPolicy?.maxPairsPerRun ?? 50;
  const approvalPolicy = spec.agentPolicy?.approvalPolicy;
  const defaultAllowWrites = approvalPolicy === 'never' ? false : true;
  const profilePostApply = {
    cluster: profile?.post_apply?.cluster ?? false,
    survivorship: profile?.post_apply?.survivorship ?? false,
  };
  const outputBundlePath = options.outputBundle
    ? path.resolve(options.outputBundle)
    : profile?.output?.decision_bundle_path
      ? path.isAbsolute(profile.output.decision_bundle_path)
        ? profile.output.decision_bundle_path
        : profilePath
          ? path.resolve(path.dirname(profilePath), profile.output.decision_bundle_path)
          : profile.output.decision_bundle_path
      : undefined;
  const autoApplyThreshold =
    profile?.policy?.auto_apply_threshold ?? spec.agentPolicy?.autoApplyThreshold ?? 0.75;
  const agentConfidenceFloor =
    profile?.policy?.agent_confidence_floor ?? spec.agentPolicy?.agentConfidenceFloor ?? 0.5;

  return {
    mode,
    thresholdBands,
    limit,
    allowWrites: profile?.policy?.allow_writes ?? defaultAllowWrites,
    maxApplyCount: profile?.policy?.max_apply_count ?? spec.agentPolicy?.maxPairsPerRun ?? null,
    requireTruthsetPrecision: profile?.policy?.require_truthset_precision ?? null,
    autoApplyThreshold,
    agentConfidenceFloor,
    postApply:
      options.postApply != null ? buildPostApplySelection(options.postApply) : profilePostApply,
    decisionSource: options.decisionSource ?? 'agent',
    outputBundlePath,
  };
}

function buildProposalReason(row: ReviewExportRow, midpoint: number): string {
  return [
    `threshold_band=${row.threshold_band}`,
    `composite_score=${row.composite_score.toFixed(4)}`,
    `midpoint=${midpoint.toFixed(4)}`,
    `recommended_action=${row.recommended_action}`,
    `blocking_rules=${row.blocking_rules}`,
  ].join('; ');
}

export function buildDecisionBundle(
  spec: ResolvedResolutionSpec,
  rows: ReviewExportRow[],
  config: ReviewBatchResolvedConfig,
  learningContext?: string
): AgentDecisionBundleV1 {
  const decisions: AgentDecisionBundleDecision[] = rows.map((row) => ({
    pair_id: row.pair_id,
    decision: row.recommended_action,
    reason: buildProposalReason(row, reviewBandMidpoint(spec.thresholds)),
    confidence: Number(
      (row.recommended_action === 'merge' ? row.composite_score : 1 - row.composite_score).toFixed(
        4
      )
    ),
    reviewer: config.decisionSource,
    decision_source: config.decisionSource,
  }));
  const normalizedLearningContext = learningContext?.trim();

  return {
    version: 'entity_graph_decision_bundle.v1',
    entity: spec.entity,
    mode: config.mode,
    decision_source: config.decisionSource,
    learning_context: normalizedLearningContext || undefined,
    threshold_bands: config.thresholdBands,
    limit: config.limit,
    decisions,
  };
}

export function writeDecisionBundle(
  bundle: AgentDecisionBundleV1,
  outputPath: string | undefined
): string | undefined {
  if (!outputPath) {
    return undefined;
  }

  const resolvedPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const ext = path.extname(resolvedPath).toLowerCase();
  const content =
    ext === '.yml' || ext === '.yaml'
      ? YAML.stringify(bundle, { lineWidth: 120 })
      : `${JSON.stringify(bundle, null, 2)}\n`;
  fs.writeFileSync(resolvedPath, content, 'utf-8');
  return resolvedPath;
}

export async function fetchReviewRows(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  query: SqlQueryRunner,
  thresholdBands: readonly AgentThresholdBand[],
  limit?: number
): Promise<ReviewExportRow[]> {
  const midpoint = reviewBandMidpoint(spec.thresholds);
  const rawRows = await query(
    generateExportQuery(spec.entity, spec.targetSchema ?? 'PUBLIC', midpoint, dialect, {
      pendingOnly: true,
      includeDecisionColumns: false,
      thresholdBands,
      limit,
    })
  );
  const parsedRows = ReviewExportRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    const issue = parsedRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid review rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }
  return parsedRows.data;
}

export async function fetchIncorrectFeedbackPairs(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  query: SqlQueryRunner,
  limit = 1000
): Promise<ReviewExportRow[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new CommandError(`Invalid feedback limit ${limit}. Expected a non-negative integer.`);
  }

  const schema = spec.targetSchema ?? 'PUBLIC';
  const reviewQueueTable = buildFqName(
    schema,
    outputTableName(spec.entity, '__review_queue'),
    dialect
  );
  const decisionsTable = buildFqName(
    schema,
    outputTableName(spec.entity, '__review_decisions'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const feedbackOutcome = quoteIdentifier('human_feedback_outcome', dialect);
  const decidedAt = quoteIdentifier('decided_at', dialect);
  const rowNumber = quoteIdentifier('rn', dialect);
  const incorrectLiteral = quoteLiteral('incorrect', dialect);
  const needsRevisionLiteral = quoteLiteral('needs_revision', dialect);
  const rawRows = await query(
    [
      `WITH latest_decisions AS (`,
      `  SELECT ${pairId}, ${feedbackOutcome}, ${rowNumber}`,
      `  FROM (`,
      `    SELECT`,
      `      ${pairId},`,
      `      ${feedbackOutcome},`,
      `      ROW_NUMBER() OVER (`,
      `        PARTITION BY ${pairId}`,
      `        ORDER BY ${decidedAt} DESC`,
      `      ) AS ${rowNumber}`,
      `    FROM ${decisionsTable}`,
      `  ) ranked`,
      `  WHERE ranked.${rowNumber} = 1`,
      `)`,
      `SELECT rq.*`,
      `FROM ${reviewQueueTable} rq`,
      `JOIN latest_decisions ld ON rq.${pairId} = ld.${pairId}`,
      `WHERE ld.${feedbackOutcome} IN (${incorrectLiteral}, ${needsRevisionLiteral})`,
      `LIMIT ${quoteLiteral(limit, dialect)}`,
    ].join('\n')
  );
  const parsedRows = ReviewExportRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    const issue = parsedRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid incorrect-feedback review rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }
  return parsedRows.data;
}

export async function fetchPendingHumanReviewCount(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  query: SqlQueryRunner
): Promise<number> {
  const schema = spec.targetSchema ?? 'PUBLIC';
  const decisionsTable = buildFqName(
    schema,
    outputTableName(spec.entity, '__review_decisions'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const status = quoteIdentifier('status', dialect);
  const decidedAt = quoteIdentifier('decided_at', dialect);
  const appliedAt = quoteIdentifier('applied_at', dialect);
  const rowCount = quoteIdentifier('row_count', dialect);
  // Counts the latest decision per pair where the status indicates the
  // pair still needs a human (proposed = agent committed but below
  // auto-apply gate; deferred = agent itself said it could not tell).
  const rawRows = await query(
    [
      `WITH latest_decisions AS (`,
      `  SELECT ${pairId}, ${status}`,
      `  FROM (`,
      `    SELECT`,
      `      ${pairId},`,
      `      ${status},`,
      `      ROW_NUMBER() OVER (`,
      `        PARTITION BY ${pairId}`,
      `        ORDER BY ${decidedAt} DESC, ${appliedAt} DESC`,
      `      ) AS ${quoteIdentifier('rn', dialect)}`,
      `    FROM ${decisionsTable}`,
      `  ) ranked`,
      `  WHERE ranked.${quoteIdentifier('rn', dialect)} = 1`,
      `)`,
      `SELECT COUNT(*) AS ${rowCount}`,
      `FROM latest_decisions`,
      `WHERE ${status} IN (${quoteLiteral('proposed', dialect)}, ${quoteLiteral('deferred', dialect)})`,
    ].join('\n')
  );

  const firstRow = rawRows[0];
  if (!firstRow) {
    return 0;
  }

  const entries = new Map(
    Object.entries(firstRow).map(([key, value]) => [key.toLowerCase(), value])
  );
  const parsed = Number(entries.get('row_count'));
  if (!Number.isFinite(parsed)) {
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid pending-human-review count.`,
      1
    );
  }
  return parsed;
}

export async function fetchResolveStatusRows(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  query: SqlQueryRunner
): Promise<Record<string, number>> {
  const schema = spec.targetSchema ?? 'PUBLIC';
  const rawRows = await runResolveStatusQuery(spec.entity, schema, dialect, query);
  const parsedRows = ResolveStatusRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    const issue = parsedRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid resolve status rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }

  return Object.fromEntries(parsedRows.data.map((row) => [row.stage, row.row_count]));
}

export async function fetchResolveEstimateRows(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  query: SqlQueryRunner
): Promise<{
  total_pairs: number;
  auto_merge_count: number;
  review_count: number;
  auto_reject_count: number;
}> {
  const schema = spec.targetSchema ?? 'PUBLIC';
  const rawRows = await query(buildResolveEstimateQuery(spec, schema, dialect));
  const parsedRows = ResolveEstimateRowsSchema.safeParse(rawRows);
  if (!parsedRows.success || parsedRows.data.length === 0) {
    const issue = parsedRows.success ? undefined : parsedRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid resolve estimate rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }

  return parsedRows.data[0]!;
}

function buildSurvivorshipSummaryQuery(
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect
): string {
  const sections = [
    ['golden_record', outputTableName(entity, '__golden_record')],
    ['golden_history', outputTableName(entity, '__golden_history')],
    ['survivorship_audit', outputTableName(entity, '__survivorship_audit')],
  ] as const;

  return sections
    .map(
      ([section, table]) =>
        `SELECT ${quoteLiteral(section, dialect)} AS ${quoteIdentifier('section', dialect)}, COUNT(*) AS ${quoteIdentifier('row_count', dialect)} FROM ${buildFqName(targetSchema, table, dialect)}`
    )
    .join('\nUNION ALL\n');
}

export async function fetchSurvivorshipSummary(
  spec: ResolvedSurvivorshipSpec,
  dialect: SupportedDialect,
  query: SqlQueryRunner
): Promise<Record<string, number>> {
  const rawRows = await query(
    buildSurvivorshipSummaryQuery(spec.resolutionEntity, spec.targetSchema, dialect)
  );
  const parsedRows = SurvivorshipSummaryRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    const issue = parsedRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.name} returned invalid survivorship summary rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }

  return Object.fromEntries(parsedRows.data.map((row) => [row.section, row.row_count]));
}

async function fetchTruthsetScores(
  truthset: ResolvedTruthsetSpec,
  targetSchema: string,
  dialect: SupportedDialect,
  query: SqlQueryRunner
): Promise<Map<string, number>> {
  const labels = loadTruthsetLabels(truthset);
  const scores = new Map<string, number>();

  for (let index = 0; index < labels.length; index += 500) {
    const batch = labels.slice(index, index + 500);
    const rawRows = await query(
      buildPairScoreQuery(
        truthset,
        batch.map((label) => label.pair_id),
        targetSchema,
        dialect
      )
    );

    const parsedRows = TruthsetScoreRowsSchema.safeParse(rawRows);
    if (!parsedRows.success) {
      const issue = parsedRows.error.issues[0];
      throw new CommandError(
        `Runner query for ${truthset.name} returned invalid truthset score rows: ${issue?.message ?? 'schema validation failed'}`,
        1
      );
    }

    for (const row of parsedRows.data) {
      scores.set(row.pair_id, row.composite_score);
    }
  }

  return scores;
}

export async function fetchTruthsetInsight(
  truthset: ResolvedTruthsetSpec,
  entityGraphDir: string,
  targetSchema: string,
  dialect: SupportedDialect,
  query: SqlQueryRunner,
  requiredPrecisionOverride: number | null
): Promise<TruthsetInsight> {
  const labels = loadTruthsetLabels(truthset);
  const scores = await fetchTruthsetScores(truthset, targetSchema, dialect, query);
  const currentThresholds = resolveThresholds(truthset, entityGraphDir);
  const requiredPrecision = requiredPrecisionOverride ?? truthset.minAutoMergePrecision;
  const currentMetrics = scoreLabels(labels, scores, currentThresholds);
  const recommendedThresholds = tuneThresholds(labels, scores, requiredPrecision);
  const recommendedMetrics = scoreLabels(labels, scores, recommendedThresholds);

  return {
    spec: truthset,
    labelCount: labels.length,
    currentThresholds,
    currentMetrics,
    recommendedThresholds,
    recommendedMetrics,
    requiredPrecision,
  };
}

export async function executeStatements(
  entity: string,
  statements: SqlStatement[],
  runner: SqlRunnerModule,
  quiet: boolean,
  json: boolean
): Promise<ModelExecutionResult[]> {
  return executeSqlStatements(
    statements.map((statement) => ({
      modelName: `${entity}:${statement.name}`,
      sql: statement.sql,
      ignoreErrorPatterns: statement.ignoreErrorPatterns,
      // deps are plain statement names — qualify them the same way modelName
      // is qualified so the executor's failed-upstream skip matches.
      ...(statement.deps ? { deps: statement.deps.map((dep) => `${entity}:${dep}`) } : {}),
    })),
    runner.run,
    {
      onInfo: quiet || json ? undefined : (msg) => out.info(msg),
      onError: (msg) => out.error(msg),
      onSuccess: quiet || json ? undefined : (msg) => out.success(msg),
    }
  );
}

export function toStatementArtifacts(
  statements: SqlStatement[],
  executionResults?: ModelExecutionResult[]
): Array<Record<string, unknown>> {
  if (!executionResults) {
    return statements.map((statement) => ({
      name: statement.name,
      sql: statement.sql,
    }));
  }

  return statements.map((statement, index) => ({
    name: statement.name,
    sql: statement.sql,
    status: executionResults[index]?.status,
    error: executionResults[index]?.error,
    rows_affected: executionResults[index]?.rowsAffected,
  }));
}

export function inferProfileDefaults(name: string): {
  entity: string;
  operation: AgentTaskProfile['operation'];
} {
  if (name.endsWith('_review_batch')) {
    return {
      entity: name.replace(/_review_batch$/, ''),
      operation: 'review_batch',
    };
  }
  if (name.endsWith('_survivorship_refresh')) {
    return {
      entity: name.replace(/_survivorship_refresh$/, ''),
      operation: 'survivorship_refresh',
    };
  }
  if (name.endsWith('_truthset_regress')) {
    return {
      entity: name.replace(/_truthset_regress$/, ''),
      operation: 'truthset_regress',
    };
  }
  if (name.endsWith('_onboard_discover')) {
    return {
      entity: name.replace(/_onboard_discover$/, ''),
      operation: 'onboard_discover',
    };
  }
  if (name.endsWith('_onboard_generate')) {
    return {
      entity: name.replace(/_onboard_generate$/, ''),
      operation: 'onboard_generate',
    };
  }
  if (name.endsWith('_onboard_propose_cleaning')) {
    return {
      entity: name.replace(/_onboard_propose_cleaning$/, ''),
      operation: 'onboard_propose_cleaning',
    };
  }
  if (name.endsWith('_onboard_verify')) {
    return {
      entity: name.replace(/_onboard_verify$/, ''),
      operation: 'onboard_verify',
    };
  }
  return {
    entity: name.replace(/_triage$/, ''),
    operation: name.endsWith('_triage') ? 'triage' : 'review_batch',
  };
}
