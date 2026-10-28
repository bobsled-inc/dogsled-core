import { Command } from 'commander';
import {
  CommandError,
  emitError,
  emitPayload,
  parsePositiveInt,
  resolveOutputFormat,
  type Writer,
} from '@bobsled-inc/protocol';

import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import { resolveCommandWriter } from './utils.js';

interface QueryableRunner {
  query(sql: string): Promise<Record<string, unknown>[]>;
}

export interface MentionsInspectOptions {
  writer?: Writer;
  cwd?: string;
  runner?: string;
  schema?: string;
  chunkId?: string;
  mentionId?: string;
  entityType?: string;
  resolutionMethod?: string;
  limit?: number;
  includeChunk?: boolean;
  quiet?: boolean;
  queryRunner?: QueryableRunner;
}

export interface InspectMention {
  mention_id: string;
  entity_type: string;
  entity_name: string;
  confidence: number | null;
  span_start: number | null;
  span_end: number | null;
  span_text: string | null;
  resolved_entity_id: string | null;
  resolution_method: string;
  resolution_confidence: number | null;
  extraction_role: string | null;
  resolved_profile: {
    entity_id: string;
    entity_type: string | null;
    canonical_name: string | null;
  } | null;
}

export interface InspectRelationshipEvidence {
  evidence_id: string;
  relationship_id: string | null;
  relation_type: string | null;
  evidence_kind: string | null;
  evidence_ref: string | null;
  left_entity_id: string | null;
  left_entity_type: string | null;
  left_entity_name: string | null;
  right_entity_id: string | null;
  right_entity_type: string | null;
  right_entity_name: string | null;
  evidence_excerpt: string | null;
  confidence: number | null;
}

export interface InspectChunk {
  source_uri: string | null;
  document_id: string;
  document_version_id: string | null;
  chunk_id: string;
  chunk_index: number | null;
  chunk_excerpt: string | null;
  chunk_text?: string | null;
  mentions: InspectMention[];
  relationship_evidence: InspectRelationshipEvidence[];
}

export interface MentionsInspectResult {
  ok: true;
  command: 'entity-graph.mentions.inspect';
  schema: string;
  filters: {
    chunk_id?: string;
    mention_id?: string;
    entity_type?: string;
    resolution_method?: string;
    limit: number;
    include_chunk: boolean;
  };
  summary: {
    chunks: number;
    mentions: number;
    relationship_evidence: number;
  };
  chunks: InspectChunk[];
}

const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdentifier(value: string, label: string): string {
  if (SAFE_IDENTIFIER_RE.test(value)) return value;
  throw new CommandError(`${label} must be a safe SQL identifier; received "${value}".`, 2);
}

function tableName(schema: string, table: string): string {
  return `${validateIdentifier(schema, '--schema')}.${table}`;
}

function sqlValue(value: string): string {
  // `mentions inspect` is a legacy --runner diagnostic command with no dialect in
  // scope, so there is no single correct literal escape: '' is rejected by
  // BigQuery ("concatenated string literals must be separated by whitespace or
  // comments") while \' is wrong on ANSI dialects. These filters target
  // id/enum/identifier columns, so reject any apostrophe or backslash
  // rather than guess an escape — provably safe on every dialect.
  if (value.includes("'") || value.includes('\\')) {
    throw new CommandError(
      `mentions inspect filter value contains unsupported characters: "${value}".`,
      2
    );
  }
  return `'${value}'`;
}

function stringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return String(value);
}

function numberField(row: Record<string, unknown>, field: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactText(value: string | null, maxLength = 260): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function spanText(row: Record<string, unknown>, chunkText: string | null): string | null {
  if (chunkText === null) return null;
  const start = numberField(row, 'span_start');
  const end = numberField(row, 'span_end');
  if (start === null || end === null || start < 0 || end <= start || end > chunkText.length) {
    return null;
  }
  return chunkText.slice(start, end);
}

function buildWhere(options: MentionsInspectOptions): string {
  const clauses = ['superseded_at IS NULL'];
  if (options.chunkId) clauses.push(`chunk_id = ${sqlValue(options.chunkId)}`);
  if (options.mentionId) clauses.push(`mention_id = ${sqlValue(options.mentionId)}`);
  if (options.entityType) clauses.push(`entity_type = ${sqlValue(options.entityType)}`);
  if (options.resolutionMethod) {
    clauses.push(`resolution_method = ${sqlValue(options.resolutionMethod)}`);
  }
  return clauses.join(' AND ');
}

function unique(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))];
}

async function optionalQuery(
  runner: QueryableRunner,
  sql: string
): Promise<Record<string, unknown>[]> {
  try {
    return await runner.query(sql);
  } catch {
    return [];
  }
}

async function loadProfiles(
  runner: QueryableRunner,
  schema: string,
  entityIds: readonly string[]
): Promise<Map<string, Record<string, unknown>>> {
  if (entityIds.length === 0) return new Map();
  const quoted = entityIds.map(sqlValue).join(', ');
  const rows = await optionalQuery(
    runner,
    `SELECT * FROM ${tableName(schema, '__entity_profile')} WHERE entity_id IN (${quoted})`
  );
  return new Map(rows.map((row) => [String(row['entity_id']), row]));
}

function profilePayload(
  entityId: string | null,
  profile: Record<string, unknown> | undefined,
  fallbackType?: string | null
): InspectMention['resolved_profile'] {
  if (!entityId) return null;
  return {
    entity_id: entityId,
    entity_type: stringField(profile ?? {}, 'entity_type') ?? fallbackType ?? null,
    canonical_name:
      stringField(profile ?? {}, 'canonical_name') ??
      stringField(profile ?? {}, 'name') ??
      stringField(profile ?? {}, 'entity_name'),
  };
}

function mapMention(
  row: Record<string, unknown>,
  chunkText: string | null,
  profiles: Map<string, Record<string, unknown>>
): InspectMention {
  const resolvedEntityId = stringField(row, 'resolved_entity_id');
  const entityType = stringField(row, 'entity_type') ?? '';
  return {
    mention_id: stringField(row, 'mention_id') ?? '',
    entity_type: entityType,
    entity_name: stringField(row, 'entity_name') ?? '',
    confidence: numberField(row, 'confidence'),
    span_start: numberField(row, 'span_start'),
    span_end: numberField(row, 'span_end'),
    span_text: spanText(row, chunkText),
    resolved_entity_id: resolvedEntityId,
    resolution_method: stringField(row, 'resolution_method') ?? 'unknown',
    resolution_confidence: numberField(row, 'resolution_confidence'),
    extraction_role: stringField(row, 'extraction_role'),
    resolved_profile: profilePayload(
      resolvedEntityId,
      profiles.get(resolvedEntityId ?? ''),
      entityType
    ),
  };
}

function mapEvidence(
  row: Record<string, unknown>,
  profiles: Map<string, Record<string, unknown>>
): InspectRelationshipEvidence {
  const leftEntityId = stringField(row, 'left_entity_id');
  const rightEntityId = stringField(row, 'right_entity_id');
  const left = profilePayload(leftEntityId, profiles.get(leftEntityId ?? ''));
  const right = profilePayload(rightEntityId, profiles.get(rightEntityId ?? ''));
  return {
    evidence_id: stringField(row, 'evidence_id') ?? '',
    relationship_id: stringField(row, 'relationship_id'),
    relation_type: stringField(row, 'relation_type'),
    evidence_kind: stringField(row, 'evidence_kind'),
    evidence_ref: stringField(row, 'evidence_ref'),
    left_entity_id: leftEntityId,
    left_entity_type: left?.entity_type ?? null,
    left_entity_name: left?.canonical_name ?? null,
    right_entity_id: rightEntityId,
    right_entity_type: right?.entity_type ?? null,
    right_entity_name: right?.canonical_name ?? null,
    evidence_excerpt: stringField(row, 'evidence_excerpt'),
    confidence: numberField(row, 'confidence'),
  };
}

export async function inspectMentions(
  options: MentionsInspectOptions
): Promise<MentionsInspectResult> {
  const schema = options.schema ?? 'entity_graph';
  validateIdentifier(schema, '--schema');
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CommandError('--limit must be a positive integer.', 2);
  }

  let resolvedRunner: Awaited<ReturnType<typeof resolveEntityGraphRunner>> | undefined;
  const runner = options.queryRunner;
  const queryRunner =
    runner ??
    (async () => {
      resolvedRunner = await resolveEntityGraphRunner({
        cwd: options.cwd ?? process.cwd(),
        runnerPath: options.runner,
        allowLocalRunnerFallback: true,
      });
      if (!resolvedRunner) {
        throw new CommandError('mentions inspect requires --runner or a local runner.js.', 2);
      }
      if (typeof resolvedRunner.runner.query !== 'function') {
        throw new CommandError('mentions inspect requires a runner with query(sql).', 2);
      }
      return resolvedRunner.runner as QueryableRunner;
    })();

  const activeRunner = runner ?? (await queryRunner);
  try {
    const where = buildWhere(options);
    const mentionRows = await activeRunner.query(
      `SELECT * FROM ${tableName(schema, '__document_mentions')} WHERE ${where} ` +
        `ORDER BY chunk_id, span_start, span_end LIMIT ${limit}`
    );
    const chunkIds = unique([
      options.chunkId,
      ...mentionRows.map((row) => stringField(row, 'chunk_id')),
    ]);
    const chunkRows =
      chunkIds.length > 0
        ? await optionalQuery(
            activeRunner,
            `SELECT * FROM ${tableName(schema, '__chunks')} ` +
              `WHERE chunk_id IN (${chunkIds.map(sqlValue).join(', ')}) ORDER BY chunk_id`
          )
        : [];

    if (
      (options.chunkId || options.mentionId) &&
      mentionRows.length === 0 &&
      chunkRows.length === 0
    ) {
      throw new CommandError('No mention or chunk rows matched the requested inspect filters.', 2);
    }

    const evidenceRows =
      chunkIds.length > 0
        ? await optionalQuery(
            activeRunner,
            `SELECT * FROM ${tableName(schema, '__entity_relationship_evidence')} ` +
              `WHERE source_chunk_id IN (${chunkIds.map(sqlValue).join(', ')}) ` +
              `ORDER BY source_chunk_id, relationship_id, evidence_id LIMIT ${Math.max(limit * 5, 25)}`
          )
        : [];

    const profileIds = unique([
      ...mentionRows.map((row) => stringField(row, 'resolved_entity_id')),
      ...evidenceRows.map((row) => stringField(row, 'left_entity_id')),
      ...evidenceRows.map((row) => stringField(row, 'right_entity_id')),
    ]);
    const profiles = await loadProfiles(activeRunner, schema, profileIds);
    const chunkById = new Map(chunkRows.map((row) => [String(row['chunk_id']), row]));
    const mentionedChunkIds =
      chunkIds.length > 0
        ? chunkIds
        : unique(mentionRows.map((row) => stringField(row, 'chunk_id')));

    const chunks: InspectChunk[] = mentionedChunkIds.map((chunkId) => {
      const chunk = chunkById.get(chunkId);
      const chunkText = stringField(chunk ?? {}, 'chunk_text') ?? stringField(chunk ?? {}, 'text');
      const mentions = mentionRows
        .filter((row) => stringField(row, 'chunk_id') === chunkId)
        .map((row) => mapMention(row, chunkText, profiles));
      const relationshipEvidence = evidenceRows
        .filter((row) => stringField(row, 'source_chunk_id') === chunkId)
        .map((row) => mapEvidence(row, profiles));

      return {
        source_uri: stringField(chunk ?? {}, 'source_uri'),
        document_id:
          stringField(chunk ?? {}, 'document_id') ??
          stringField(
            mentionRows.find((row) => stringField(row, 'chunk_id') === chunkId) ?? {},
            'document_id'
          ) ??
          '',
        document_version_id:
          stringField(chunk ?? {}, 'document_version_id') ??
          stringField(
            mentionRows.find((row) => stringField(row, 'chunk_id') === chunkId) ?? {},
            'document_version_id'
          ),
        chunk_id: chunkId,
        chunk_index: numberField(chunk ?? {}, 'chunk_index'),
        chunk_excerpt: compactText(chunkText),
        ...(options.includeChunk ? { chunk_text: chunkText } : {}),
        mentions,
        relationship_evidence: relationshipEvidence,
      };
    });

    return {
      ok: true,
      command: 'entity-graph.mentions.inspect',
      schema,
      filters: {
        ...(options.chunkId ? { chunk_id: options.chunkId } : {}),
        ...(options.mentionId ? { mention_id: options.mentionId } : {}),
        ...(options.entityType ? { entity_type: options.entityType } : {}),
        ...(options.resolutionMethod ? { resolution_method: options.resolutionMethod } : {}),
        limit,
        include_chunk: options.includeChunk === true,
      },
      summary: {
        chunks: chunks.length,
        mentions: chunks.reduce((sum, chunk) => sum + chunk.mentions.length, 0),
        relationship_evidence: chunks.reduce(
          (sum, chunk) => sum + chunk.relationship_evidence.length,
          0
        ),
      },
      chunks,
    };
  } finally {
    await resolvedRunner?.close();
  }
}

function renderHuman(result: MentionsInspectResult): string {
  const lines = [
    `Mention inspect: ${result.summary.mentions} mention(s), ${result.summary.relationship_evidence} evidence row(s)`,
  ];
  for (const chunk of result.chunks) {
    lines.push('');
    lines.push(`chunk: ${chunk.chunk_id}`);
    lines.push(`document: ${chunk.document_id}`);
    if (chunk.source_uri) lines.push(`source: ${chunk.source_uri}`);
    if (chunk.chunk_excerpt) lines.push(`excerpt: ${chunk.chunk_excerpt}`);
    for (const mention of chunk.mentions) {
      const resolved =
        mention.resolved_profile?.canonical_name ?? mention.resolved_entity_id ?? 'unresolved';
      lines.push(
        `mention: ${mention.entity_type} "${mention.entity_name}" -> ${resolved} ` +
          `(${mention.resolution_method}, ${mention.resolution_confidence ?? 'n/a'})`
      );
    }
    for (const evidence of chunk.relationship_evidence) {
      lines.push(
        `evidence: ${evidence.left_entity_name ?? evidence.left_entity_id ?? '?'} ` +
          `--${evidence.relation_type ?? '?'}--> ` +
          `${evidence.right_entity_name ?? evidence.right_entity_id ?? '?'}`
      );
    }
  }
  return lines.join('\n');
}

export async function runMentionsInspect(options: MentionsInspectOptions = {}): Promise<void> {
  const writer = resolveCommandWriter(options);
  const format = resolveOutputFormat({ json: false, yaml: false });
  try {
    const result = await inspectMentions(options);
    if (!options.quiet) emitPayload(result, format, writer, () => renderHuman(result));
  } catch (err) {
    if (err instanceof CommandError) {
      process.exitCode = err.exitCode;
      emitError(err.message, format, writer);
      return;
    }
    throw err;
  }
}

export function registerMentionsInspectCommand(
  parent: Command,
  options: MentionsInspectOptions = {}
): void {
  parent
    .command('inspect')
    .description('Inspect document mentions, source chunks, and same-chunk relationship evidence')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--schema <name>', 'Schema containing entity graph tables', options.schema)
    .option('--chunk-id <id>', 'Inspect a specific chunk')
    .option('--mention-id <id>', 'Inspect a specific mention')
    .option('--entity-type <type>', 'Filter mentions by entity type')
    .option('--resolution-method <method>', 'Filter mentions by resolution method')
    .option('--limit <n>', 'Maximum mention rows to inspect', parsePositiveInt)
    .option('--include-chunk', 'Include full chunk text in machine-readable output', false)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--yaml', 'Machine-readable YAML output', false)
    .option('--quiet', 'Suppress non-error output', false)
    .action(
      async (opts: {
        runner?: string;
        schema?: string;
        chunkId?: string;
        mentionId?: string;
        entityType?: string;
        resolutionMethod?: string;
        limit?: number;
        includeChunk: boolean;
        json: boolean;
        yaml: boolean;
        quiet: boolean;
      }) => {
        const writer = resolveCommandWriter(options);
        const format = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
        const quiet = opts.quiet || options.quiet === true;
        try {
          const result = await inspectMentions({
            ...options,
            runner: opts.runner ?? options.runner,
            schema: opts.schema ?? options.schema,
            chunkId: opts.chunkId,
            mentionId: opts.mentionId,
            entityType: opts.entityType,
            resolutionMethod: opts.resolutionMethod,
            limit: opts.limit ?? options.limit,
            includeChunk: opts.includeChunk || options.includeChunk === true,
          });
          if (!quiet) emitPayload(result, format, writer, () => renderHuman(result));
        } catch (err) {
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, format, writer);
            return;
          }
          throw err;
        }
      }
    );
}
