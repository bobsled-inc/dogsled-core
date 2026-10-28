import type { CustomRunnerRegistry } from '@bobsled-inc/connections';
import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { CommandError } from '@bobsled-inc/protocol';

import { requireQueryRunner } from '../commands/agent-support.js';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';

/**
 * Precedent read over the entity-resolution decision history.
 *
 * Reads `<schema>.<entity>__review_decisions` — the per-pair adjudication rows
 * written by `applyReviewDecisions` — so an agent can reason from how a pair (or
 * the entity's recent borderline pairs) was decided before, instead of
 * re-deriving the call. v1 is KEYED precedent (exact `pair_id`, or the entity's
 * most-recent decisions); embedding-similarity is a follow-up.
 *
 * This is a READ-ONLY path: it returns warehouse rows and persists nothing.
 */

const SIMILAR_DECISION_COLUMNS = [
  'pair_id',
  'decision',
  'confidence',
  'reason',
  'decision_source',
  'decided_at',
] as const;

const DEFAULT_LIMIT = 10;

export interface FindSimilarDecisionsOptions extends EntityGraphProjectOptions {
  /** Resolution spec / entity whose `__review_decisions` table is queried. */
  entity: string;
  /** When set, return prior decisions for this exact pair (its history). */
  pairId?: string;
  /** Max rows to return (most recent first). Defaults to 10. */
  limit?: number;
  /** Direct path to a SQL runner module. Wins over `customRunners`. */
  runner?: string;
  /** Secrets file path forwarded to the integration secret resolver. */
  secrets?: string;
  /**
   * In-memory runner registry keyed by `(source_type, auth_type)` — mirrors
   * `applyReviewDecisions({ customRunners })` so hosts can drive reads against
   * BigQuery WIF / Snowflake OIDC with pre-minted encrypted tokens.
   */
  customRunners?: CustomRunnerRegistry;
}

export interface SimilarDecision {
  pair_id: string;
  decision: string;
  confidence: number | null;
  reason: string | null;
  decision_source: string | null;
  decided_at: string | null;
}

export interface FindSimilarDecisionsResult {
  entity: string;
  name: string;
  dialect: SupportedDialect;
  schema: string;
  decisions: SimilarDecision[];
}

/**
 * Build the dialect-aware SELECT against `<schema>.<entity>__review_decisions`.
 * Exported so app-side read paths (which execute via their own warehouse query
 * layer) reuse the same table/column knowledge instead of duplicating it.
 */
export function buildSimilarDecisionsQuery(
  entity: string,
  schema: string,
  dialect: SupportedDialect,
  options: { pairId?: string; limit?: number } = {}
): string {
  const table = buildFqName(schema, `${entity}__review_decisions`, dialect);
  const columns = SIMILAR_DECISION_COLUMNS.map((column) => quoteIdentifier(column, dialect)).join(
    ', '
  );
  const limit =
    Number.isInteger(options.limit) && (options.limit as number) > 0
      ? (options.limit as number)
      : DEFAULT_LIMIT;
  const lines = [`SELECT ${columns}`, `FROM ${table}`];
  if (options.pairId != null) {
    lines.push(
      `WHERE ${quoteIdentifier('pair_id', dialect)} = ${quoteLiteral(options.pairId, dialect)}`
    );
  }
  lines.push(`ORDER BY ${quoteIdentifier('decided_at', dialect)} DESC`);
  lines.push(`LIMIT ${limit}`);
  return lines.join('\n');
}

function toSimilarDecision(row: unknown): SimilarDecision {
  // Warehouse runners return heterogeneous cell types (e.g. BigQuery timestamp
  // objects, string-encoded numerics) — coerce defensively rather than failing
  // a strict schema parse on a read-only precedent lookup. Guard the row itself
  // too: a non-conforming custom runner could yield null/primitive elements.
  const source = row != null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const confidenceRaw = source.confidence;
  const confidence = confidenceRaw == null || confidenceRaw === '' ? null : Number(confidenceRaw);
  return {
    pair_id: String(source.pair_id ?? ''),
    decision: String(source.decision ?? ''),
    confidence: confidence != null && Number.isFinite(confidence) ? confidence : null,
    reason: source.reason == null ? null : String(source.reason),
    decision_source: source.decision_source == null ? null : String(source.decision_source),
    decided_at: source.decided_at == null ? null : String(source.decided_at),
  };
}

/**
 * Programmatic precedent lookup. Resolves the entity-graph project + warehouse
 * runner exactly like `applyReviewDecisions`, runs the keyed SELECT, and returns
 * typed rows. Used by the CLI and tests; app/agent reads typically run
 * `buildSimilarDecisionsQuery` through their own warehouse query layer.
 */
export async function findSimilarDecisions(
  options: FindSimilarDecisionsOptions
): Promise<FindSimilarDecisionsResult> {
  const context = await loadEntityGraphProjectContext({
    ...options,
    entityNames: [options.entity],
  });
  const spec = context.specs[0];
  if (!spec) {
    return {
      entity: options.entity,
      name: options.entity,
      dialect: context.dialect,
      schema: context.targetSchema,
      decisions: [],
    };
  }

  const effectiveSchema = spec.targetSchema ?? context.targetSchema;
  const sql = buildSimilarDecisionsQuery(spec.entity, effectiveSchema, context.dialect, {
    ...(options.pairId != null ? { pairId: options.pairId } : {}),
    ...(options.limit != null ? { limit: options.limit } : {}),
  });

  const runnerHandle = await resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    secrets: options.secrets,
    allowLocalRunnerFallback: false,
    ...(options.customRunners ? { customRunners: options.customRunners } : {}),
  });

  if (!runnerHandle) {
    // No runner path, no integration, local fallback disabled — a precedent read
    // has nowhere to run. Surface the misconfiguration instead of silently
    // returning "no precedent" (mirrors applyReviewDecisions).
    throw new CommandError(
      'findSimilarDecisions: no SQL runner resolved. Provide a runner or an integration.',
      1,
      {
        valid: false,
        errorCode: 'NO_RUNNER_RESOLVED',
        errors: [{ path: 'runner', message: 'No executable runner available.' }],
      }
    );
  }

  try {
    const query = requireQueryRunner(runnerHandle.runner, 'findSimilarDecisions');
    const rawRows = await query(sql);
    const decisions = (Array.isArray(rawRows) ? rawRows : []).map((row) => toSimilarDecision(row));
    return {
      entity: spec.entity,
      name: spec.name,
      dialect: context.dialect,
      schema: effectiveSchema,
      decisions,
    };
  } finally {
    await runnerHandle.close();
  }
}
