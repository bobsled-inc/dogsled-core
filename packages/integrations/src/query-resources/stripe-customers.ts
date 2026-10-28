import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoGteFilter,
} from './make-query-source.js';

export interface StripeCustomer {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
  currency?: string | null;
  balance?: number | null;
  delinquent?: boolean | null;
  default_source?: string | null;
  created?: number | null;
}

export interface StripeCustomersInput {
  limit?: number;
}

export interface StripeCustomersFilter {
  created?: MongoGteFilter<number>;
}

export const customers = makeQuerySource<
  StripeCustomer,
  StripeCustomersInput,
  StripeCustomersFilter
>('stripe', 'customers', FILTER_ONLY_QUERY_SOURCE_CAPABILITIES);
