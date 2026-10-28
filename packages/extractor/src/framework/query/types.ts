import type { QUERY_OPERATORS } from '../extractor/query-spec.js';

export type QueryPredicateOperator = (typeof QUERY_OPERATORS)[number];

export type QueryPredicateValue = string | number | boolean | Array<string | number | boolean>;

export interface QueryPredicate {
  field: string;
  operator: QueryPredicateOperator;
  value: QueryPredicateValue;
}

export interface FilterBuilderConfig {
  argument?: string;
  field_map?: Record<string, string>;
  field_types?: Record<string, string>;
  operator_map?: Record<string, string>;
  base?: unknown;
  [key: string]: unknown;
}

export interface FilterBuilderMetadata {
  id: string;
  label: string;
  description: string;
  integrations: string[];
}

export type FilterBuilderOutput = Record<string, unknown>;

export interface FilterBuilder extends FilterBuilderMetadata {
  build(config: FilterBuilderConfig, predicates: QueryPredicate[]): FilterBuilderOutput;
}

export class QueryBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryBuilderError';
  }
}
