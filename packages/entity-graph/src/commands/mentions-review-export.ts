/**
 * `dogsled entity-graph mentions review export` CLI.
 *
 * Reuses the `dogsled model review export` envelope shape per the locked
 * decision — same CSV header / row format, with mention-specific data
 * columns appended after the standard envelope. Lives as a thin wrapper
 * around an upstream review-export query the runtime emits.
 *
 * `--json` and `--yaml` outputs supported per AGENTS.md.
 */

import { Command } from 'commander';
import {
  CommandError,
  emitError,
  resolveOutputFormat,
  toYaml,
  type Writer,
} from '@bobsled-inc/protocol';
import { loadRunnerModule, parsePositiveIntOption } from '@bobsled-inc/model-spec/shared';

import { assertSafeIdentifier } from '../runtime/candidate-retrieval/sql-utils.js';
import {
  coerceNullableString,
  coerceNumber,
  coerceOneOf,
  coerceString,
  escapeCsv,
  readField,
  type ReviewExportRow,
} from './review-export-utils.js';
import { resolveCommandWriter } from './utils.js';

const MENTION_REVIEW_DECISIONS = [
  'auto_merge',
  'agent_applied',
  'agent_review',
  'human_review',
  'unresolved',
] as const;

type MentionReviewDecision = (typeof MENTION_REVIEW_DECISIONS)[number];

/**
 * Structured `notes` payload on each exported row. Captures the
 * `__document_mentions.notes` column shape declared in the
 * `__document_mentions` contract. Typed shape instead of
 * `Record<string, unknown>` so consumers know the conventional fields.
 */
export interface MentionExportNotes {
  /** `instruction_override`, `unicode_homograph`, `literal_tag_strip`, ... */
  injection_markers?: string[];
  /** Surfaced when the LLM's confidence falls between human-review and high. */
  review_flag?: boolean;
  /** Free-form audit fields (kept loose for forward-compat). */
  [extra: string]: unknown;
}

export interface MentionsReviewExportRow {
  /** Standard model-review envelope columns (parity-locked). */
  review_id: string;
  decision: MentionReviewDecision;
  confidence: number;
  /** Mention-specific columns — always after the envelope. */
  mention_id: string;
  chunk_id: string;
  document_id: string;
  entity_type: string;
  entity_name: string;
  resolved_entity_id: string | null;
  resolution_method: string;
  notes: MentionExportNotes | null;
}

export interface MentionsReviewExportOptions {
  /** Test seam — defaults to `defaultWriter()` (writes to real stdout/stderr). */
  writer?: Writer;
  /** @deprecated Use `writer`. Retained for backward compatibility. */
  write?: (output: string) => void;
  /** Test seam — runner that returns review rows. */
  fetcher?: () => Promise<MentionsReviewExportRow[]>;
  /** CLI path to a SQL runner module with query(sql). */
  runner?: string;
  /** Fully qualified mentions table. Defaults to `entity_graph.__document_mentions`. */
  table?: string;
  /** Schema used when `table` is omitted. */
  schema?: string;
  /** Include rows that would otherwise be below the mention-review filter. */
  all?: boolean;
  /** Maximum rows to return. */
  limit?: number;
  verbose?: boolean;
  quiet?: boolean;
}

const STANDARD_HEADERS = ['review_id', 'decision', 'confidence'];
const MENTION_HEADERS = [
  'mention_id',
  'chunk_id',
  'document_id',
  'entity_type',
  'entity_name',
  'resolved_entity_id',
  'resolution_method',
  'notes',
];

function normalizeNotesObject(input: Record<string, unknown>): MentionExportNotes {
  // Coerce the published `notes` shape into MentionExportNotes:
  //   - injection_marker (singular string) → injection_markers: [marker]
  //   - injection_markers (any) → coerced to string[]
  //   - other recognized fields (review_flag, raw, ...) preserved
  // Keeps a single stable injection_markers field per the public type
  //.
  const out: MentionExportNotes = { ...input };
  const markers: unknown = (input as { injection_markers?: unknown }).injection_markers;
  const singular: unknown = (input as { injection_marker?: unknown }).injection_marker;
  const collected: string[] = [];
  if (Array.isArray(markers)) {
    for (const m of markers) {
      if (typeof m === 'string') collected.push(m);
      else if (m != null) collected.push(String(m));
    }
  } else if (typeof markers === 'string') {
    collected.push(markers);
  }
  if (typeof singular === 'string') collected.push(singular);
  if (collected.length > 0) {
    out.injection_markers = collected;
  } else if ('injection_markers' in out && !Array.isArray(out.injection_markers)) {
    delete out.injection_markers;
  }
  // injection_marker (singular) is not part of the public contract — drop it.
  delete (out as { injection_marker?: unknown }).injection_marker;
  if (typeof input['review_flag'] === 'boolean') {
    out.review_flag = input['review_flag'];
  }
  return out;
}

function parseMaybeJson(value: unknown): MentionExportNotes | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeNotesObject(value as Record<string, unknown>);
  }
  if (typeof value === 'object') return { raw: value };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeNotesObject(parsed as Record<string, unknown>);
      }
      return { raw: value };
    } catch {
      return { raw: value };
    }
  }
  return { raw: value };
}

function coerceDecision(value: unknown): MentionReviewDecision {
  return coerceOneOf(value, MENTION_REVIEW_DECISIONS, 'decision');
}

interface MentionsReviewExportSourceRow extends ReviewExportRow {
  review_id?: unknown;
  decision?: unknown;
  confidence?: unknown;
  mention_id?: unknown;
  chunk_id?: unknown;
  document_id?: unknown;
  entity_type?: unknown;
  entity_name?: unknown;
  resolved_entity_id?: unknown;
  resolution_method?: unknown;
  notes?: unknown;
}

function normalizeRunnerRow(row: MentionsReviewExportSourceRow): MentionsReviewExportRow {
  const mentionId = coerceString(readField(row, 'mention_id'), 'mention_id');
  return {
    review_id: coerceString(readField(row, 'review_id') ?? mentionId, 'review_id'),
    decision: coerceDecision(readField(row, 'decision')),
    confidence: coerceNumber(readField(row, 'confidence'), 'confidence'),
    mention_id: mentionId,
    chunk_id: coerceString(readField(row, 'chunk_id'), 'chunk_id'),
    document_id: coerceString(readField(row, 'document_id'), 'document_id'),
    entity_type: coerceString(readField(row, 'entity_type'), 'entity_type'),
    entity_name: coerceString(readField(row, 'entity_name'), 'entity_name'),
    resolved_entity_id: coerceNullableString(readField(row, 'resolved_entity_id')),
    resolution_method: coerceString(readField(row, 'resolution_method'), 'resolution_method'),
    notes: parseMaybeJson(readField(row, 'notes')),
  };
}

export function buildMentionsReviewExportQuery(options: {
  table?: string;
  schema?: string;
  all?: boolean;
  limit?: number;
}): string {
  const table = assertSafeIdentifier(
    options.table ?? `${options.schema ?? 'entity_graph'}.__document_mentions`,
    'mentions table'
  );
  // Default `--all=false` filter matches the model-review surface: rows
  // that need attention (unresolved, low-confidence, compromise_ner /
  // schema_violation). Auto-merges (≥ 0.92) are excluded unless --all is
  // passed.
  const where = options.all
    ? 'superseded_at IS NULL'
    : [
        'superseded_at IS NULL',
        'AND (',
        '  resolved_entity_id IS NULL',
        '  OR COALESCE(resolution_confidence, confidence, 0) < 0.92',
        "  OR resolution_method IN ('compromise_ner', 'schema_violation', 'unresolved')",
        ')',
      ].join('\n');
  const limitClause = options.limit == null ? '' : `\nLIMIT ${Math.trunc(options.limit)}`;
  // Confidence bands aligned with agent-first review semantics:
  //   >= 0.92 -> auto_merge    (no review needed; surfaces in --all only)
  //   >= 0.75 -> agent_applied (linked with audit metadata)
  //   >= 0.55 -> agent_review  (agent/eval queue)
  //   < 0.55  -> unresolved
  return [
    'SELECT',
    '  mention_id AS review_id,',
    '  CASE',
    "    WHEN resolved_entity_id IS NULL THEN 'unresolved'",
    "    WHEN COALESCE(resolution_confidence, confidence, 0) >= 0.92 THEN 'auto_merge'",
    "    WHEN COALESCE(resolution_confidence, confidence, 0) >= 0.75 THEN 'agent_applied'",
    "    WHEN COALESCE(resolution_confidence, confidence, 0) >= 0.55 THEN 'agent_review'",
    "    ELSE 'unresolved'",
    '  END AS decision,',
    '  COALESCE(resolution_confidence, confidence, 0) AS confidence,',
    '  mention_id,',
    '  chunk_id,',
    '  document_id,',
    '  entity_type,',
    '  entity_name,',
    '  resolved_entity_id,',
    '  resolution_method,',
    '  notes',
    `FROM ${table}`,
    `WHERE ${where}`,
    'ORDER BY confidence ASC, mention_id ASC' + limitClause,
  ].join('\n');
}

async function fetchWithRunner(
  options: MentionsReviewExportOptions
): Promise<MentionsReviewExportRow[]> {
  if (!options.runner) {
    throw new CommandError(
      'mentions review export requires a runner. Pass --runner <path> or provide a programmatic fetcher.',
      2
    );
  }
  const runner = await loadRunnerModule(options.runner);
  if (runner.query == null) {
    throw new CommandError(
      'mentions review export requires a runner module that exports query(sql).',
      2
    );
  }
  // try/finally ensures the loaded runner adapter (PG/SF/BQ pool, DuckDB
  // connection, etc.) is closed even if the query or row normalization
  // throws — otherwise the CLI process can keep the connection open for
  // its full lifetime.
  try {
    const sql = buildMentionsReviewExportQuery(options);
    const rows = await runner.query(sql);
    return rows.map((row) => normalizeRunnerRow(row));
  } finally {
    await runner.close?.();
  }
}

export function rowsToCsv(rows: MentionsReviewExportRow[]): string {
  const header = [...STANDARD_HEADERS, ...MENTION_HEADERS].join(',');
  const body = rows
    .map((r) =>
      [
        escapeCsv(r.review_id),
        escapeCsv(r.decision),
        escapeCsv(r.confidence),
        escapeCsv(r.mention_id),
        escapeCsv(r.chunk_id),
        escapeCsv(r.document_id),
        escapeCsv(r.entity_type),
        escapeCsv(r.entity_name),
        escapeCsv(r.resolved_entity_id),
        escapeCsv(r.resolution_method),
        escapeCsv(r.notes),
      ].join(',')
    )
    .join('\n');
  return body.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
}

export async function runMentionsReviewExport(
  format: 'csv' | 'json' | 'yaml',
  options: MentionsReviewExportOptions = {}
): Promise<MentionsReviewExportRow[]> {
  const writer = resolveCommandWriter(options);
  const rows = options.fetcher ? await options.fetcher() : await fetchWithRunner(options);
  if (options.quiet) return rows;
  if (format === 'csv') {
    writer.out(rowsToCsv(rows));
  } else if (format === 'json') {
    writer.out(JSON.stringify({ count: rows.length, rows }, null, 2) + '\n');
  } else {
    // YAML must be content-equivalent to JSON per AGENTS.md: same top-level shape, every row preserves all fields.
    writer.out(toYaml({ count: rows.length, rows }) + '\n');
  }
  return rows;
}

export function registerMentionsReviewExportCommand(
  parent: Command,
  options: MentionsReviewExportOptions = {}
): void {
  parent
    .command('export')
    .description('Export __document_mentions review queue rows in the model-review envelope')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--table <name>', 'Fully qualified mentions table', options.table)
    .option('--schema <name>', 'Schema containing __document_mentions', options.schema)
    .option('--all', 'Include all non-superseded mentions', false)
    .option('--limit <n>', 'Maximum number of rows to return', parsePositiveIntOption)
    .option('--csv', 'CSV output (default; envelope-parity with `model review export`)', false)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--yaml', 'Machine-readable YAML output', false)
    .option('--verbose', 'Verbose logging', false)
    .option('--quiet', 'Suppress non-error output', false)
    .action(
      async (opts: {
        runner?: string;
        table?: string;
        schema?: string;
        all?: boolean;
        limit?: number;
        csv: boolean;
        json: boolean;
        yaml: boolean;
        verbose: boolean;
        quiet: boolean;
      }) => {
        // Explicit flags always win. Beyond that, defer to
        // `resolveOutputFormat` so this command obeys the same priority
        // cascade as every other entity-graph CLI (BOBSLED_CORE_OUTPUT_FORMAT > CI >
        // non-TTY > human). The only twist: this command's human-mode
        // default is CSV (model-review envelope-parity), not text — so
        // we map `human` → `csv` after the shared helper resolves.
        const resolved = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
        const format: 'csv' | 'json' | 'yaml' = opts.csv
          ? 'csv'
          : resolved === 'human'
            ? 'csv'
            : resolved;
        const quiet = opts.quiet || options.quiet === true;
        const commandOptions = {
          ...options,
          verbose: opts.verbose || options.verbose === true,
          quiet,
        };
        const writer = resolveCommandWriter(commandOptions);
        try {
          await runMentionsReviewExport(format, {
            ...commandOptions,
            runner: opts.runner ?? options.runner,
            table: opts.table ?? options.table,
            schema: opts.schema ?? options.schema,
            all: opts.all ?? options.all,
            limit: opts.limit ?? options.limit,
          });
        } catch (err) {
          // CSV mode has no envelope for errors — fall back to plain text.
          const errFormat = format === 'csv' ? 'human' : format;
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, errFormat, writer);
            return;
          }
          process.exitCode = 1;
          emitError(err instanceof Error ? err.message : String(err), errFormat, writer);
        }
      }
    );
}
