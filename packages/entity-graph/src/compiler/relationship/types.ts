import type {
  EntityRelationshipConfidenceScoring,
  EntityRelationshipJoinColumnPair,
  EntityRelationshipReview,
  JoinType,
  RelationshipType,
} from '@bobsled-inc/model-spec';

import type { SqlStatement } from '../identity/types.js';

export interface ParsedEntityRelationshipSpec {
  name: string;
  filePath: string;
  raw: import('@bobsled-inc/model-spec').EntityRelationshipSpec;
}

export interface ResolvedEntityRelationshipSpec {
  name: string;
  description?: string;
  leftEntity: string;
  rightEntity: string;
  joinColumns: EntityRelationshipJoinColumnPair[];
  joinType: JoinType;
  relationshipType: RelationshipType;
  confidenceScoring?: EntityRelationshipConfidenceScoring;
  review: EntityRelationshipReview;
  tags?: string[];
  targetSchema?: string;
}

export interface RelationshipCompileOptions {
  targetSchema: string;
  namespace: string;
}

export interface RelationshipCompileResult {
  statements: SqlStatement[];
  warnings: string[];
}
