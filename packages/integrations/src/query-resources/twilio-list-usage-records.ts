import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
  type MongoGteFilter,
  type MongoLteFilter,
} from './make-query-source.js';

export interface TwilioUsageRecord {
  account_sid?: string | null;
  category?: string | null;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  usage?: string | null;
  price?: string | null;
}

export interface TwilioListUsageRecordsInput {
  account_sid: string;
  page_size?: number;
  page?: number;
  include_subaccounts?: boolean;
}

export interface TwilioListUsageRecordsFilter {
  category?: MongoEqFilter<string>;
  start_date?: MongoGteFilter<string>;
  end_date?: MongoLteFilter<string>;
}

export const listUsageRecords = makeQuerySource<
  TwilioUsageRecord,
  TwilioListUsageRecordsInput,
  TwilioListUsageRecordsFilter
>('twilio', 'list_usage_records', FILTER_ONLY_QUERY_SOURCE_CAPABILITIES);
