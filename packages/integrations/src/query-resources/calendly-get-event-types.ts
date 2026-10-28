import {
  FILTER_ONLY_QUERY_SOURCE_CAPABILITIES,
  makeQuerySource,
  type MongoEqFilter,
} from './make-query-source.js';

export interface CalendlyEventType {
  uri?: string | null;
  name?: string | null;
  active?: boolean | null;
  slug?: string | null;
  scheduling_url?: string | null;
  duration?: number | null;
  kind?: string | null;
  pooling_type?: string | null;
  type?: string | null;
  color?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  internal_note?: string | null;
  description_plain?: string | null;
  description_html?: string | null;
  profile_type?: string | null;
  profile_name?: string | null;
  profile_owner?: string | null;
  secret?: boolean | null;
  booking_method?: string | null;
  custom_questions?: unknown[] | null;
  deleted_at?: string | null;
  kind_description?: string | null;
  admin_managed?: boolean | null;
}

export interface CalendlyGetEventTypesInput {
  organization?: string;
  user?: string;
  sort?: string;
  page_token?: string;
  count?: number;
}

export interface CalendlyGetEventTypesFilter {
  active?: MongoEqFilter<boolean>;
  admin_managed?: MongoEqFilter<boolean>;
}

export const getEventTypes = makeQuerySource<
  CalendlyEventType,
  CalendlyGetEventTypesInput,
  CalendlyGetEventTypesFilter
>('calendly', 'get_event_types', FILTER_ONLY_QUERY_SOURCE_CAPABILITIES);
