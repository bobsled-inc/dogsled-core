import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
  type MongoGteFilter,
} from './make-query-source.js';

export type StripeInvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

export interface StripeInvoice {
  id?: string | null;
  customer?: string | null;
  subscription?: string | null;
  status?: StripeInvoiceStatus | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  amount_remaining?: number | null;
  currency?: string | null;
  due_date?: number | null;
  paid?: boolean | null;
  attempted?: boolean | null;
  attempt_count?: number | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  number?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  total?: number | null;
  subtotal?: number | null;
  tax?: number | null;
  created?: number | null;
}

export interface StripeInvoicesInput {
  limit?: number;
}

export interface StripeInvoicesFilter {
  created?: MongoGteFilter<number>;
  customer?: MongoEqFilter<string>;
  status?: MongoEqFilter<StripeInvoiceStatus>;
  subscription?: MongoEqFilter<string>;
}

export const invoices = makeQuerySource<StripeInvoice, StripeInvoicesInput, StripeInvoicesFilter>(
  'stripe',
  'invoices',
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
);
