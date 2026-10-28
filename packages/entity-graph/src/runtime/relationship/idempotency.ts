import { createHash } from 'node:crypto';

import { CommandError } from '@bobsled-inc/protocol';

export interface RelationshipIdempotencyInput {
  document_version_id: string;
  chunk_id: string;
  left_entity_id: string;
  right_entity_id: string;
  relation_type: string;
  ontology_version: string;
  prompt_version: string;
  model_id: string;
}

export function relationshipIdempotencyHash(input: RelationshipIdempotencyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.document_version_id,
        input.chunk_id,
        input.left_entity_id,
        input.right_entity_id,
        input.relation_type,
        input.ontology_version,
        input.prompt_version,
        input.model_id,
      ])
    )
    .digest('hex');
}

export interface RelationshipIdInput {
  left_entity_id: string;
  right_entity_id: string;
  relation_type: string;
}

function assertRelationshipIdPart(name: keyof RelationshipIdInput, value: string): void {
  if (value.includes('|') || value.includes(':')) {
    throw new CommandError(
      `relationship_id ${name} must not contain '|' or ':'; received ${JSON.stringify(value)}.`,
      2
    );
  }
}

export function relationshipId(input: RelationshipIdInput): string {
  assertRelationshipIdPart('left_entity_id', input.left_entity_id);
  assertRelationshipIdPart('right_entity_id', input.right_entity_id);
  assertRelationshipIdPart('relation_type', input.relation_type);
  const encode = (value: string) => `${value.length}:${value}`;
  return [input.left_entity_id, input.right_entity_id, input.relation_type].map(encode).join('|');
}
