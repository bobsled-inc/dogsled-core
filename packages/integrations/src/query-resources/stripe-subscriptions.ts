import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
  type MongoGteFilter,
} from './make-query-source.js';

export type StripeSubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export type StripeSubscriptionStatusFilter = StripeSubscriptionStatus | 'all';

export interface StripeSubscription {
  id?: string | null;
  customer?: string | null;
  status?: StripeSubscriptionStatus | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  trial_start?: number | null;
  trial_end?: number | null;
  default_payment_method?: string | null;
  latest_invoice?: string | null;
  collection_method?: string | null;
  billing_cycle_anchor?: number | null;
  created?: number | null;
}

export interface StripeSubscriptionsInput {
  limit?: number;
}

export interface StripeSubscriptionsFilter {
  created?: MongoGteFilter<number>;
  customer?: MongoEqFilter<string>;
  status?: MongoEqFilter<StripeSubscriptionStatusFilter>;
}

export const subscriptions = makeQuerySource<
  StripeSubscription,
  StripeSubscriptionsInput,
  StripeSubscriptionsFilter
>('stripe', 'subscriptions', FILTER_ONLY_QUERY_SOURCE_CAPABILITIES);
