import { CommandError } from '@bobsled-inc/protocol';

import type { ResolvedRelationshipOntology } from './types.js';

export interface RelationshipOntologyValidationResult {
  ok: true;
  ontologyCount: number;
}

interface RelationshipOntologyEndpointError {
  ontology: string;
  relation_type: string;
  side: 'left_entity' | 'right_entity';
  entity_type: string;
  message: string;
}

export function validateRelationshipOntologyEndpoints(
  ontologies: readonly ResolvedRelationshipOntology[],
  knownEntityTypes: ReadonlySet<string>
): RelationshipOntologyValidationResult {
  const errors: RelationshipOntologyEndpointError[] = [];

  for (const ontology of ontologies) {
    for (const relation of ontology.relations) {
      if (!knownEntityTypes.has(relation.left_entity)) {
        errors.push({
          ontology: ontology.name,
          relation_type: relation.relation_type,
          side: 'left_entity',
          entity_type: relation.left_entity,
          message:
            `ontology '${ontology.name}' relation '${relation.relation_type}' references ` +
            `unknown left_entity '${relation.left_entity}'`,
        });
      }
      if (!knownEntityTypes.has(relation.right_entity)) {
        errors.push({
          ontology: ontology.name,
          relation_type: relation.relation_type,
          side: 'right_entity',
          entity_type: relation.right_entity,
          message:
            `ontology '${ontology.name}' relation '${relation.relation_type}' references ` +
            `unknown right_entity '${relation.right_entity}'`,
        });
      }
    }
  }

  if (errors.length > 0) {
    throw new CommandError(
      `Invalid relationship ontology endpoints:\n${errors.map((error) => error.message).join('\n')}`,
      2,
      {
        kind: 'relationship_ontology_endpoint_validation',
        errors,
      }
    );
  }

  return { ok: true, ontologyCount: ontologies.length };
}
