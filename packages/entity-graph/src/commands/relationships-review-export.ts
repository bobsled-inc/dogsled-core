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
  RELATIONSHIP_AGENT_REVIEW_THRESHOLD,
  type RelationshipReviewFlag,
} from '../runtime/relationship/evidence-writer.js';
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

const REVIEW_FLAGS: readonly RelationshipReviewFlag[] = [
  'auto_merge',
  'agent_applied',
  'agent_review',
  'eval_sample',
  'human_review',
  'unresolved',
];

const DEFAULT_REVIEW_THRESHOLDS: RelationshipsReviewThresholds = {
  auto_confirm: 0.92,
  agent_review: RELATIONSHIP_AGENT_REVIEW_THRESHOLD,
  review: 0.55,
};

export interface RelationshipsReviewExportRow {
  review_id: string;
  decision: RelationshipReviewFlag;
  confidence: number;
  evidence_id: string;
  relationship_id: string;
  relation_type: string;
  left_entity_id: string;
  right_entity_id: string;
  evidence_excerpt: string | null;
  source_document_id: string | null;
  review_flag: string | null;
}

export interface RelationshipsReviewExportOptions {
  writer?: Writer;
  fetcher?: () => Promise<RelationshipsReviewExportRow[]>;
  runner?: string;
  table?: string;
  schema?: string;
  all?: boolean;
  limit?: number;
  reviewThresholds?: Partial<RelationshipsReviewThresholds>;
  verbose?: boolean;
  quiet?: boolean;
}

export interface RelationshipsReviewThresholds {
  auto_confirm: number;
  agent_review: number;
  review: number;
}

function coerceDecision(value: unknown): RelationshipReviewFlag {
  return coerceOneOf(value, REVIEW_FLAGS, 'decision');
}

interface RelationshipsReviewExportSourceRow extends ReviewExportRow {
  review_id?: unknown;
  decision?: unknown;
  confidence?: unknown;
  evidence_id?: unknown;
  relationship_id?: unknown;
  relation_type?: unknown;
  left_entity_id?: unknown;
  right_entity_id?: unknown;
  evidence_excerpt?: unknown;
  source_document_id?: unknown;
  review_flag?: unknown;
}

function normalizeRunnerRow(row: RelationshipsReviewExportSourceRow): RelationshipsReviewExportRow {
  const evidenceId = coerceString(readField(row, 'evidence_id'), 'evidence_id');
  return {
    review_id: coerceString(readField(row, 'review_id') ?? evidenceId, 'review_id'),
    decision: coerceDecision(readField(row, 'decision')),
    confidence: coerceNumber(readField(row, 'confidence'), 'confidence'),
    evidence_id: evidenceId,
    relationship_id: coerceString(readField(row, 'relationship_id'), 'relationship_id'),
    relation_type: coerceString(readField(row, 'relation_type'), 'relation_type'),
    left_entity_id: coerceString(readField(row, 'left_entity_id'), 'left_entity_id'),
    right_entity_id: coerceString(readField(row, 'right_entity_id'), 'right_entity_id'),
    evidence_excerpt: coerceNullableString(readField(row, 'evidence_excerpt')),
    source_document_id: coerceNullableString(readField(row, 'source_document_id')),
    review_flag: coerceNullableString(readField(row, 'review_flag')),
  };
}

export function buildRelationshipsReviewExportQuery(options: {
  table?: string;
  schema?: string;
  all?: boolean;
  limit?: number;
  reviewThresholds?: Partial<RelationshipsReviewThresholds>;
}): string {
  const table = assertSafeIdentifier(
    options.table ?? `${options.schema ?? 'entity_graph'}.__entity_relationship_evidence`,
    'relationship evidence table'
  );
  const thresholds = {
    ...DEFAULT_REVIEW_THRESHOLDS,
    ...(options.reviewThresholds ?? {}),
  };
  const autoConfirm = sqlThreshold(thresholds.auto_confirm, 'auto_confirm');
  const agentReview = sqlThreshold(thresholds.agent_review, 'agent_review');
  const review = sqlThreshold(thresholds.review, 'review');
  const where = options.all ? '1 = 1' : "decision IN ('agent_review', 'eval_sample', 'unresolved')";
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new CommandError(
      'Invalid relationship review export limit; expected a positive integer.',
      2
    );
  }
  const limitClause = options.limit == null ? '' : `\nLIMIT ${options.limit}`;
  // `review_flag` is persisted by the runtime after applying each ontology
  // relation's thresholds. Numeric thresholds are only the fallback for older
  // rows or manually loaded evidence that has no stored review flag.
  return [
    'WITH classified AS (',
    'SELECT',
    '  evidence_id AS review_id,',
    '  CASE',
    "    WHEN review_flag IN ('auto_merge', 'agent_applied', 'agent_review', 'eval_sample', 'unresolved') THEN review_flag",
    "    WHEN review_flag = 'human_review' THEN 'agent_review'",
    `    WHEN confidence >= ${autoConfirm} THEN 'auto_merge'`,
    `    WHEN confidence >= ${agentReview} THEN 'agent_applied'`,
    `    WHEN confidence >= ${review} THEN 'agent_review'`,
    "    ELSE 'unresolved'",
    '  END AS decision,',
    '  confidence,',
    '  evidence_id,',
    '  relationship_id,',
    '  relation_type,',
    '  left_entity_id,',
    '  right_entity_id,',
    '  evidence_excerpt,',
    '  source_document_id,',
    '  review_flag',
    `FROM ${table}`,
    ')',
    'SELECT *',
    'FROM classified',
    `WHERE ${where}`,
    'ORDER BY confidence ASC, evidence_id ASC' + limitClause,
  ].join('\n');
}

function sqlThreshold(value: number, label: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CommandError(`Invalid relationship review threshold ${label}: ${String(value)}.`, 2);
  }
  return String(value);
}

async function fetchWithRunner(
  options: RelationshipsReviewExportOptions
): Promise<RelationshipsReviewExportRow[]> {
  if (!options.runner) {
    throw new CommandError(
      'relationships review export requires a runner. Pass --runner <path> or provide a fetcher.',
      2
    );
  }
  const runner = await loadRunnerModule(options.runner);
  if (!runner.query) {
    throw new CommandError(
      'relationships review export requires a runner module that exports query(sql).',
      2
    );
  }
  try {
    const rows = (await runner.query(
      buildRelationshipsReviewExportQuery(options)
    )) as RelationshipsReviewExportSourceRow[];
    return rows.map((row) => normalizeRunnerRow(row));
  } finally {
    await runner.close?.();
  }
}

export function relationshipRowsToCsv(rows: readonly RelationshipsReviewExportRow[]): string {
  const header = [
    'review_id',
    'decision',
    'confidence',
    'evidence_id',
    'relationship_id',
    'relation_type',
    'left_entity_id',
    'right_entity_id',
    'evidence_excerpt',
    'source_document_id',
    'review_flag',
  ];
  const body = rows
    .map((row) =>
      header.map((field) => escapeCsv(row[field as keyof RelationshipsReviewExportRow])).join(',')
    )
    .join('\n');
  return body.length === 0 ? `${header.join(',')}\n` : `${header.join(',')}\n${body}\n`;
}

export async function runRelationshipsReviewExport(
  format: 'csv' | 'json' | 'yaml',
  options: RelationshipsReviewExportOptions = {}
): Promise<RelationshipsReviewExportRow[]> {
  const writer = resolveCommandWriter(options);
  const rows = options.fetcher ? await options.fetcher() : await fetchWithRunner(options);
  if (options.quiet) return rows;
  if (format === 'csv') {
    writer.out(relationshipRowsToCsv(rows));
  } else if (format === 'json') {
    writer.out(JSON.stringify({ count: rows.length, rows }, null, 2) + '\n');
  } else {
    writer.out(toYaml({ count: rows.length, rows }) + '\n');
  }
  return rows;
}

export function registerRelationshipsReviewExportCommand(
  parent: Command,
  options: RelationshipsReviewExportOptions = {}
): void {
  parent
    .command('export')
    .description('Export __entity_relationship_evidence review queue rows')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--table <name>', 'Fully qualified relationship evidence table', options.table)
    .option('--schema <name>', 'Schema containing __entity_relationship_evidence', options.schema)
    .option('--all', 'Include all relationship evidence rows', false)
    .option('--limit <n>', 'Maximum number of rows to return', parsePositiveIntOption)
    .option('--csv', 'CSV output (default)', false)
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
        const resolved = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
        const format: 'csv' | 'json' | 'yaml' = opts.csv
          ? 'csv'
          : resolved === 'human'
            ? 'csv'
            : resolved;
        const quiet = opts.quiet || options.quiet === true;
        try {
          await runRelationshipsReviewExport(format, {
            ...options,
            runner: opts.runner ?? options.runner,
            table: opts.table ?? options.table,
            schema: opts.schema ?? options.schema,
            all: opts.all ?? options.all,
            limit: opts.limit ?? options.limit,
            verbose: opts.verbose ?? options.verbose,
            quiet,
          });
        } catch (err) {
          const errFormat = format === 'csv' ? 'human' : format;
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, errFormat, resolveCommandWriter(options));
            return;
          }
          process.exitCode = 1;
          emitError(
            err instanceof Error ? err.message : String(err),
            errFormat,
            resolveCommandWriter(options)
          );
        }
      }
    );
}
