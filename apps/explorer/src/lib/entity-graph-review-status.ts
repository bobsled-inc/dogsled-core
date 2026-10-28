export type EntityGraphQueueStatus = 'open' | 'decided' | 'all';

const SAFE_SQL_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the SQL predicate that filters the review queue by lifecycle bucket.
 *
 * Three statuses are emitted by the current pipeline:
 *   - `applied`   — auto-committed merge/not_match. Final.
 *   - `proposed`  — agent committed to a merge/not_match call but confidence
 *                   fell below the auto-apply gate. Awaiting review/eval.
 *   - `deferred`  — the agent itself returned `defer` (confidence below the
 *                   agent's own floor). Needs follow-up attention.
 *
 * Backward compatibility: older runs emitted `decision='escalate'` and/or
 * `status='escalated'`. We never produce these values anymore, but legacy
 * rows may still live in `__review_decisions`. The `'open'` clause keeps
 * those rows visible so they don't silently disappear from review.
 */
export function buildEntityGraphQueueStatusClause(
  status: EntityGraphQueueStatus,
  alias = 'ld'
): string {
  if (status === 'all') return '1=1';
  if (!SAFE_SQL_ALIAS_RE.test(alias)) {
    throw new Error('Invalid SQL alias for review queue status clause.');
  }

  const decisionCol = `${alias}."decision"`;
  const statusCol = `${alias}."decision_status"`;

  // Open bucket: no decision yet, agent-deferred (defer/legacy escalate), or
  // status indicates the pair still needs review (proposed/deferred/escalated).
  if (status === 'open') {
    return `(${decisionCol} IS NULL OR ${decisionCol} IN ('defer', 'escalate') OR ${statusCol} IN ('proposed', 'deferred', 'escalated'))`;
  }

  return `(${decisionCol} IN ('merge', 'not_match') AND (${statusCol} IS NULL OR ${statusCol} = 'applied'))`;
}
