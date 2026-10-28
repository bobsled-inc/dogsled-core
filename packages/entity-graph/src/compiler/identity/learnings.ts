import { z } from 'zod';

import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { outputTableName } from '../output-tables/index.js';

export const LearningRowsSchema = z.array(
  z.object({
    pair_id: z.string(),
    decision: z.string(),
    human_feedback_outcome: z.enum(['incorrect', 'needs_revision']).nullable(),
    reason: z.string().nullable(),
    human_feedback_reason: z.string().nullable(),
    feedback_timestamp: z.coerce.string(),
  })
);

export type LearningRow = z.infer<typeof LearningRowsSchema>[number];

export function buildExtractLearningsQuery(
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string,
  limit = 10
): string {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid limit ${limit}. Expected a non-negative integer.`);
  }

  const reviewDecisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );

  const outcomeColumn = quoteIdentifier('human_feedback_outcome', dialect);
  const incorrectLiteral = quoteLiteral('incorrect', dialect);
  const needsRevisionLiteral = quoteLiteral('needs_revision', dialect);

  return [
    `SELECT ${quoteIdentifier('pair_id', dialect)},`,
    `       ${quoteIdentifier('decision', dialect)},`,
    `       ${outcomeColumn},`,
    `       ${quoteIdentifier('reason', dialect)},`,
    `       ${quoteIdentifier('human_feedback_reason', dialect)},`,
    `       ${quoteIdentifier('feedback_timestamp', dialect)}`,
    `FROM ${reviewDecisionsTable}`,
    `WHERE ${outcomeColumn} IN (${incorrectLiteral}, ${needsRevisionLiteral})`,
    `  AND ${quoteIdentifier('human_feedback_reason', dialect)} IS NOT NULL`,
    `ORDER BY ${quoteIdentifier('feedback_timestamp', dialect)} DESC`,
    `LIMIT ${quoteLiteral(limit, dialect)}`,
  ].join('\n');
}

const MAX_LEARNING_TEXT_LENGTH = 500;

function sanitizeLearningText(value: string | null | undefined): string {
  if (value == null) {
    return '';
  }
  const collapsed = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = collapsed
    .replace(/```+/g, '`')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/[<>]/g, '');
  return stripped.length > MAX_LEARNING_TEXT_LENGTH
    ? `${stripped.slice(0, MAX_LEARNING_TEXT_LENGTH)}…`
    : stripped;
}

export function formatLearningsSummary(rows: LearningRow[]): string {
  if (rows.length === 0) {
    return '';
  }

  const lines = rows.map((row) => {
    const correction = sanitizeLearningText(row.human_feedback_reason);
    const agentReason = sanitizeLearningText(row.reason);
    const pairId = sanitizeLearningText(row.pair_id);
    const decision = sanitizeLearningText(row.decision);
    const outcomeLabel =
      row.human_feedback_outcome === 'needs_revision' ? 'needs_revision' : 'incorrect';
    const correctionText =
      correction.length > 0
        ? correction
        : `Human reviewer marked this ${outcomeLabel} without details.`;
    return agentReason.length > 0
      ? `- Pair ${pairId}: Agent decided '${decision}' but human marked ${outcomeLabel}: "${correctionText}". Original rationale: ${agentReason}`
      : `- Pair ${pairId}: Agent decided '${decision}' but human marked ${outcomeLabel}: "${correctionText}".`;
  });

  return ['Here are recent corrections from human review. Learn from these patterns:', ...lines]
    .join('\n')
    .trim();
}
