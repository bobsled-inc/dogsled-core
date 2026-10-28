/**
 * Agent review pair fetch — read unreviewed `__review_queue` rows into the
 * `PairContext[]` shape `runAgentReview` consumes.
 *
 * The queue's `field_diffs` column carries per-field *scores* only (the
 * `field_scores` JSON emitted by scoring codegen); the record *values* live in
 * `<entity>__standardized`. This helper joins the two client-side: queue rows
 * provide ids/scores, a second batched lookup against `__standardized`
 * provides the a/b values the judge reads. Value enrichment is fail-soft —
 * when `__standardized` cannot be read, pairs keep their scores and empty
 * values, with a warning.
 */

import { z } from 'zod';

import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import type { SqlQueryRunner, SupportedDialect } from '@bobsled-inc/model-spec';
import { AGENT_THRESHOLD_BANDS, type AgentThresholdBand } from '../agent/schema.js';
import { generateUnreviewedPairsQuery } from './agent-review.js';
import { outputTableName } from '../output-tables/index.js';
import type { PairContext, ResolvedResolutionSpec } from './types.js';

/** Max record ids per `__standardized` value-lookup query. */
const VALUE_LOOKUP_CHUNK_SIZE = 500;

/**
 * Zod shape of one `__review_queue` row — the single source of truth for
 * queue readers. `commands/agent-support.ts` extends this with the decision
 * columns its export query joins in, so the two readers cannot drift.
 */
export const ReviewQueueRowSchema = z.object({
  pair_id: z.string(),
  record_a_id: z.string(),
  record_b_id: z.string(),
  source_a: z.string(),
  source_b: z.string(),
  composite_score: z.coerce.number(),
  threshold_band: z.enum(AGENT_THRESHOLD_BANDS),
  blocking_rules: z.string(),
  field_diffs: z.string(),
  recommended_action: z.enum(['merge', 'not_match']),
});

const ReviewQueueRowsSchema = z.array(ReviewQueueRowSchema);

export type ReviewQueueRow = z.infer<typeof ReviewQueueRowSchema>;

export interface FetchUnreviewedPairContextsOptions {
  /** Cap the number of fetched pairs (e.g. `agent_policy.max_pairs_per_run`). */
  limit?: number;
  /** Bands to include; defaults to every agent-reviewable band. */
  thresholdBands?: readonly AgentThresholdBand[];
  /**
   * Skip the `__standardized` value lookup (scores only). Defaults to true —
   * a judge without record values cannot adjudicate meaningfully.
   */
  includeFieldValues?: boolean;
}

export interface FetchUnreviewedPairContextsResult {
  pairs: PairContext[];
  warnings: string[];
}

/** Case-insensitive column read — warehouses vary identifier case. */
function readColumn(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  const entry = Object.entries(row).find(([key]) => key.toLowerCase() === lower);
  return entry?.[1];
}

function parseFieldDiffs(raw: string): Record<string, number> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const score = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(score)) {
      scores[key] = score;
    }
  }
  return scores;
}

/**
 * Look a field's score up in the parsed `field_diffs`, tolerating the
 * `standardized_` prefix in either direction (`context_fields` authors write
 * `name`; scoring features usually reference `standardized_name`).
 */
function lookupScore(scores: Record<string, number>, field: string): number | undefined {
  if (field in scores) return scores[field];
  const lower = field.toLowerCase();
  for (const [key, value] of Object.entries(scores)) {
    const keyLower = key.toLowerCase();
    if (
      keyLower === lower ||
      keyLower === `standardized_${lower}` ||
      `standardized_${keyLower}` === lower
    ) {
      return value;
    }
  }
  return undefined;
}

/** Read a field's value off a `__standardized` row, preferring the raw column. */
function lookupValue(row: Record<string, unknown> | undefined, field: string): string {
  if (!row) return '';
  const direct = readColumn(row, field);
  if (direct != null) return String(direct);
  const lower = field.toLowerCase();
  const fallbackName = lower.startsWith('standardized_')
    ? lower.slice('standardized_'.length)
    : `standardized_${lower}`;
  const fallback = readColumn(row, fallbackName);
  return fallback == null ? '' : String(fallback);
}

/**
 * Map validated queue rows (+ optional `__standardized` values) to
 * `PairContext[]`. When `contextFields` is set (from
 * `agent_policy.context_fields`), `fields` is filtered to exactly that list;
 * otherwise the `field_diffs` keys drive it.
 */
export function mapReviewQueueRowsToPairContexts(
  rows: ReviewQueueRow[],
  options: {
    contextFields?: readonly string[];
    valuesByRecordId?: ReadonlyMap<string, Record<string, unknown>>;
    onWarning?: (message: string) => void;
  } = {}
): PairContext[] {
  const { contextFields, valuesByRecordId, onWarning } = options;

  return rows.map((row) => {
    const scores = parseFieldDiffs(row.field_diffs);
    if (scores === undefined) {
      onWarning?.(`Pair ${row.pair_id}: field_diffs is not a JSON object; continuing without it.`);
    }
    const fieldNames =
      contextFields && contextFields.length > 0 ? [...contextFields] : Object.keys(scores ?? {});
    const rowA = valuesByRecordId?.get(row.record_a_id);
    const rowB = valuesByRecordId?.get(row.record_b_id);

    const fields: PairContext['fields'] = {};
    for (const field of fieldNames) {
      const score = scores ? lookupScore(scores, field) : undefined;
      fields[field] = {
        a: lookupValue(rowA, field),
        b: lookupValue(rowB, field),
        ...(score !== undefined ? { score } : {}),
      };
    }

    return {
      pairId: row.pair_id,
      recordAId: row.record_a_id,
      recordBId: row.record_b_id,
      sourceA: row.source_a,
      sourceB: row.source_b,
      compositeScore: row.composite_score,
      fields,
    };
  });
}

async function fetchStandardizedValues(
  query: SqlQueryRunner,
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string,
  recordIds: readonly string[]
): Promise<Map<string, Record<string, unknown>>> {
  const table = buildFqName(targetSchema, outputTableName(entity, '__standardized'), dialect);
  const recordIdCol = quoteIdentifier('record_id', dialect);
  const valuesByRecordId = new Map<string, Record<string, unknown>>();

  for (let index = 0; index < recordIds.length; index += VALUE_LOOKUP_CHUNK_SIZE) {
    const chunk = recordIds.slice(index, index + VALUE_LOOKUP_CHUNK_SIZE);
    const idList = chunk.map((id) => quoteLiteral(id, dialect)).join(', ');
    const rows = await query(
      [`SELECT *`, `FROM ${table}`, `WHERE ${recordIdCol} IN (${idList})`].join('\n')
    );
    for (const row of rows) {
      const recordId = readColumn(row, 'record_id');
      if (recordId != null) {
        valuesByRecordId.set(String(recordId), row);
      }
    }
  }
  return valuesByRecordId;
}

/**
 * Fetch this entity's unreviewed review-queue pairs as `PairContext[]`.
 *
 * Runs {@link generateUnreviewedPairsQuery} (skips pairs that already have any
 * `__review_decisions` row), zod-validates the rows, parses the `field_diffs`
 * scores, enriches a/b values from `__standardized`, and honors
 * `agent_policy.context_fields`. Row-shape violations throw `CommandError(1)`
 * (a broken warehouse contract, mirroring `fetchReviewRows`); the value
 * enrichment is fail-soft and only warns.
 */
export async function fetchUnreviewedPairContexts(
  query: SqlQueryRunner,
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  options: FetchUnreviewedPairContextsOptions = {}
): Promise<FetchUnreviewedPairContextsResult> {
  const warnings: string[] = [];
  const rawRows = await query(
    generateUnreviewedPairsQuery(spec.entity, dialect, targetSchema, {
      ...(options.thresholdBands ? { thresholdBands: options.thresholdBands } : {}),
      ...(options.limit != null ? { limit: options.limit } : {}),
    })
  );
  const parsedRows = ReviewQueueRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    const issue = parsedRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid review queue rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }
  const rows = parsedRows.data;
  if (rows.length === 0) {
    return { pairs: [], warnings };
  }

  let valuesByRecordId: Map<string, Record<string, unknown>> | undefined;
  if (options.includeFieldValues !== false) {
    const recordIds = [...new Set(rows.flatMap((row) => [row.record_a_id, row.record_b_id]))];
    try {
      valuesByRecordId = await fetchStandardizedValues(
        query,
        spec.entity,
        dialect,
        targetSchema,
        recordIds
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `${spec.entity}: could not read __standardized for pair field values (${message}); continuing with scores only.`
      );
    }
  }

  const pairs = mapReviewQueueRowsToPairContexts(rows, {
    ...(spec.agentPolicy?.contextFields ? { contextFields: spec.agentPolicy.contextFields } : {}),
    ...(valuesByRecordId ? { valuesByRecordId } : {}),
    onWarning: (message) => warnings.push(message),
  });

  return { pairs, warnings };
}
