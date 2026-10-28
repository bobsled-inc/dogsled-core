import type { ResolvedRelationshipOntology } from '../../compiler/ontology/types.js';

export interface ResolvedChunkMention {
  mention_id: string;
  chunk_id: string;
  entity_type: string;
  entity_name?: string;
  resolved_entity_id: string | null;
  span_start?: number;
  span_end?: number;
}

export interface RelationshipCandidatePair {
  pair_id: string;
  left_mention_id: string;
  right_mention_id: string;
  left_entity_name?: string;
  right_entity_name?: string;
  left_span_start?: number;
  left_span_end?: number;
  right_span_start?: number;
  right_span_end?: number;
  left_entity_type: string;
  right_entity_type: string;
  left_entity_id: string;
  right_entity_id: string;
  allowed_relation_types: string[];
}

export interface CandidatePairRules {
  max_pairs_per_chunk?: number;
  same_chunk_only?: boolean;
  /** Maximum chars between the earlier mention's end and later mention's start. */
  max_pair_span_distance_chars?: number;
}

type OntologyRelation = ResolvedRelationshipOntology['relations'][number];

function pairId(leftEntityId: string, rightEntityId: string): string {
  return `${leftEntityId.length}:${leftEntityId}|${rightEntityId.length}:${rightEntityId}`;
}

function relationKey(leftEntityType: string, rightEntityType: string): string {
  return `${leftEntityType}\u0000${rightEntityType}`;
}

function buildRelationIndex(
  ontology: ResolvedRelationshipOntology
): Map<string, OntologyRelation[]> {
  const index = new Map<string, OntologyRelation[]>();
  const add = (left: string, right: string, relation: OntologyRelation): void => {
    const key = relationKey(left, right);
    const relations = index.get(key) ?? [];
    relations.push(relation);
    index.set(key, relations);
  };
  for (const relation of ontology.relations) {
    add(relation.left_entity, relation.right_entity, relation);
    if (relation.direction === 'symmetric') {
      add(relation.right_entity, relation.left_entity, relation);
    }
  }
  return index;
}

function exceedsSpanDistanceCap(
  a: ResolvedChunkMention,
  b: ResolvedChunkMention,
  maxDistance: number | undefined
): boolean {
  if (maxDistance === undefined) return false;
  if (
    a.span_start === undefined ||
    a.span_end === undefined ||
    b.span_start === undefined ||
    b.span_end === undefined
  ) {
    return false;
  }
  const gap = Math.max(0, Math.max(a.span_start, b.span_start) - Math.min(a.span_end, b.span_end));
  return gap > maxDistance;
}

export function buildCandidatePairs(
  mentions: readonly ResolvedChunkMention[],
  ontology: ResolvedRelationshipOntology,
  rules: CandidatePairRules = {}
): RelationshipCandidatePair[] {
  const maxPairs = rules.max_pairs_per_chunk ?? 8;
  const resolved = mentions.filter((mention) => mention.resolved_entity_id);
  const out: RelationshipCandidatePair[] = [];
  const seen = new Set<string>();
  const pairsById = new Map<string, RelationshipCandidatePair>();
  const relationsByEntityPair = buildRelationIndex(ontology);

  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      const aId = a.resolved_entity_id!;
      const bId = b.resolved_entity_id!;
      if (aId === bId) continue;
      if (rules.same_chunk_only && a.chunk_id !== b.chunk_id) continue;
      if (exceedsSpanDistanceCap(a, b, rules.max_pair_span_distance_chars)) continue;

      const matchingRelations =
        relationsByEntityPair.get(relationKey(a.entity_type, b.entity_type)) ?? [];
      for (const relation of matchingRelations) {
        let left = a;
        let right = b;
        let leftId = aId;
        let rightId = bId;
        if (relation.direction === 'symmetric' && leftId > rightId) {
          left = b;
          right = a;
          leftId = bId;
          rightId = aId;
        } else if (
          relation.direction === 'directed' &&
          relation.left_entity === b.entity_type &&
          relation.right_entity === a.entity_type
        ) {
          left = b;
          right = a;
          leftId = bId;
          rightId = aId;
        }

        const key = `${pairId(leftId, rightId)}\u0000${relation.relation_type}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const candidatePairId = pairId(leftId, rightId);
        const existing = pairsById.get(candidatePairId);
        if (existing) {
          existing.allowed_relation_types.push(relation.relation_type);
        } else {
          const candidatePair: RelationshipCandidatePair = {
            pair_id: candidatePairId,
            left_mention_id: left.mention_id,
            right_mention_id: right.mention_id,
            ...(left.entity_name ? { left_entity_name: left.entity_name } : {}),
            ...(right.entity_name ? { right_entity_name: right.entity_name } : {}),
            ...(left.span_start !== undefined ? { left_span_start: left.span_start } : {}),
            ...(left.span_end !== undefined ? { left_span_end: left.span_end } : {}),
            ...(right.span_start !== undefined ? { right_span_start: right.span_start } : {}),
            ...(right.span_end !== undefined ? { right_span_end: right.span_end } : {}),
            left_entity_type: left.entity_type,
            right_entity_type: right.entity_type,
            left_entity_id: leftId,
            right_entity_id: rightId,
            allowed_relation_types: [relation.relation_type],
          };
          out.push(candidatePair);
          pairsById.set(candidatePairId, candidatePair);
        }

        if (out.length >= maxPairs) {
          return out;
        }
      }
    }
  }

  return out;
}
