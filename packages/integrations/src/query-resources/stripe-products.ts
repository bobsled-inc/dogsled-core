import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
  type MongoGteFilter,
} from './make-query-source.js';

export interface StripeProductMetadata {
  [key: string]: string;
}

export interface StripeProduct {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  active?: boolean | null;
  default_price?: string | null;
  type?: string | null;
  url?: string | null;
  images?: string[] | null;
  metadata?: StripeProductMetadata | null;
  tax_code?: string | null;
  created?: number | null;
  updated?: number | null;
}

export interface StripeProductsInput {
  limit?: number;
}

export interface StripeProductsFilter {
  active?: MongoEqFilter<boolean>;
  created?: MongoGteFilter<number>;
}

export const products = makeQuerySource<StripeProduct, StripeProductsInput, StripeProductsFilter>(
  'stripe',
  'products',
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
);
