import * as path from 'node:path';

import {
  RelationshipExtractionSpecSchema,
  ResolutionSpecSchema,
  buildFqName,
  type RelationshipExtractionSpec,
  type ResolutionSpec,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';
import type { CustomRunnerRegistry } from '@bobsled-inc/connections';

import {
  discoverTypedSpecs,
  type ExtractCommandResult,
} from '../commands/extract-command-utils.js';
import {
  discoverRelationshipOntologySpecs,
  resolveRelationshipOntologySpec,
} from '../compiler/ontology/parser.js';
import type { ResolvedRelationshipOntology } from '../compiler/ontology/types.js';
import {
  writeRelationshipEvidence,
  type RelationshipEvidenceStore,
} from '../runtime/relationship/evidence-writer.js';
import {
  extractRelationshipsForChunk,
  type RelationshipLlmCall,
  type RelationshipExtractionChunkDiagnostics,
} from '../runtime/relationship/llm-extractor.js';
import type { CandidatePairRules } from '../runtime/relationship/candidate-pairs.js';
import type { EntitySemanticContext } from '../runtime/mention/extract.js';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import {
  createAiRelationshipLlmCall,
  insertRows,
  mapWithConcurrency,
  normalizeFallbackMode,
  readChunks,
  readNumber,
  readString,
  requiredString,
  sqlValue,
  type FallbackMode,
  type QueryableRunner,
} from './extract-project-utils.js';
import {
  fallbackEvidenceRows,
  type StoredRelationshipMention,
} from './relationship-extract-fallback.js';

export interface ExtractRelationshipsProjectOptions extends EntityGraphProjectOptions {
  entity: string;
  runner?: string;
  specDir?: string;
  fallback?: string;
  concurrency?: number;
  batchSize?: number;
  llmCall?: RelationshipLlmCall;
  now?: () => Date;
  /**
   * Custom runner registry for integration-backed execution. Mirrors the
   * resolve / cluster / apply-decisions path (`ResolveWorkflowOptions.customRunners`):
   * when present it lets BigQuery / Snowflake runs authenticate via pre-minted,
   * decrypted tokens, because the managed platform can't use Bobsled Core's built-in
   * `(bigquery, adc)` / `(snowflake, sledhouse_oidc)` runners on LangSmith Cloud.
   * Forwarded verbatim to `resolveEntityGraphRunner`; consulted only on the
   * integration branch and ignored when an explicit `--runner <path>` is set.
   * Omitted entirely when unset so DuckDB / Postgres runs behave exactly as
   * before.
   */
  customRunners?: CustomRunnerRegistry;
}

const EVIDENCE_COLUMNS = [
  'evidence_id',
  'relationship_id',
  'relation_type',
  'left_entity_id',
  'right_entity_id',
  'evidence_kind',
  'evidence_ref',
  'source_document_id',
  'source_document_version_id',
  'source_chunk_id',
  'span_start',
  'span_end',
  'evidence_excerpt',
  'confidence',
  'extraction_role',
  'prompt_version',
  'ontology_version',
  'model_metadata',
  'injection_markers',
  'review_flag',
  'observed_at',
  'recorded_at',
] as const;

function matchingSpecs(
  specDir: string,
  entity: string
): Array<RelationshipExtractionSpec & { filePath: string }> {
  return discoverTypedSpecs(
    specDir,
    'relationship_extraction',
    RelationshipExtractionSpecSchema
  ).filter((spec) => spec.name === entity || spec.name.startsWith(`${entity}_`));
}

function evidenceStore(
  runner: QueryableRunner,
  table: string,
  dialect: SupportedDialect
): RelationshipEvidenceStore {
  return {
    async hasEvidenceBatch(evidenceIds) {
      if (evidenceIds.length === 0) return new Set<string>();
      const query = runner.query;
      if (!query) return new Set<string>();
      const idsSql = evidenceIds.map((id) => sqlValue(id, dialect)).join(', ');
      const rows = await query(`SELECT evidence_id FROM ${table} WHERE evidence_id IN (${idsSql})`);
      return new Set(
        rows.map((row) => readString(row, 'evidence_id')).filter((id): id is string => !!id)
      );
    },
    async appendEvidence(row) {
      await insertRows(runner, table, EVIDENCE_COLUMNS, [row], dialect);
    },
  };
}

async function readCommittedMentions(
  runner: QueryableRunner,
  schema: string,
  dialect: SupportedDialect
): Promise<StoredRelationshipMention[]> {
  if (!runner.query) {
    throw new CommandError('relationship extraction requires a runner that exports query(sql).', 2);
  }
  const table = buildFqName(schema, '__document_mentions', dialect);
  const profileTable = buildFqName(schema, '__entity_profile', dialect);
  const rows = await runner.query(
    `SELECT m.*
     FROM ${table} m
     JOIN ${profileTable} p
       ON p.entity_id = m.resolved_entity_id
      AND p.entity_type = m.entity_type
     WHERE m.resolved_entity_id IS NOT NULL
       AND m.resolution_method IN ('exact_match', 'llm_disambiguation')
       AND m.superseded_at IS NULL`
  );
  return rows.map((row) => {
    const spanStart = readNumber(row, 'span_start');
    const spanEnd = readNumber(row, 'span_end');
    const mention: StoredRelationshipMention = {
      mention_id: requiredString(row, 'mention_id', '__document_mentions'),
      chunk_id: requiredString(row, 'chunk_id', '__document_mentions'),
      document_id: requiredString(row, 'document_id', '__document_mentions'),
      document_version_id: requiredString(row, 'document_version_id', '__document_mentions'),
      entity_type: requiredString(row, 'entity_type', '__document_mentions'),
      resolved_entity_id: requiredString(row, 'resolved_entity_id', '__document_mentions'),
      confidence: readNumber(row, 'confidence') ?? 0,
      resolution_confidence: readNumber(row, 'resolution_confidence') ?? 0,
    };
    const entityName = readString(row, 'entity_name');
    if (entityName !== undefined) mention.entity_name = entityName;
    if (spanStart !== undefined) mention.span_start = spanStart;
    if (spanEnd !== undefined) mention.span_end = spanEnd;
    return mention;
  });
}

function groupByChunk<T extends { chunk_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const group = out.get(row.chunk_id) ?? [];
    group.push(row);
    out.set(row.chunk_id, group);
  }
  return out;
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

function ontologyMap(
  specDir: string,
  projectRoot: string
): Map<string, ResolvedRelationshipOntology> {
  return new Map(
    discoverRelationshipOntologySpecs(specDir, projectRoot).map((spec) => [
      spec.name,
      resolveRelationshipOntologySpec(spec),
    ])
  );
}

function withDefaultPairDistanceCap(
  rules: RelationshipExtractionSpec['candidate_pair_rules']
): CandidatePairRules {
  return {
    ...rules,
    max_pair_span_distance_chars: rules.max_pair_span_distance_chars ?? 500,
  };
}

interface RelationshipExtractionDiagnostics extends RelationshipExtractionChunkDiagnostics {
  budget_used: number;
}

function createRelationshipDiagnostics(): RelationshipExtractionDiagnostics {
  return {
    candidate_pairs_considered: 0,
    llm_calls: 0,
    accepted_relationships: 0,
    inserted_relationships: 0,
    skipped_relationships: 0,
    rejected_relationships_by_reason: {},
    provider_failures: {},
    zero_row_chunks: 0,
    budget_used: 0,
  };
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function budgetUsedFromResult(result: {
  evidence: Array<{ model_metadata: string | null }>;
}): number {
  return result.evidence.reduce((sum, row) => {
    if (!row.model_metadata) return sum;
    try {
      const parsed = JSON.parse(row.model_metadata) as unknown;
      const cost =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)['cost_usd']
          : undefined;
      return typeof cost === 'number' && Number.isFinite(cost) ? sum + cost : sum;
    } catch {
      return sum;
    }
  }, 0);
}

function aggregateRelationshipDiagnostics(
  target: RelationshipExtractionDiagnostics,
  source: RelationshipExtractionChunkDiagnostics
): void {
  target.candidate_pairs_considered += source.candidate_pairs_considered;
  target.llm_calls += source.llm_calls;
  target.accepted_relationships += source.accepted_relationships;
  target.inserted_relationships += source.inserted_relationships;
  target.skipped_relationships += source.skipped_relationships;
  target.zero_row_chunks += source.zero_row_chunks;
  addCounts(target.rejected_relationships_by_reason, source.rejected_relationships_by_reason);
  addCounts(target.provider_failures, source.provider_failures);
}

export async function extractRelationshipsProject(
  options: ExtractRelationshipsProjectOptions
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
  const specRefs = specs.map((spec) => ({ name: spec.name, path: spec.filePath }));
  const ontologies = ontologyMap(specDir, context.cwd);
  const semanticsByType = entitySemanticsByType(specDir);

  if (specs.length === 0) {
    return {
      ok: true,
      command: 'entity-graph.relationships.extract',
      entity: options.entity,
      schema,
      dry_run: false,
      executed: true,
      spec_count: 0,
      specs: [],
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
    throw new CommandError(
      'relationships extract requires --runner <path> unless --dry-run is set.',
      2
    );
  }

  try {
    const runner = runnerHandle.runner as QueryableRunner;
    const chunks = await readChunks(runner, schema, dialect);
    const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
    const mentions = await readCommittedMentions(runner, schema, dialect);
    const mentionsByChunk = groupByChunk(mentions);
    const evidenceTable = buildFqName(schema, '__entity_relationship_evidence', dialect);
    const store = evidenceStore(runner, evidenceTable, dialect);
    const byResolutionMethod: Record<string, number> = {};
    const diagnostics = createRelationshipDiagnostics();
    let count = 0;

    for (const spec of specs) {
      const ontology = ontologies.get(spec.ontology_ref);
      if (!ontology) {
        throw new CommandError(
          `relationship_extraction '${spec.name}' references unknown ontology_ref '${spec.ontology_ref}'.`,
          2
        );
      }
      const llmCall =
        options.llmCall ??
        (forceFallback
          ? undefined
          : await createAiRelationshipLlmCall(spec.extraction.role, context.cwd));
      const entitySemantics = ontology.entityTypes
        .map((entityType) => semanticsByType.get(entityType))
        .filter((semantic): semantic is EntitySemanticContext => semantic !== undefined);

      if (!llmCall) {
        if (fallbackMode === 'none') {
          throw new CommandError(
            `No platform.models role configured for '${spec.extraction.role}' and --fallback none was set.`,
            2
          );
        }
        const writeResult = await writeRelationshipEvidence(
          fallbackEvidenceRows(
            spec,
            ontology,
            chunksById,
            mentionsByChunk,
            options.now ?? (() => new Date()),
            withDefaultPairDistanceCap(spec.candidate_pair_rules)
          ),
          store
        );
        count += writeResult.inserted;
        diagnostics.inserted_relationships += writeResult.inserted;
        diagnostics.skipped_relationships += writeResult.skipped;
        byResolutionMethod.mention_link =
          (byResolutionMethod.mention_link ?? 0) + writeResult.inserted;
        continue;
      }

      const eligibleChunks = chunks.filter((chunk) => {
        const group = mentionsByChunk.get(chunk.chunk_id) ?? [];
        return (
          group.filter((mention) => mention.resolved_entity_id).length >=
          spec.chunk_filter.has_resolved_mentions_min
        );
      });
      const results = await mapWithConcurrency(eligibleChunks, options.concurrency ?? 5, (chunk) =>
        extractRelationshipsForChunk(
          {
            chunk_id: chunk.chunk_id,
            chunk_text: chunk.chunk_text,
            document_id: chunk.document_id,
            document_version_id: chunk.document_version_id,
            ...(chunk.document_format ? { document_format: chunk.document_format } : {}),
            mentions: mentionsByChunk.get(chunk.chunk_id) ?? [],
          },
          {
            ontology,
            llmCall,
            extractionRole: spec.extraction.role,
            promptVersion: spec.extraction.prompt_version,
            candidatePairRules: withDefaultPairDistanceCap(spec.candidate_pair_rules),
            entitySemantics,
            requireSpanEvidence: spec.extraction.require_span_evidence,
            documentFormatIn: spec.chunk_filter.document_format_in,
            hasResolvedMentionsMin: spec.chunk_filter.has_resolved_mentions_min,
            store,
            now: options.now,
          }
        )
      );
      const inserted = results.reduce((sum, result) => sum + result.inserted, 0);
      for (const result of results) {
        aggregateRelationshipDiagnostics(diagnostics, result.diagnostics);
        diagnostics.budget_used += budgetUsedFromResult(result);
      }
      count += inserted;
      byResolutionMethod.llm_extraction = (byResolutionMethod.llm_extraction ?? 0) + inserted;
    }

    return {
      ok: true,
      command: 'entity-graph.relationships.extract',
      entity: options.entity,
      schema,
      dry_run: false,
      executed: true,
      spec_count: specRefs.length,
      specs: specRefs,
      chunks_processed: mentionsByChunk.size,
      count,
      by_resolution_method: byResolutionMethod,
      budget_used: diagnostics.budget_used,
      diagnostics,
    };
  } finally {
    await runnerHandle.close();
  }
}
