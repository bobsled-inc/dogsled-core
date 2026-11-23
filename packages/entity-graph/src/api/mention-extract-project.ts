import * as path from 'node:path';

import {
  MentionExtractionSpecSchema,
  ResolutionSpecSchema,
  buildFqName,
  quoteIdentifier,
  type MentionExtractionSpec,
  type ResolutionSpec,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';
import type { CustomRunnerRegistry } from '@bobsled-inc/connections';

import {
  discoverTypedSpecs,
  type ExtractCommandResult,
} from '../commands/extract-command-utils.js';
import { outputTableName } from '../compiler/output-tables/index.js';
import {
  createCandidateRetrieval,
  type SupportedRetrievalDialect,
} from '../runtime/candidate-retrieval/registry.js';
import type {
  Candidate,
  CandidateRetrievalRow,
  CandidateRetrievalInput,
  CandidateRetrievalStrategy,
} from '../runtime/candidate-retrieval/interface.js';
import {
  createCompromiseFallback,
  type CompromiseFallback,
} from '../runtime/mention/compromise-fallback.js';
import { extractChunk } from '../runtime/mention/extract-chunk.js';
import type { MentionExtractionDiagnostics } from '../runtime/mention/extract-chunk.js';
import type { EntitySemanticContext, LlmCall, MentionRow } from '../runtime/mention/extract.js';
import type { ProfileAliasCandidate } from '../runtime/mention/profile-alias.js';
import type { SurfaceProposalCall } from '../runtime/mention/surface-proposer.js';
import { PerSourceRateLimiter } from '../runtime/mention/budget.js';
import { castToString } from '../compiler/identity/sql.js';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import {
  createAiMentionLlmCall,
  createAiSurfaceProposer,
  insertRows,
  mapWithConcurrency,
  normalizeFallbackMode,
  readChunks,
  readString,
  type FallbackMode,
  type QueryableRunner,
  sqlValue,
} from './extract-project-utils.js';
import { wrapMentionLlmCall, wrapSurfaceProposer } from './mention-ai-budget.js';

export interface ExtractMentionsProjectOptions extends EntityGraphProjectOptions {
  entity: string;
  runner?: string;
  specDir?: string;
  fallback?: string;
  concurrency?: number;
  batchSize?: number;
  dryRun?: boolean;
  llmCall?: LlmCall;
  surfaceProposer?: SurfaceProposalCall;
  fallbackExtractor?: CompromiseFallback;
  rateLimiter?: Pick<PerSourceRateLimiter, 'consume'>;
  now?: () => Date;
  /**
   * Custom runner registry for integration-backed execution. Mirrors the
   * resolve / cluster / apply-decisions path (`ResolveWorkflowOptions.customRunners`):
   * when present it lets BigQuery / Snowflake runs authenticate via pre-minted,
   * decrypted tokens, for a host application that can't use Dogsled's built-in
   * runners, such as `(bigquery, adc)`.
   * Forwarded verbatim to `resolveEntityGraphRunner`; consulted only on the
   * integration branch and ignored when an explicit `--runner <path>` is set.
   * Omitted entirely when unset so DuckDB / Postgres runs behave exactly as
   * before.
   */
  customRunners?: CustomRunnerRegistry;
}

const MENTION_COLUMNS = [
  'mention_id',
  'chunk_id',
  'document_version_id',
  'document_id',
  'entity_type',
  'entity_name',
  'confidence',
  'span_start',
  'span_end',
  'resolved_entity_id',
  'resolution_method',
  'resolution_confidence',
  'superseded_at',
  'extracted_at',
  'extraction_role',
  'notes',
] as const;

const MAX_CANDIDATE_CACHE_ENTRIES = 10_000;

interface MentionInsertRow {
  mention_id: string;
  chunk_id: string;
  document_version_id: string;
  document_id: string;
  entity_type: string;
  entity_name: string;
  confidence: number;
  span_start: number;
  span_end: number;
  resolved_entity_id: string | null;
  resolution_method: string;
  resolution_confidence: number | null;
  superseded_at: string | null;
  extracted_at: string;
  extraction_role: string;
  notes: string | null;
}

function toRetrievalDialect(dialect: SupportedDialect): SupportedRetrievalDialect {
  if (
    dialect === 'duckdb' ||
    dialect === 'postgres' ||
    dialect === 'snowflake' ||
    dialect === 'bigquery'
  ) {
    return dialect;
  }
  if (dialect === 'pgvector' || dialect === 'redshift') return 'postgres';
  throw new CommandError(
    `mention extraction candidate retrieval is not wired for dialect '${dialect}'. Use a DuckDB, Postgres, Snowflake, or BigQuery runner.`,
    2
  );
}

function matchingSpecs(
  specDir: string,
  entity: string
): Array<MentionExtractionSpec & { filePath: string }> {
  return discoverTypedSpecs(specDir, 'mention_extraction', MentionExtractionSpecSchema).filter(
    (spec) => spec.entity_types.includes(entity) || spec.name === entity
  );
}

function entitySemanticsByType(specDir: string): Map<string, EntitySemanticContext> {
  const out = new Map<string, EntitySemanticContext>();
  for (const spec of discoverTypedSpecs(specDir, 'resolution', ResolutionSpecSchema)) {
    const resolution = spec as ResolutionSpec & { filePath: string };
    if (!resolution.entity_semantics) continue;
    const semantics = resolution.entity_semantics;
    out.set(resolution.name, {
      entity_type: resolution.name,
      ...(semantics.definition ? { definition: semantics.definition } : {}),
      ...(semantics.categories ? { categories: semantics.categories } : {}),
      ...(semantics.positive_examples ? { positive_examples: semantics.positive_examples } : {}),
      ...(semantics.negative_examples ? { negative_examples: semantics.negative_examples } : {}),
    });
  }
  return out;
}

function withCandidateCache(strategy: CandidateRetrievalStrategy): CandidateRetrievalStrategy {
  const cache = new Map<string, Promise<Candidate[]>>();
  return {
    dialect: strategy.dialect,
    retrieve(input: CandidateRetrievalInput) {
      const key = JSON.stringify([
        input.mention_text,
        input.k,
        input.min_sim,
        [...(input.entity_types ?? [])].sort(),
      ]);
      let cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      if (cache.size >= MAX_CANDIDATE_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cached = strategy.retrieve(input);
      cache.set(key, cached);
      return cached;
    },
  };
}

function createMentionDiagnostics(): MentionExtractionDiagnostics & {
  missing_entity_semantics: string[];
} {
  return {
    surface_proposer_failures: {},
    fallback_none_chunks: 0,
    dropped_generic_spans: 0,
    dropped_surface_spans: {},
    profile_alias_matches: 0,
    missing_entity_semantics: [],
  };
}

function parseProfileAttrs(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function aliasesFromProfileAttrs(value: string | undefined): string[] {
  const attrs = parseProfileAttrs(value);
  const raw = attrs?.['aliases_json'];
  const aliasValue =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return raw;
          }
        })()
      : raw;
  if (Array.isArray(aliasValue)) {
    return aliasValue.filter((alias): alias is string => typeof alias === 'string');
  }
  return typeof aliasValue === 'string' && aliasValue.length > 0 ? [aliasValue] : [];
}

function isMentionEligible(value: string | undefined): boolean {
  const attrs = parseProfileAttrs(value);
  const eligible = attrs?.['mention_eligible'];
  return eligible !== false && String(eligible).toLowerCase() !== 'false';
}

async function readProfileAliasCandidates(options: {
  runner: QueryableRunner;
  profileTable: string;
  dialect: SupportedDialect;
  entityTypes: readonly string[];
}): Promise<ProfileAliasCandidate[]> {
  if (!options.runner.query) return [];
  const entityType = quoteIdentifier('entity_type', options.dialect);
  const entityFilter =
    options.entityTypes.length === 0
      ? ''
      : `WHERE ${entityType} IN (${options.entityTypes
          .map((value) => sqlValue(value, options.dialect))
          .join(', ')})`;
  try {
    const rows = await options.runner.query(
      `SELECT
         ${quoteIdentifier('entity_id', options.dialect)} AS ${quoteIdentifier('entity_id', options.dialect)},
         ${entityType} AS ${quoteIdentifier('entity_type', options.dialect)},
         ${quoteIdentifier('canonical_name', options.dialect)} AS ${quoteIdentifier('canonical_name', options.dialect)},
         ${castToString(quoteIdentifier('profile_attrs', options.dialect), options.dialect)} AS ${quoteIdentifier('profile_attrs', options.dialect)}
       FROM ${options.profileTable}
       ${entityFilter}`
    );
    return rows
      .filter((row) => isMentionEligible(readString(row, 'profile_attrs')))
      .map((row) => ({
        entity_id: readString(row, 'entity_id') ?? '',
        entity_type: readString(row, 'entity_type') ?? '',
        canonical_name: readString(row, 'canonical_name') ?? '',
        aliases: aliasesFromProfileAttrs(readString(row, 'profile_attrs')),
      }))
      .filter(
        (candidate) =>
          candidate.entity_id.length > 0 &&
          candidate.entity_type.length > 0 &&
          candidate.canonical_name.length > 0
      );
  } catch {
    return [];
  }
}

function mentionRowsForInsert(rows: readonly MentionRow[]): MentionInsertRow[] {
  return rows.map((row) => ({
    ...row,
    notes: row.notes ? JSON.stringify(row.notes) : null,
  }));
}

function incrementCounts(counts: Record<string, number>, rows: readonly MentionRow[]): void {
  for (const row of rows) {
    counts[row.resolution_method] = (counts[row.resolution_method] ?? 0) + 1;
  }
}

function batch<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new CommandError('--batch-size must be a positive integer.', 2);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function extractMentionsProject(
  options: ExtractMentionsProjectOptions
): Promise<ExtractCommandResult> {
  const fallbackMode: FallbackMode = normalizeFallbackMode(options.fallback) ?? 'compromise';
  const context = await loadEntityGraphProjectContext({
    ...options,
    dialect: options.dialect ?? (options.integration ? undefined : 'duckdb'),
    entityNames: [options.entity],
  });
  const schema = options.schema ?? context.targetSchema;
  const dialect = context.dialect;
  const forceFallback = options.fallback !== undefined && fallbackMode === 'compromise';
  const specDir = options.specDir ? path.resolve(context.cwd, options.specDir) : context.mdmDir;
  const specs = matchingSpecs(specDir, options.entity);
  const semanticsByType = entitySemanticsByType(specDir);
  const specRefs = specs.map((spec) => ({ name: spec.name, path: spec.filePath }));
  const dryRun = options.dryRun === true;
  const concurrency = options.concurrency ?? 5;
  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new CommandError('--concurrency must be a positive integer.', 2);
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new CommandError('--batch-size must be a positive integer.', 2);
  }

  if (specs.length === 0) {
    return {
      ok: true,
      command: 'entity-graph.mentions.extract',
      entity: options.entity,
      schema,
      dry_run: dryRun,
      executed: !dryRun,
      spec_count: 0,
      specs: [],
      chunks_processed: 0,
      count: 0,
      by_resolution_method: {},
      budget_used: 0,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      command: 'entity-graph.mentions.extract',
      entity: options.entity,
      schema,
      dry_run: true,
      executed: false,
      spec_count: specRefs.length,
      specs: specRefs,
      chunks_processed: 0,
      count: 0,
      by_resolution_method: {},
      budget_used: 0,
    };
  }

  const runnerHandle = await resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    allowLocalRunnerFallback: false,
    ...(options.customRunners ? { customRunners: options.customRunners } : {}),
  });
  if (!runnerHandle) {
    throw new CommandError('mentions extract requires --runner <path> unless --dry-run is set.', 2);
  }

  let budgetUsed = 0;
  let budgetExhausted = false;
  const byResolutionMethod: Record<string, number> = {};
  const diagnostics = createMentionDiagnostics();
  let count = 0;

  try {
    const runner = runnerHandle.runner as QueryableRunner;
    const chunks = await readChunks(runner, schema, dialect);
    const mentionTable = buildFqName(schema, '__document_mentions', dialect);
    const sourceHandle = context.integration?.handle ?? 'local';
    const rateLimiter = options.rateLimiter ?? new PerSourceRateLimiter({ perSourceRpm: 60 });

    for (const spec of specs) {
      const fallback =
        options.fallbackExtractor ??
        createCompromiseFallback({
          entityTypes: spec.entity_types.length === 1 ? spec.entity_types : undefined,
        });
      const entitySemantics = spec.entity_types
        .map((entityType) => semanticsByType.get(entityType))
        .filter((semantic): semantic is EntitySemanticContext => semantic !== undefined);
      if (spec.entity_types.length > 1) {
        for (const entityType of spec.entity_types) {
          if (!semanticsByType.has(entityType)) {
            diagnostics.missing_entity_semantics.push(entityType);
          }
        }
      }
      const aiLlmCall =
        options.llmCall ??
        (forceFallback
          ? undefined
          : await createAiMentionLlmCall(spec.extraction_role, context.cwd));
      const aiSurfaceProposer =
        options.surfaceProposer ??
        (forceFallback
          ? undefined
          : await createAiSurfaceProposer(spec.extraction_role, context.cwd));
      if (!aiLlmCall && fallbackMode === 'none') {
        throw new CommandError(
          `No platform.models role configured for '${spec.extraction_role}' and --fallback none was set.`,
          2
        );
      }
      const llmCall = aiLlmCall
        ? wrapMentionLlmCall(aiLlmCall, {
            rateLimiter,
            sourceHandle,
            markBudgetExhausted: () => {
              budgetExhausted = true;
            },
            addBudgetUsed: (amount) => {
              budgetUsed += amount;
            },
          })
        : undefined;
      const surfaceProposer = aiSurfaceProposer
        ? wrapSurfaceProposer(aiSurfaceProposer, {
            rateLimiter,
            sourceHandle,
            markBudgetExhausted: () => {
              budgetExhausted = true;
            },
            addBudgetUsed: (amount) => {
              budgetUsed += amount;
            },
          })
        : undefined;
      const profileTable = [
        schema,
        spec.entity_types.length === 1
          ? outputTableName(spec.entity_types[0]!, '__entity_profile')
          : '__entity_profile',
      ].join('.');
      const profileAliasCandidates = await readProfileAliasCandidates({
        runner,
        profileTable: buildFqName(
          schema,
          spec.entity_types.length === 1
            ? outputTableName(spec.entity_types[0]!, '__entity_profile')
            : '__entity_profile',
          dialect
        ),
        dialect,
        entityTypes: spec.entity_types,
      });
      const strategy = withCandidateCache(
        createCandidateRetrieval({
          dialect: toRetrievalDialect(dialect),
          profileTable,
          runner: {
            query: async (sql) => (await runner.query!(sql)) as unknown as CandidateRetrievalRow[],
          },
        })
      );

      for (const chunkBatch of batch(chunks, batchSize)) {
        const rowsByChunk = await mapWithConcurrency(chunkBatch, concurrency, (chunk) =>
          extractChunk(chunk, {
            strategy,
            fallback,
            extractionRole: spec.extraction_role,
            mode: llmCall && !budgetExhausted ? 'primary' : 'fallback',
            llmCall,
            surfaceProposer: llmCall && !budgetExhausted ? surfaceProposer : undefined,
            fallbackMode,
            surfaceFilters: spec.surface_filters,
            profileAliasCandidates,
            diagnostics,
            k: spec.candidate_retrieval.k,
            minSim: spec.candidate_retrieval.min_similarity,
            allowedEntityTypes: spec.entity_types,
            candidateLedEntityType: spec.entity_types.length > 1,
            entitySemantics,
            now: options.now,
          })
        );
        const rows = rowsByChunk.flat();
        await insertRows(
          runner,
          mentionTable,
          MENTION_COLUMNS,
          mentionRowsForInsert(rows),
          dialect
        );
        incrementCounts(byResolutionMethod, rows);
        count += rows.length;
      }
    }

    return {
      ok: true,
      command: 'entity-graph.mentions.extract',
      entity: options.entity,
      schema,
      dry_run: dryRun,
      executed: !dryRun,
      spec_count: specRefs.length,
      specs: specRefs,
      chunks_processed: chunks.length,
      count,
      by_resolution_method: byResolutionMethod,
      budget_used: budgetUsed,
      diagnostics,
    };
  } finally {
    await runnerHandle.close();
  }
}
