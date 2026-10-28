import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
  type MongoGteFilter,
} from './make-query-source.js';

export type StripePriceType = 'one_time' | 'recurring';

export interface StripePrice {
  id?: string | null;
  product?: string | null;
  active?: boolean | null;
  currency?: string | null;
  unit_amount?: number | null;
  type?: StripePriceType | null;
  billing_scheme?: string | null;
  recurring_interval?: string | null;
  recurring_interval_count?: number | null;
  recurring_usage_type?: string | null;
  tax_behavior?: string | null;
  created?: number | null;
}

export interface StripePricesInput {
  limit?: number;
}

export interface StripePricesFilter {
  active?: MongoEqFilter<boolean>;
  created?: MongoGteFilter<number>;
  product?: MongoEqFilter<string>;
  type?: MongoEqFilter<StripePriceType>;
}

export const prices = makeQuerySource<StripePrice, StripePricesInput, StripePricesFilter>(
  'stripe',
  'prices',
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
);
