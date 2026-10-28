/**
 * Review export — export __review_queue to CSV, JSON, or YAML.
 *
 * Provides the data contract between the open-source pipeline
 * and any review UI (human or automated).
 */

import YAML from 'yaml';

import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ReviewExportRow } from './types.js';
import { outputTableName } from '../output-tables/index.js';

export type ReviewThresholdBand = ReviewExportRow['threshold_band'];

// ---------------------------------------------------------------------------
// CSV / JSON / YAML formatting
// ---------------------------------------------------------------------------

const BASE_CSV_COLUMNS: (keyof ReviewExportRow)[] = [
  'pair_id',
  'record_a_id',
  'record_b_id',
  'source_a',
  'source_b',
  'composite_score',
  'threshold_band',
  'blocking_rules',
  'field_diffs',
  'recommended_action',
  'semantic_score',
  'semantic_decision',
  'rule_name',
];

const DECISION_CSV_COLUMNS: (keyof ReviewExportRow)[] = [
  'decision',
  'confidence',
  'reviewer',
  'reason',
  'proposed_decision',
  'proposed_confidence',
  'confidence_gap',
  'decided_at',
  'decision_source',
  'decision_batch_id',
  'applied_at',
];

function resolveCsvColumns(
  rows: ReviewExportRow[],
  options: { template?: boolean } = {}
): Array<keyof ReviewExportRow> {
  const includeDecisionColumns =
    options.template ||
    rows.some(
      (row) =>
        row.decision != null ||
        row.confidence != null ||
        row.reviewer != null ||
        row.reason != null ||
        row.proposed_decision != null ||
        row.proposed_confidence != null ||
        row.decided_at != null ||
        row.decision_source != null ||
        row.decision_batch_id != null ||
        row.applied_at != null
    );
  return includeDecisionColumns ? [...BASE_CSV_COLUMNS, ...DECISION_CSV_COLUMNS] : BASE_CSV_COLUMNS;
}

/** Escape a CSV field value per RFC 4180. */
function escapeCsvField(value: string): string {
  if (/^[=+@-]/.test(value)) value = "'" + value;
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Format rows as CSV string. */
export function formatCsv(rows: ReviewExportRow[], options: { template?: boolean } = {}): string {
  const columns = resolveCsvColumns(rows, options);
  const header = columns.join(',');
  const lines = rows.map((row) =>
    columns.map((col) => escapeCsvField(String(row[col] ?? ''))).join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

/** Format rows as JSON string (array of objects). */
export function formatJson(rows: ReviewExportRow[], options: { template?: boolean } = {}): string {
  return JSON.stringify(applyTemplateFields(rows, options), null, 2) + '\n';
}

/** Format rows as YAML string — more readable for humans and agents. */
export function formatYaml(rows: ReviewExportRow[], options: { template?: boolean } = {}): string {
  return YAML.stringify(applyTemplateFields(rows, options), { lineWidth: 120 });
}

// ---------------------------------------------------------------------------
// SQL query for reading review queue
// ---------------------------------------------------------------------------

/**
 * Generate SQL to read the __review_queue table, sorted by uncertainty
 * (highest information gain first — closest to threshold midpoint).
 */
export function generateExportQuery(
  entityName: string,
  targetSchema: string,
  thresholdMidpoint: number,
  dialect: SupportedDialect = 'snowflake',
  options: {
    pendingOnly?: boolean;
    includeDecisionColumns?: boolean;
    thresholdBands?: readonly ReviewThresholdBand[];
    limit?: number;
    confidenceThresholds?: {
      default: number;
      byBand?: Partial<Record<ReviewThresholdBand, number>>;
    };
  } = {}
): string {
  const queueTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_queue'),
    dialect
  );
  const decisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );
  const compositeScore = quoteIdentifier('composite_score', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const decision = quoteIdentifier('decision', dialect);
  const status = quoteIdentifier('status', dialect);
  const decidedAt = quoteIdentifier('decided_at', dialect);
  const appliedAt = quoteIdentifier('applied_at', dialect);
  const thresholdBand = quoteIdentifier('threshold_band', dialect);
  const includeDecisionColumns = options.includeDecisionColumns ?? false;
  const pendingOnly = options.pendingOnly ?? true;
  const thresholdBands = options.thresholdBands ?? [];
  const limit = options.limit;
  const needsDecisionJoin = pendingOnly || includeDecisionColumns;
  const columns = BASE_CSV_COLUMNS.map((col) => `rq.${quoteIdentifier(col, dialect)}`);
  const confidenceThresholds = options.confidenceThresholds;
  const confidenceValueExpr = `COALESCE(ld.${quoteIdentifier('proposed_confidence', dialect)}, ld.${quoteIdentifier('confidence', dialect)})`;
  const defaultThreshold = confidenceThresholds?.default ?? 0.75;
  const thresholdExpr = [
    `CASE`,
    ...Object.entries(confidenceThresholds?.byBand ?? {}).map(
      ([band, value]) =>
        `  WHEN rq.${thresholdBand} = ${quoteLiteral(band, dialect)} THEN ${quoteLiteral(value, dialect)}`
    ),
    `  ELSE ${quoteLiteral(defaultThreshold, dialect)}`,
    `END`,
  ].join('\n');
  const confidenceGapExpr = [
    `CASE`,
    `  WHEN ${confidenceValueExpr} IS NULL THEN NULL`,
    `  ELSE (${thresholdExpr}) - ${confidenceValueExpr}`,
    `END`,
  ].join('\n');
  const decisionColumns = includeDecisionColumns
    ? [
        `ld.${decision}`,
        `ld.${quoteIdentifier('confidence', dialect)}`,
        `ld.${quoteIdentifier('reviewer', dialect)}`,
        `ld.${quoteIdentifier('reason', dialect)}`,
        `ld.${quoteIdentifier('proposed_decision', dialect)}`,
        `ld.${quoteIdentifier('proposed_confidence', dialect)}`,
        `${confidenceGapExpr} AS ${quoteIdentifier('confidence_gap', dialect)}`,
        `ld.${decidedAt}`,
        `ld.${quoteIdentifier('decision_source', dialect)}`,
        `ld.${quoteIdentifier('decision_batch_id', dialect)}`,
        `ld.${appliedAt}`,
      ]
    : [];
  const whereClauses: string[] = [];

  if (pendingOnly) {
    whereClauses.push(
      `(ld.${pairId} IS NULL OR COALESCE(ld.${status}, ${quoteLiteral('applied', dialect)}) IN (${quoteLiteral('proposed', dialect)}, ${quoteLiteral('deferred', dialect)}, ${quoteLiteral('escalated', dialect)}) OR (ld.${status} IS NULL AND ld.${decision} IN (${quoteLiteral('defer', dialect)}, ${quoteLiteral('escalate', dialect)})))`
    );
  }

  if (thresholdBands.length > 0) {
    const values = thresholdBands.map((band) => quoteLiteral(band, dialect)).join(', ');
    whereClauses.push(`rq.${thresholdBand} IN (${values})`);
  }

  if (limit != null && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`Invalid limit ${limit}. Expected a non-negative integer.`);
  }

  return [
    ...(needsDecisionJoin
      ? [
          `WITH latest_decisions AS (`,
          `  SELECT *`,
          `  FROM (`,
          `    SELECT`,
          `      ${pairId},`,
          `      ${decision},`,
          `      ${quoteIdentifier('confidence', dialect)},`,
          `      ${quoteIdentifier('reviewer', dialect)},`,
          `      ${quoteIdentifier('reason', dialect)},`,
          `      ${quoteIdentifier('proposed_decision', dialect)},`,
          `      ${quoteIdentifier('proposed_confidence', dialect)},`,
          `      ${status},`,
          `      ${decidedAt},`,
          `      ${quoteIdentifier('decision_source', dialect)},`,
          `      ${quoteIdentifier('decision_batch_id', dialect)},`,
          `      ${appliedAt},`,
          `      ROW_NUMBER() OVER (`,
          `        PARTITION BY ${pairId}`,
          `        ORDER BY ${decidedAt} DESC, ${appliedAt} DESC`,
          `      ) AS rn`,
          `    FROM ${decisionsTable}`,
          `  ) ranked`,
          `  WHERE ranked.rn = 1`,
          `)`,
        ]
      : []),
    `SELECT ${[...columns, ...decisionColumns].join(', ')}`,
    `FROM ${queueTable} rq`,
    ...(needsDecisionJoin ? [`LEFT JOIN latest_decisions ld ON rq.${pairId} = ld.${pairId}`] : []),
    whereClauses.length > 0
      ? `WHERE ${whereClauses.map((clause) => `(${clause})`).join('\n  AND ')}`
      : '',
    `ORDER BY ABS(${compositeScore} - ${quoteLiteral(thresholdMidpoint, dialect)}) ASC`,
    limit != null ? `LIMIT ${quoteLiteral(limit, dialect)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export type ReviewExportFormat = 'csv' | 'json' | 'yaml';

const REDACTED_SENTINEL = '[REDACTED]';

/**
 * Apply PII redaction to review rows.
 * Replaces field values matching piiFields in the field_diffs JSON column.
 */
export function applyPiiRedaction(
  rows: ReviewExportRow[],
  piiFields: readonly string[]
): ReviewExportRow[] {
  if (piiFields.length === 0) return rows;

  const fieldSet = new Set(piiFields);

  return rows.map((row) => {
    if (!row.field_diffs) return row;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.field_diffs);
    } catch {
      return row;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return row;

    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      redacted[key] = fieldSet.has(key) ? REDACTED_SENTINEL : value;
    }

    return { ...row, field_diffs: JSON.stringify(redacted) };
  });
}

/** Format export rows in the requested format. */
export function formatExport(
  rows: ReviewExportRow[],
  format: ReviewExportFormat,
  options: { template?: boolean; piiRedactFields?: readonly string[] } = {}
): string {
  const processedRows =
    options.piiRedactFields && options.piiRedactFields.length > 0
      ? applyPiiRedaction(rows, options.piiRedactFields)
      : rows;
  if (format === 'csv') return formatCsv(processedRows, options);
  if (format === 'yaml') return formatYaml(processedRows, options);
  return formatJson(processedRows, options);
}

function applyTemplateFields(
  rows: ReviewExportRow[],
  options: { template?: boolean }
): ReviewExportRow[] {
  if (!options.template) {
    return rows;
  }

  return rows.map((row) => ({
    ...row,
    decision: row.decision ?? null,
    confidence: row.confidence ?? null,
    reviewer: row.reviewer ?? null,
    reason: row.reason ?? null,
    proposed_decision: row.proposed_decision ?? null,
    proposed_confidence: row.proposed_confidence ?? null,
  }));
}
