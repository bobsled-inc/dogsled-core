import type { ResolvedRelationshipOntology } from '../ontology/types.js';

export type RelationshipRank = 'preferred' | 'normal' | 'conflicted' | 'deprecated';
export type RelationshipDecision = 'confirm' | 'reject' | 'supersede' | 'conflicted';

export interface RelationshipEvidenceAggregationRow {
  evidence_id: string;
  relationship_id: string;
  left_entity_id: string;
  right_entity_id: string;
  relation_type: string;
  confidence: number;
  source_document_id: string | null;
  evidence_kind: string;
  observed_at: string | null;
  recorded_at: string;
}

export interface RelationshipDecisionAggregationRow {
  evidence_id?: string | null;
  relationship_id: string;
  decision: RelationshipDecision;
}

export interface CompactedRelationshipRow {
  relationship_id: string;
  left_entity_id: string;
  right_entity_id: string;
  relation_type: string;
  confidence: number;
  rank: RelationshipRank;
  valid_from: string | null;
  valid_to: string | null;
  evidence_count: number;
  evidence_diversity: number;
  freshness_age_seconds: number;
  lineage_run_id: string;
}

function clampConfidence(value: number): number {
  return Math.min(0.999, Math.max(0.001, value));
}

export function logOddsAggregate(confidences: readonly number[]): number {
  if (confidences.length === 0) {
    throw new Error('logOddsAggregate requires at least one confidence value');
  }
  const logOdds = confidences.reduce((sum, confidence) => {
    const c = clampConfidence(confidence);
    return sum + Math.log(c / (1 - c));
  }, 0);
  return 1 / (1 + Math.exp(-logOdds));
}

function secondsBetween(leftIso: string, right: Date): number {
  const ms = right.getTime() - new Date(leftIso).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms / 1000));
}

function dedupeBySource(
  rows: readonly RelationshipEvidenceAggregationRow[]
): RelationshipEvidenceAggregationRow[] {
  const best = new Map<string, RelationshipEvidenceAggregationRow>();
  for (const row of rows) {
    const key = `${row.relationship_id}\u0000${row.source_document_id ?? row.evidence_id}`;
    const existing = best.get(key);
    if (
      !existing ||
      row.confidence > existing.confidence ||
      (row.confidence === existing.confidence && row.recorded_at > existing.recorded_at)
    ) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

function groupRows(
  rows: readonly RelationshipEvidenceAggregationRow[]
): Map<string, RelationshipEvidenceAggregationRow[]> {
  const grouped = new Map<string, RelationshipEvidenceAggregationRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.relationship_id) ?? [];
    bucket.push(row);
    grouped.set(row.relationship_id, bucket);
  }
  return grouped;
}

function relationByType(ontology: ResolvedRelationshipOntology): Map<string, string[]> {
  return new Map(
    ontology.relations.map((relation) => [relation.relation_type, relation.exclusive_with])
  );
}

function entityPairKey(leftEntityId: string, rightEntityId: string): string {
  return `${leftEntityId.length}:${leftEntityId}|${rightEntityId.length}:${rightEntityId}`;
}

export function compactRelationshipEvidenceRows(
  evidenceRows: readonly RelationshipEvidenceAggregationRow[],
  decisionRows: readonly RelationshipDecisionAggregationRow[],
  ontology: ResolvedRelationshipOntology,
  options: { now?: Date; lineageRunId?: string } = {}
): CompactedRelationshipRow[] {
  const now = options.now ?? new Date();
  const lineageRunId = options.lineageRunId ?? now.toISOString();
  const rejectedEvidence = new Set(
    decisionRows
      .filter((decision) => decision.decision === 'reject' && decision.evidence_id)
      .map((decision) => decision.evidence_id!)
  );
  const supersededRelationships = new Set(
    decisionRows
      .filter((decision) => decision.decision === 'supersede')
      .map((decision) => decision.relationship_id)
  );

  const byRelationship = groupRows(evidenceRows);
  const compacted: CompactedRelationshipRow[] = [];

  for (const [relationshipId, allRows] of byRelationship) {
    const kept = dedupeBySource(allRows.filter((row) => !rejectedEvidence.has(row.evidence_id)));
    const first = allRows[0]!;
    if (kept.length === 0) {
      compacted.push({
        relationship_id: relationshipId,
        left_entity_id: first.left_entity_id,
        right_entity_id: first.right_entity_id,
        relation_type: first.relation_type,
        confidence: 0,
        rank: 'deprecated',
        valid_from: null,
        valid_to: now.toISOString(),
        evidence_count: 0,
        evidence_diversity: 0,
        freshness_age_seconds: secondsBetween(first.recorded_at, now),
        lineage_run_id: lineageRunId,
      });
      continue;
    }

    const recordedAts = kept.map((row) => row.recorded_at).sort();
    const observedAts = kept
      .map((row) => row.observed_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    compacted.push({
      relationship_id: relationshipId,
      left_entity_id: first.left_entity_id,
      right_entity_id: first.right_entity_id,
      relation_type: first.relation_type,
      confidence: logOddsAggregate(kept.map((row) => row.confidence)),
      rank: supersededRelationships.has(relationshipId) ? 'deprecated' : 'normal',
      valid_from: observedAts[0] ?? null,
      valid_to: supersededRelationships.has(relationshipId)
        ? (observedAts[observedAts.length - 1] ?? now.toISOString())
        : null,
      evidence_count: kept.length,
      evidence_diversity: new Set(
        kept.map((row) => `${row.source_document_id ?? '<none>'}\u0000${row.evidence_kind}`)
      ).size,
      freshness_age_seconds: secondsBetween(recordedAts[recordedAts.length - 1]!, now),
      lineage_run_id: lineageRunId,
    });
  }

  const exclusives = relationByType(ontology);
  const compactedByPair = new Map<string, CompactedRelationshipRow[]>();
  for (const row of compacted) {
    const key = entityPairKey(row.left_entity_id, row.right_entity_id);
    const bucket = compactedByPair.get(key) ?? [];
    bucket.push(row);
    compactedByPair.set(key, bucket);
  }

  for (const bucket of compactedByPair.values()) {
    for (const row of bucket) {
      if (row.rank === 'deprecated') continue;
      const exclusiveTypes = exclusives.get(row.relation_type) ?? [];
      const conflicts = bucket.filter(
        (candidate) =>
          candidate.relationship_id !== row.relationship_id &&
          exclusiveTypes.includes(candidate.relation_type) &&
          candidate.rank !== 'deprecated'
      );
      if (conflicts.length === 0) {
        row.rank = 'preferred';
        continue;
      }
      const strongest = [row, ...conflicts].reduce((best, candidate) =>
        candidate.confidence > best.confidence ||
        (candidate.confidence === best.confidence &&
          candidate.relationship_id < best.relationship_id)
          ? candidate
          : best
      );
      row.rank = strongest.relationship_id === row.relationship_id ? 'preferred' : 'conflicted';
    }
  }

  return compacted.sort((a, b) => a.relationship_id.localeCompare(b.relationship_id));
}
