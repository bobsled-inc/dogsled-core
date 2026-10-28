/**
 * Review apply — import review decisions from CSV, JSON, or YAML.
 *
 * Parses decision files and generates SQL to INSERT into
 * __review_decisions and __not_match_edges tables.
 */

import YAML from 'yaml';

import { quoteLiteral, buildFqName, quoteIdentifier } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import {
  bundleToReviewDecisions,
  isAgentDecisionBundleV1,
  type AgentDecisionBundleV1,
} from '../agent/types.js';
import type { ReviewDecisionRow, SqlStatement } from './types.js';
import { mapColumnType, typedNull } from './materializer.js';
import { outputTableName } from '../output-tables/index.js';

// ---------------------------------------------------------------------------
// CSV / JSON / YAML parsing
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = ['pair_id', 'decision'] as const;
const VALID_DECISIONS = new Set(['merge', 'not_match', 'defer']);
// 'escalated' is preserved for backward compat with rows written before the
// agent_confidence_floor split. New code does not emit it, but existing
// fixtures and on-disk data may still carry it.
const VALID_STATUSES = new Set(['proposed', 'applied', 'deferred', 'escalated', 'superseded']);

export type DecisionInputFormat = 'csv' | 'json' | 'yaml' | 'decision_bundle';

export interface ApplyResult {
  decisions: ReviewDecisionRow[];
  warnings: string[];
  /** Present when the input used the versioned decision-bundle envelope. */
  bundle?: AgentDecisionBundleV1;
}

function resolveDecisionStatus(
  decision: ReviewDecisionRow['decision'],
  explicitStatus?: ReviewDecisionRow['status']
): NonNullable<ReviewDecisionRow['status']> {
  if (explicitStatus) {
    return explicitStatus;
  }
  if (decision === 'defer') {
    return 'deferred';
  }
  return 'applied';
}

function parseOptionalNumber(
  raw: string | number | null | undefined,
  warnings: string[],
  label: string
): number | undefined {
  if (raw == null || String(raw).trim().length === 0) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${label}: invalid numeric value "${String(raw)}", ignoring`);
    return undefined;
  }
  return parsed;
}

function parseOptionalDecision(
  raw: unknown,
  warnings: string[],
  label: string
): ReviewDecisionRow['decision'] | undefined {
  if (raw == null || String(raw).trim().length === 0) {
    return undefined;
  }

  const parsed = String(raw).trim().toLowerCase();
  if (!VALID_DECISIONS.has(parsed)) {
    warnings.push(`${label}: invalid decision "${parsed}", ignoring`);
    return undefined;
  }

  return parsed as ReviewDecisionRow['decision'];
}

/**
 * Parse and validate a status field. Returns:
 *   - { ok: true, value: status }                  — valid, present, parsed
 *   - { ok: true, value: undefined }               — absent, fall back to default
 *   - { ok: false, error: warning_message }        — invalid; caller should
 *     push the warning and skip the row
 *
 * Silently dropping the status field is what produced the demo-blocking bug
 * where agent proposals (`status='proposed'`) jumped past the queue and
 * landed as `applied`. Reject invalid values explicitly instead of swallowing.
 */
function parseOptionalStatus(
  raw: unknown,
  label: string
):
  | { ok: true; value: NonNullable<ReviewDecisionRow['status']> | undefined }
  | { ok: false; error: string } {
  if (raw == null || String(raw).trim().length === 0) {
    return { ok: true, value: undefined };
  }

  const parsed = String(raw).trim().toLowerCase();
  if (!VALID_STATUSES.has(parsed)) {
    return {
      ok: false,
      error: `${label}: invalid status "${parsed}". Expected one of: proposed, applied, deferred, escalated, superseded.`,
    };
  }

  return { ok: true, value: parsed as NonNullable<ReviewDecisionRow['status']> };
}

function getCsvField(
  fields: string[],
  headerMap: Map<string, number>,
  column: string
): string | undefined {
  const index = headerMap.get(column);
  return index == null ? undefined : fields[index];
}

/** Parse a CSV string into review decisions. */
export function parseCsvDecisions(content: string): ApplyResult {
  const warnings: string[] = [];
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { decisions: [], warnings: ['Empty decision file'] };
  }

  const headers = parseCSVLine(lines[0]!);
  const headerMap = new Map(headers.map((h, i) => [h.trim().toLowerCase(), i]));

  // Validate required columns
  for (const col of REQUIRED_COLUMNS) {
    if (!headerMap.has(col)) {
      return { decisions: [], warnings: [`Missing required column: ${col}`] };
    }
  }

  const decisionMap = new Map<string, ReviewDecisionRow>();
  const seenPairIds = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]!);
    const pairId = fields[headerMap.get('pair_id')!]?.trim() ?? '';
    const decision = fields[headerMap.get('decision')!]?.trim()?.toLowerCase() ?? '';

    if (!pairId) {
      warnings.push(`Line ${i + 1}: empty pair_id, skipping`);
      continue;
    }

    if (!VALID_DECISIONS.has(decision)) {
      warnings.push(`Line ${i + 1}: invalid decision "${decision}" for pair ${pairId}, skipping`);
      continue;
    }

    const statusResult = parseOptionalStatus(
      getCsvField(fields, headerMap, 'status'),
      `Line ${i + 1}`
    );
    if (!statusResult.ok) {
      warnings.push(`${statusResult.error} skipping`);
      continue;
    }

    if (seenPairIds.has(pairId)) {
      warnings.push(`Duplicate pair_id ${pairId} in input. Using last occurrence.`);
    }
    seenPairIds.add(pairId);

    decisionMap.set(pairId, {
      pair_id: pairId,
      decision: decision as ReviewDecisionRow['decision'],
      status: statusResult.value,
      reviewer: getCsvField(fields, headerMap, 'reviewer')?.trim() || 'human',
      reason: getCsvField(fields, headerMap, 'reason')?.trim() || undefined,
      confidence: parseOptionalNumber(
        getCsvField(fields, headerMap, 'confidence'),
        warnings,
        `Line ${i + 1}`
      ),
      proposed_decision: parseOptionalDecision(
        getCsvField(fields, headerMap, 'proposed_decision'),
        warnings,
        `Line ${i + 1}`
      ),
      proposed_confidence: parseOptionalNumber(
        getCsvField(fields, headerMap, 'proposed_confidence'),
        warnings,
        `Line ${i + 1}`
      ),
      decided_at: getCsvField(fields, headerMap, 'decided_at')?.trim() || undefined,
      decision_batch_id: getCsvField(fields, headerMap, 'decision_batch_id')?.trim() || undefined,
      decision_source: getCsvField(fields, headerMap, 'decision_source')?.trim() || undefined,
      applied_at: getCsvField(fields, headerMap, 'applied_at')?.trim() || undefined,
    });
  }

  return { decisions: [...decisionMap.values()], warnings };
}

/** Parse a JSON string into review decisions. */
export function parseJsonDecisions(content: string): ApplyResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { decisions: [], warnings: ['Invalid JSON'] };
  }

  if (isAgentDecisionBundleV1(parsed)) {
    return {
      decisions: bundleToReviewDecisions(parsed),
      warnings,
      bundle: parsed,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      decisions: [],
      warnings: [
        'JSON must be an array of decision objects or entity_graph_decision_bundle.v1 object',
      ],
    };
  }

  const decisionMap = new Map<string, ReviewDecisionRow>();
  const seenPairIds = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (row == null || typeof row !== 'object' || Array.isArray(row)) {
      warnings.push(`Entry ${i + 1}: decision must be an object, skipping`);
      continue;
    }
    const pairId = String(row.pair_id ?? '').trim();
    const decision = String(row.decision ?? '')
      .trim()
      .toLowerCase();

    if (!pairId) {
      warnings.push(`Entry ${i}: empty pair_id, skipping`);
      continue;
    }

    if (!VALID_DECISIONS.has(decision)) {
      warnings.push(`Entry ${i}: invalid decision "${decision}" for pair ${pairId}, skipping`);
      continue;
    }

    const statusResult = parseOptionalStatus(row.status, `Entry ${i}`);
    if (!statusResult.ok) {
      warnings.push(`${statusResult.error} skipping`);
      continue;
    }

    if (seenPairIds.has(pairId)) {
      warnings.push(`Duplicate pair_id ${pairId} in input. Using last occurrence.`);
    }
    seenPairIds.add(pairId);

    decisionMap.set(pairId, {
      pair_id: pairId,
      decision: decision as ReviewDecisionRow['decision'],
      status: statusResult.value,
      reviewer: String(row.reviewer ?? 'human').trim(),
      reason: row.reason ? String(row.reason).trim() : undefined,
      confidence: parseOptionalNumber(
        row.confidence as string | number | undefined,
        warnings,
        `Entry ${i}`
      ),
      proposed_decision: parseOptionalDecision(row.proposed_decision, warnings, `Entry ${i}`),
      proposed_confidence: parseOptionalNumber(
        row.proposed_confidence as string | number | undefined,
        warnings,
        `Entry ${i}`
      ),
      decided_at: row.decided_at ? String(row.decided_at).trim() : undefined,
      decision_batch_id: row.decision_batch_id ? String(row.decision_batch_id).trim() : undefined,
      decision_source: row.decision_source ? String(row.decision_source).trim() : undefined,
      applied_at: row.applied_at ? String(row.applied_at).trim() : undefined,
    });
  }

  return { decisions: [...decisionMap.values()], warnings };
}

/** Parse a YAML string into review decisions. Accepts arrays or decision bundles. */
export function parseYamlDecisions(content: string): ApplyResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    return { decisions: [], warnings: ['Invalid YAML'] };
  }

  // Delegate to JSON parser logic — the parsed structure is the same
  if (isAgentDecisionBundleV1(parsed)) {
    return { decisions: bundleToReviewDecisions(parsed), warnings: [], bundle: parsed };
  }

  if (!Array.isArray(parsed)) {
    return {
      decisions: [],
      warnings: [
        'YAML must be a list of decision objects or an entity_graph_decision_bundle.v1 document',
      ],
    };
  }

  const decisionMap = new Map<string, ReviewDecisionRow>();
  const seenPairIds = new Set<string>();
  const warnings: string[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i];
    if (row == null || typeof row !== 'object' || Array.isArray(row)) {
      warnings.push(`Entry ${i + 1}: decision must be an object, skipping`);
      continue;
    }
    const pairId = String(row.pair_id ?? '').trim();
    const decision = String(row.decision ?? '')
      .trim()
      .toLowerCase();

    if (!pairId) {
      warnings.push(`Entry ${i}: empty pair_id, skipping`);
      continue;
    }

    if (!VALID_DECISIONS.has(decision)) {
      warnings.push(`Entry ${i}: invalid decision "${decision}" for pair ${pairId}, skipping`);
      continue;
    }

    const statusResult = parseOptionalStatus(row.status, `Entry ${i}`);
    if (!statusResult.ok) {
      warnings.push(`${statusResult.error} skipping`);
      continue;
    }

    if (seenPairIds.has(pairId)) {
      warnings.push(`Duplicate pair_id ${pairId} in input. Using last occurrence.`);
    }
    seenPairIds.add(pairId);

    decisionMap.set(pairId, {
      pair_id: pairId,
      decision: decision as ReviewDecisionRow['decision'],
      status: statusResult.value,
      reviewer: String(row.reviewer ?? 'human').trim(),
      reason: row.reason ? String(row.reason).trim() : undefined,
      confidence: parseOptionalNumber(
        row.confidence as string | number | undefined,
        warnings,
        `Entry ${i}`
      ),
      proposed_decision: parseOptionalDecision(row.proposed_decision, warnings, `Entry ${i}`),
      proposed_confidence: parseOptionalNumber(
        row.proposed_confidence as string | number | undefined,
        warnings,
        `Entry ${i}`
      ),
      decided_at: row.decided_at ? String(row.decided_at).trim() : undefined,
      decision_batch_id: row.decision_batch_id ? String(row.decision_batch_id).trim() : undefined,
      decision_source: row.decision_source ? String(row.decision_source).trim() : undefined,
      applied_at: row.applied_at ? String(row.applied_at).trim() : undefined,
    });
  }

  return { decisions: [...decisionMap.values()], warnings };
}

/** Detect the input format from file content. */
export function detectDecisionInputFormat(content: string): DecisionInputFormat {
  const trimmed = content.trimStart();

  // CSV: starts with a header line (pair_id,decision,...)
  if (
    !trimmed.startsWith('{') &&
    !trimmed.startsWith('[') &&
    !trimmed.startsWith('-') &&
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('version:')
  ) {
    return 'csv';
  }

  // YAML: starts with "- " (list), "---"/"#" document markers, or "version:" bundle docs
  if (
    trimmed.startsWith('- ') ||
    trimmed.startsWith('---') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('version:')
  ) {
    return 'yaml';
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return isAgentDecisionBundleV1(parsed) ? 'decision_bundle' : 'json';
  } catch {
    return 'json';
  }
}

/** Parse decisions from CSV, JSON, YAML, or entity_graph_decision_bundle.v1 objects. */
export function parseDecisions(content: string, format: DecisionInputFormat): ApplyResult {
  if (format === 'csv') return parseCsvDecisions(content);
  if (format === 'yaml') return parseYamlDecisions(content);
  return parseJsonDecisions(content);
}

// ---------------------------------------------------------------------------
// SQL generation for applying decisions
// ---------------------------------------------------------------------------

/**
 * Execute a review-apply plan as a fail-fast dependency chain.
 *
 * The generic executor records failures instead of throwing immediately. By
 * linking every write to its predecessor, a failed audit/decision/materialize
 * step skips all later writes and preserves the earliest retry signal. This is
 * deliberately not described as atomic: the public runner contract has no
 * cross-warehouse transaction primitive, so already-successful statements
 * remain committed and must stay idempotent.
 */
export function chainReviewApplySql(statements: SqlStatement[]): SqlStatement[] {
  return statements.map((statement, index) => {
    const previous = statements[index - 1]?.name;
    if (!previous) return statement;
    return {
      ...statement,
      deps: [...new Set([...(statement.deps ?? []), previous])],
    };
  });
}

/**
 * Generate SQL to INSERT decisions into __review_decisions
 * and not_match decisions into __not_match_edges.
 */
export function generateApplySql(
  decisions: ReviewDecisionRow[],
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string,
  options: {
    defaultBatchId: string;
    defaultContentHash?: string;
    defaultDecisionSource?: string;
    appliedAt?: string;
  }
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  // Actionable rows are finalized merge / not_match decisions that should
  // write into the not_match_edges projection. We whitelist only the
  // statuses that represent a final commit:
  //   - undefined: legacy rows from before the lifecycle column existed —
  //     treat as final since callers were already applying them.
  //   - 'applied': explicitly committed by the apply pipeline.
  // Everything else (`proposed`, `escalated`, `deferred`, `superseded`)
  // stays in the pending bucket so a stray import of one of those rows
  // can't run delete_affected_not_match_edges and clear the projection.
  const isActionableDecision = (d: ReviewDecisionRow): boolean =>
    d.decision !== 'defer' && (d.status === undefined || d.status === 'applied');
  const actionableDecisions = decisions.filter(isActionableDecision);
  const nonActionableDecisions = decisions.filter((d) => !isActionableDecision(d));
  if (actionableDecisions.length === 0 && nonActionableDecisions.length === 0) {
    return statements;
  }

  const decisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );

  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const decisionCol = quoteIdentifier('decision', dialect);
  const reviewerCol = quoteIdentifier('reviewer', dialect);
  const reasonCol = quoteIdentifier('reason', dialect);
  const decisionBatchIdCol = quoteIdentifier('decision_batch_id', dialect);
  const decisionSourceCol = quoteIdentifier('decision_source', dialect);
  const decidedAtCol = quoteIdentifier('decided_at', dialect);
  const appliedAtCol = quoteIdentifier('applied_at', dialect);
  const confidenceCol = quoteIdentifier('confidence', dialect);
  const statusCol = quoteIdentifier('status', dialect);

  if (actionableDecisions.length > 0) {
    statements.push(
      buildDecisionInsertStatement(
        'apply_review_decisions',
        actionableDecisions,
        decisionsTable,
        dialect,
        options
      )
    );
  }

  if (nonActionableDecisions.length > 0) {
    statements.push(
      buildDecisionInsertStatement(
        'apply_review_decisions_pending',
        nonActionableDecisions,
        decisionsTable,
        dialect,
        options
      )
    );
  }

  if (actionableDecisions.length === 0) {
    return statements;
  }

  const incomingDecisions = buildIncomingDecisionsCte(actionableDecisions, dialect, options);

  const edgesTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__not_match_edges'),
    dialect
  );
  const scoresTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__pair_scores'),
    dialect
  );
  const recordAIdCol = quoteIdentifier('record_a_id', dialect);
  const recordBIdCol = quoteIdentifier('record_b_id', dialect);
  // BigQuery rejects a WITH clause that precedes INSERT/DELETE, so the CTE
  // chain lives inside the query expression (valid on every supported
  // dialect): DELETE ... WHERE ... IN (WITH ... SELECT) and
  // INSERT INTO t (cols) WITH ... SELECT.
  const latestDecisionsCtes = [
    `WITH ${incomingDecisions},`,
    `affected_pairs AS (`,
    `  SELECT DISTINCT ${pairIdCol}`,
    `  FROM incoming_decisions`,
    `), latest_decisions AS (`,
    `  SELECT *`,
    `  FROM (`,
    `    SELECT`,
    `      ${pairIdCol},`,
    `      ${decisionCol},`,
    `      ${reviewerCol},`,
    `      ${reasonCol},`,
    `      ${confidenceCol},`,
    `      ${statusCol},`,
    `      ${decisionBatchIdCol},`,
    `      ${decisionSourceCol},`,
    `      ${decidedAtCol},`,
    `      ${appliedAtCol},`,
    `      ROW_NUMBER() OVER (`,
    `        PARTITION BY ${pairIdCol}`,
    `        ORDER BY ${decidedAtCol} DESC, ${appliedAtCol} DESC`,
    `      ) AS rn`,
    `    FROM ${decisionsTable}`,
    `    WHERE ${pairIdCol} IN (SELECT ${pairIdCol} FROM affected_pairs)`,
    `  ) ranked`,
    `  WHERE ranked.rn = 1`,
    `)`,
  ].join('\n');

  statements.push({
    name: 'delete_affected_not_match_edges',
    sql: [
      `DELETE FROM ${edgesTable}`,
      `WHERE ${pairIdCol} IN (`,
      latestDecisionsCtes,
      `SELECT ${pairIdCol} FROM latest_decisions`,
      `)`,
    ].join('\n'),
  });

  statements.push({
    name: 'refresh_not_match_edges',
    sql: [
      `INSERT INTO ${edgesTable}`,
      `  (${pairIdCol}, ${recordAIdCol}, ${recordBIdCol}, ${reviewerCol}, ${reasonCol}, ${decisionBatchIdCol}, ${decisionSourceCol}, ${decidedAtCol}, ${appliedAtCol}, ${confidenceCol})`,
      latestDecisionsCtes,
      `SELECT`,
      `  ld.${pairIdCol},`,
      `  ps.${recordAIdCol},`,
      `  ps.${recordBIdCol},`,
      `  ld.${reviewerCol},`,
      `  ld.${reasonCol},`,
      `  ld.${decisionBatchIdCol},`,
      `  ld.${decisionSourceCol},`,
      `  ld.${decidedAtCol},`,
      `  ld.${appliedAtCol},`,
      `  ld.${confidenceCol}`,
      `FROM latest_decisions ld`,
      `JOIN ${scoresTable} ps ON ld.${pairIdCol} = ps.${pairIdCol}`,
      `WHERE ld.${decisionCol} = ${quoteLiteral('not_match', dialect)}`,
      `  AND COALESCE(ld.${statusCol}, ${quoteLiteral('applied', dialect)}) = ${quoteLiteral('applied', dialect)}`,
    ].join('\n'),
  });

  return statements;
}

function buildDecisionInsertStatement(
  name: string,
  decisions: ReviewDecisionRow[],
  decisionsTable: string,
  dialect: SupportedDialect,
  options: {
    defaultBatchId: string;
    defaultContentHash?: string;
    defaultDecisionSource?: string;
    appliedAt?: string;
  }
): SqlStatement {
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const decisionCol = quoteIdentifier('decision', dialect);
  const reviewerCol = quoteIdentifier('reviewer', dialect);
  const reasonCol = quoteIdentifier('reason', dialect);
  const confidenceCol = quoteIdentifier('confidence', dialect);
  const proposedDecisionCol = quoteIdentifier('proposed_decision', dialect);
  const proposedConfidenceCol = quoteIdentifier('proposed_confidence', dialect);
  const statusCol = quoteIdentifier('status', dialect);
  const decisionBatchIdCol = quoteIdentifier('decision_batch_id', dialect);
  const contentHashCol = quoteIdentifier('content_hash', dialect);
  const decisionSourceCol = quoteIdentifier('decision_source', dialect);
  const decidedAtCol = quoteIdentifier('decided_at', dialect);
  const appliedAtCol = quoteIdentifier('applied_at', dialect);
  const incomingDecisions = buildIncomingDecisionsCte(decisions, dialect, options);
  const newDecisionsCte = buildNewDecisionsCte(decisionsTable, dialect);

  return {
    name,
    sql: [
      `INSERT INTO ${decisionsTable}`,
      `  (${pairIdCol}, ${decisionCol}, ${reviewerCol}, ${reasonCol}, ${confidenceCol}, ${proposedDecisionCol}, ${proposedConfidenceCol}, ${statusCol}, ${decisionBatchIdCol}, ${contentHashCol}, ${decisionSourceCol}, ${decidedAtCol}, ${appliedAtCol})`,
      `WITH ${incomingDecisions}`,
      newDecisionsCte,
      `SELECT`,
      `  incoming.${pairIdCol},`,
      `  incoming.${decisionCol},`,
      `  incoming.${reviewerCol},`,
      `  incoming.${reasonCol},`,
      `  incoming.${confidenceCol},`,
      `  incoming.${proposedDecisionCol},`,
      `  incoming.${proposedConfidenceCol},`,
      `  incoming.${statusCol},`,
      `  incoming.${decisionBatchIdCol},`,
      `  incoming.${contentHashCol},`,
      `  incoming.${decisionSourceCol},`,
      `  incoming.${decidedAtCol},`,
      `  incoming.${appliedAtCol}`,
      `FROM new_decisions incoming`,
    ].join('\n'),
  };
}

function buildNewDecisionsCte(decisionsTable: string, dialect: SupportedDialect): string {
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const decisionCol = quoteIdentifier('decision', dialect);
  const reviewerCol = quoteIdentifier('reviewer', dialect);
  const reasonCol = quoteIdentifier('reason', dialect);
  const confidenceCol = quoteIdentifier('confidence', dialect);
  const proposedDecisionCol = quoteIdentifier('proposed_decision', dialect);
  const proposedConfidenceCol = quoteIdentifier('proposed_confidence', dialect);
  const statusCol = quoteIdentifier('status', dialect);
  const decisionBatchIdCol = quoteIdentifier('decision_batch_id', dialect);
  const contentHashCol = quoteIdentifier('content_hash', dialect);

  return [
    `, new_decisions AS (`,
    `  SELECT incoming.*`,
    `  FROM incoming_decisions incoming`,
    `  WHERE NOT EXISTS (`,
    `    SELECT 1`,
    `    FROM ${decisionsTable} existing`,
    `    WHERE (`,
    `      incoming.${contentHashCol} IS NOT NULL`,
    // Correlate the hash-branch idempotency check per pair. generateApplySql
    // splits one apply into two sequential INSERTs (actionable, then pending)
    // that share defaultBatchId + defaultContentHash; without pair_id here the
    // pending statement's rows all match the actionable statement's just-
    // inserted rows on (batch_id, content_hash) and get filtered to nothing —
    // silently dropping every proposed/deferred decision.
    `      AND existing.${pairIdCol} = incoming.${pairIdCol}`,
    `      AND existing.${decisionBatchIdCol} = incoming.${decisionBatchIdCol}`,
    `      AND existing.${contentHashCol} = incoming.${contentHashCol}`,
    `    ) OR (`,
    `      incoming.${contentHashCol} IS NULL`,
    `      AND existing.${pairIdCol} = incoming.${pairIdCol}`,
    `      AND existing.${decisionCol} = incoming.${decisionCol}`,
    `      AND (existing.${reviewerCol} = incoming.${reviewerCol} OR (existing.${reviewerCol} IS NULL AND incoming.${reviewerCol} IS NULL))`,
    `      AND (existing.${reasonCol} = incoming.${reasonCol} OR (existing.${reasonCol} IS NULL AND incoming.${reasonCol} IS NULL))`,
    `      AND (existing.${confidenceCol} = incoming.${confidenceCol} OR (existing.${confidenceCol} IS NULL AND incoming.${confidenceCol} IS NULL))`,
    `      AND (existing.${proposedDecisionCol} = incoming.${proposedDecisionCol} OR (existing.${proposedDecisionCol} IS NULL AND incoming.${proposedDecisionCol} IS NULL))`,
    `      AND (existing.${proposedConfidenceCol} = incoming.${proposedConfidenceCol} OR (existing.${proposedConfidenceCol} IS NULL AND incoming.${proposedConfidenceCol} IS NULL))`,
    `      AND (existing.${statusCol} = incoming.${statusCol} OR (existing.${statusCol} IS NULL AND incoming.${statusCol} IS NULL))`,
    `      AND existing.${decisionBatchIdCol} = incoming.${decisionBatchIdCol}`,
    `    )`,
    `  )`,
    `)`,
  ].join('\n');
}

function buildIncomingDecisionsCte(
  decisions: ReviewDecisionRow[],
  dialect: SupportedDialect,
  options: {
    defaultBatchId: string;
    defaultContentHash?: string;
    defaultDecisionSource?: string;
    appliedAt?: string;
  }
): string {
  // Literal timestamps and NULLs must be explicitly typed: BigQuery does not
  // implicitly coerce STRING literals to TIMESTAMP in INSERT ... SELECT, and
  // infers INT64 for bare NULL — both fail against the
  // __review_decisions column types.
  const timestampType = mapColumnType('TIMESTAMP', dialect);
  const timestampLiteral = (value: string): string =>
    `CAST(${quoteLiteral(value, dialect)} AS ${timestampType})`;

  const selects = decisions.map((decision) => {
    const decidedAt = decision.decided_at
      ? timestampLiteral(decision.decided_at)
      : 'CURRENT_TIMESTAMP';
    const appliedAt = decision.applied_at
      ? timestampLiteral(decision.applied_at)
      : options.appliedAt
        ? timestampLiteral(options.appliedAt)
        : 'CURRENT_TIMESTAMP';
    const batchId = decision.decision_batch_id ?? options.defaultBatchId;
    const contentHash = decision.content_hash ?? options.defaultContentHash;
    const decisionSource = decision.decision_source ?? options.defaultDecisionSource ?? 'human';
    const status = resolveDecisionStatus(decision.decision, decision.status);

    return [
      `SELECT`,
      `  ${quoteLiteral(decision.pair_id, dialect)} AS ${quoteIdentifier('pair_id', dialect)},`,
      `  ${quoteLiteral(decision.decision, dialect)} AS ${quoteIdentifier('decision', dialect)},`,
      `  ${quoteLiteral(decision.reviewer ?? 'human', dialect)} AS ${quoteIdentifier('reviewer', dialect)},`,
      `  ${decision.reason ? quoteLiteral(decision.reason, dialect) : typedNull('STRING', dialect)} AS ${quoteIdentifier('reason', dialect)},`,
      `  ${decision.confidence != null ? quoteLiteral(decision.confidence, dialect) : typedNull('FLOAT', dialect)} AS ${quoteIdentifier('confidence', dialect)},`,
      `  ${decision.proposed_decision ? quoteLiteral(decision.proposed_decision, dialect) : typedNull('STRING', dialect)} AS ${quoteIdentifier('proposed_decision', dialect)},`,
      `  ${decision.proposed_confidence != null ? quoteLiteral(decision.proposed_confidence, dialect) : typedNull('FLOAT', dialect)} AS ${quoteIdentifier('proposed_confidence', dialect)},`,
      `  ${quoteLiteral(status, dialect)} AS ${quoteIdentifier('status', dialect)},`,
      `  ${quoteLiteral(batchId, dialect)} AS ${quoteIdentifier('decision_batch_id', dialect)},`,
      `  ${contentHash ? quoteLiteral(contentHash, dialect) : typedNull('STRING', dialect)} AS ${quoteIdentifier('content_hash', dialect)},`,
      `  ${quoteLiteral(decisionSource, dialect)} AS ${quoteIdentifier('decision_source', dialect)},`,
      `  ${decidedAt} AS ${quoteIdentifier('decided_at', dialect)},`,
      `  ${appliedAt} AS ${quoteIdentifier('applied_at', dialect)}`,
    ].join('\n');
  });

  return [`incoming_decisions AS (`, selects.join('\nUNION ALL\n'), `)`].join('\n');
}

// ---------------------------------------------------------------------------
// Internal CSV line parser
// ---------------------------------------------------------------------------

/** Parse a single CSV line respecting quoted fields (RFC 4180). */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}
