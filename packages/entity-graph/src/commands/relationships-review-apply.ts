import * as fs from 'node:fs';

import { Command } from 'commander';
import YAML from 'yaml';
import {
  CommandError,
  emitError,
  emitPayload,
  resolveOutputFormat,
  type Writer,
} from '@bobsled-inc/protocol';
import { loadRunnerModule } from '@bobsled-inc/model-spec/shared';

import type { RelationshipDecision } from '../compiler/relationship/aggregation.js';
import { assertSafeIdentifier } from '../runtime/candidate-retrieval/sql-utils.js';
import { resolveCommandWriter } from './utils.js';

export interface RelationshipReviewDecisionRow {
  evidence_id?: string | null;
  relationship_id: string;
  decision: RelationshipDecision;
  decided_by?: string;
  rationale?: string | null;
}

interface RelationshipReviewDecisionInputRow {
  evidence_id?: unknown;
  relationship_id?: unknown;
  decision?: unknown;
  decided_by?: unknown;
  rationale?: unknown;
}

export interface RelationshipsReviewApplyOptions {
  writer?: Writer;
  runner?: string;
  table?: string;
  schema?: string;
  now?: () => Date;
  decisionId?: (row: RelationshipReviewDecisionRow, index: number) => string;
}

export interface ParameterizedSqlStatement {
  sql: string;
  params: readonly unknown[];
}

interface ParameterizedSqlRunner {
  query?: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  close?: () => Promise<void>;
}

function coerceDecision(value: unknown): RelationshipDecision {
  if (
    value === 'confirm' ||
    value === 'reject' ||
    value === 'supersede' ||
    value === 'conflicted'
  ) {
    return value;
  }
  throw new CommandError(`Invalid relationship review decision: ${String(value)}.`, 2);
}

function normalizeRow(value: unknown): RelationshipReviewDecisionRow {
  if (!value || typeof value !== 'object') {
    throw new CommandError('Relationship review apply rows must be objects.', 2);
  }
  const row = value as RelationshipReviewDecisionInputRow;
  const relationshipId = row.relationship_id;
  if (typeof relationshipId !== 'string' || relationshipId.length === 0) {
    throw new CommandError('Relationship review apply row is missing relationship_id.', 2);
  }
  const evidenceId = row.evidence_id;
  if (evidenceId !== undefined && evidenceId !== null && typeof evidenceId !== 'string') {
    throw new CommandError('Relationship review apply row has non-string evidence_id.', 2);
  }
  return {
    evidence_id: typeof evidenceId === 'string' && evidenceId.length > 0 ? evidenceId : null,
    relationship_id: relationshipId,
    decision: coerceDecision(row.decision),
    decided_by:
      typeof row.decided_by === 'string' && row.decided_by.length > 0
        ? row.decided_by
        : 'human:unknown',
    rationale: typeof row.rationale === 'string' ? row.rationale : null,
  };
}

export function parseRelationshipReviewDecisionFile(
  content: string
): RelationshipReviewDecisionRow[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Unable to parse relationship review decision file: ${message}`, 2);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows) {
    throw new CommandError(
      'Relationship review apply file must be an array or { rows: [...] }.',
      2
    );
  }
  return rows.map((row) => normalizeRow(row));
}

export function buildRelationshipsReviewApplySql(
  rows: readonly RelationshipReviewDecisionRow[],
  options: RelationshipsReviewApplyOptions = {}
): ParameterizedSqlStatement[] {
  const table = assertSafeIdentifier(
    options.table ?? `${options.schema ?? 'entity_graph'}.__entity_relationship_decisions`,
    'relationship decisions table'
  );
  const now = (options.now ? options.now() : new Date()).toISOString();
  return rows.map((row, index) => {
    const decisionId =
      options.decisionId?.(row, index) ??
      `${row.relationship_id}:${row.evidence_id ?? 'blanket'}:${row.decision}:${index}`;
    return {
      sql: [
        `INSERT INTO ${table} (`,
        '  decision_id, evidence_id, relationship_id, decision, decided_by, rationale, decided_at',
        ') VALUES (?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
      params: [
        decisionId,
        row.evidence_id ?? null,
        row.relationship_id,
        row.decision,
        row.decided_by ?? 'human:unknown',
        row.rationale ?? null,
        now,
      ],
    };
  });
}

export async function runRelationshipsReviewApply(
  inputFile: string,
  options: RelationshipsReviewApplyOptions = {}
): Promise<{ ok: true; applied: number }> {
  let content: string;
  try {
    content = fs.readFileSync(inputFile, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Unable to read relationship review file '${inputFile}': ${message}`, 1);
  }
  let rows: RelationshipReviewDecisionRow[];
  try {
    rows = parseRelationshipReviewDecisionFile(content);
  } catch (err) {
    if (err instanceof CommandError) {
      if (err.message.startsWith('Unable to parse relationship review decision file:')) {
        throw new CommandError(
          `Unable to parse relationship review file '${inputFile}': ${err.message.replace(
            'Unable to parse relationship review decision file: ',
            ''
          )}`,
          2
        );
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Unable to parse relationship review file '${inputFile}': ${message}`,
      2
    );
  }
  const statements = buildRelationshipsReviewApplySql(rows, options);
  if (!options.runner) {
    throw new CommandError('relationships review apply requires --runner <path>.', 2);
  }
  const runner = (await loadRunnerModule(options.runner)) as ParameterizedSqlRunner;
  if (!runner.query) {
    await runner.close?.();
    throw new CommandError(
      'relationships review apply requires a runner module that exports query(sql, params).',
      2
    );
  }
  try {
    for (const { sql, params } of statements) {
      await runner.query(sql, params);
    }
  } finally {
    await runner.close?.();
  }
  return { ok: true as const, applied: rows.length };
}

export function registerRelationshipsReviewApplyCommand(
  parent: Command,
  options: RelationshipsReviewApplyOptions = {}
): void {
  parent
    .command('apply')
    .description('Apply relationship review decisions into __entity_relationship_decisions')
    .argument('<file>', 'YAML/JSON decision file containing rows')
    .option('--runner <path>', 'Path to SQL runner module with query(sql, params)')
    .option('--table <name>', 'Fully qualified relationship decisions table', options.table)
    .option('--schema <name>', 'Schema containing __entity_relationship_decisions', options.schema)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--yaml', 'Machine-readable YAML output', false)
    .action(
      async (
        file: string,
        opts: { runner?: string; table?: string; schema?: string; json: boolean; yaml: boolean }
      ) => {
        const format = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
        try {
          const result = await runRelationshipsReviewApply(file, {
            ...options,
            runner: opts.runner ?? options.runner,
            table: opts.table ?? options.table,
            schema: opts.schema ?? options.schema,
          });
          emitPayload(result, format, resolveCommandWriter(options), () => {
            return `Applied ${result.applied} relationship decision(s).`;
          });
        } catch (err) {
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, format, resolveCommandWriter(options));
            return;
          }
          // Unexpected errors must not surface as raw stack traces on an
          // agent-consumable surface. Normalize to exit code 1 and emit the
          // message through the same envelope as CommandError.
          process.exitCode = 1;
          emitError(
            err instanceof Error ? err.message : String(err),
            format,
            resolveCommandWriter(options)
          );
        }
      }
    );
}
