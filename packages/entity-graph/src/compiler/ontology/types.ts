import type {
  RelationshipOntologyRelation,
  RelationshipOntologySpec,
} from '@bobsled-inc/model-spec';

export interface ParsedRelationshipOntologySpec {
  name: string;
  filePath: string;
  raw: RelationshipOntologySpec;
}

export interface ResolvedRelationshipOntology {
  name: string;
  ontologyVersion: string;
  relations: RelationshipOntologyRelation[];
  relationTypes: string[];
  entityTypes: string[];
}
