import type { SqlStatement } from '../identity/types.js';

export interface ResolvedSurvivorshipAttributeRule {
  attribute: string;
  strategy:
    | 'source_priority'
    | 'recency'
    | 'most_common'
    | 'most_complete'
    | 'value_priority'
    | 'pinned_value';
  sourceOrder: string[];
  timestampField?: string;
  fallback?: string;
  valuePriority: string[];
  pinnedValue?: string;
}

export interface ResolvedEntityIdPolicy {
  strategy: 'stable_uuid' | 'min_source_id';
}

export interface ResolvedSurvivorshipSpec {
  name: string;
  entity: string;
  description: string;
  resolutionRef: string;
  resolutionEntity: string;
  entityIdPolicy: ResolvedEntityIdPolicy;
  attributeRules: ResolvedSurvivorshipAttributeRule[];
  targetSchema: string;
  defaultRecencyMode: boolean;
}

export interface SurvivorshipCompileResult {
  ok: true;
  name: string;
  entity: string;
  schema: string;
  statements: SqlStatement[];
  warnings: string[];
}
