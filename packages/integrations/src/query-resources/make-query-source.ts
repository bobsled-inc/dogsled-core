import { type QueryResourceResult, type QueryValue } from '@bobsled-inc/extractor';

import { queryIntegrationResource } from './query-integration-resource.js';

export type MongoEqFilter<TValue extends QueryValue = QueryValue> =
  TValue | { eq?: TValue; $eq?: TValue };

export type MongoContainsFilter<TValue extends QueryValue = QueryValue> =
  TValue | { contains?: TValue; $contains?: TValue };

export type MongoGteFilter<TValue extends QueryValue = QueryValue> =
  TValue | { gte?: TValue; $gte?: TValue };

export type MongoLteFilter<TValue extends QueryValue = QueryValue> =
  TValue | { lte?: TValue; $lte?: TValue };

export interface QuerySourceCapabilities<
  TSupportsFilters extends boolean = boolean,
  TSupportsSearch extends boolean = boolean,
> {
  filters: TSupportsFilters;
  search: TSupportsSearch;
}

export const FILTER_ONLY_QUERY_SOURCE_CAPABILITIES = {
  filters: true,
  search: false,
} as const;

export const SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES = {
  filters: false,
  search: true,
} as const;

export const FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES = {
  filters: true,
  search: true,
} as const;

type QuerySourceInputOptions<TInput> = [TInput] extends [never]
  ? { input?: never }
  : {} extends TInput
    ? { input?: TInput }
    : { input: TInput };

type QuerySourceModeOptions<
  TFilter,
  TCapabilities extends QuerySourceCapabilities<boolean, boolean>,
> = TCapabilities['filters'] extends true
  ? TCapabilities['search'] extends true
    ? // NOTE: `search?: never` only blocks explicit string values (not `search: undefined`).
      // True mutual exclusion requires exactOptionalPropertyTypes: true, which is off project-wide.
      { filter?: TFilter; search?: never } | { search?: string; filter?: never }
    : { filter?: TFilter }
  : TCapabilities['search'] extends true
    ? { search?: string }
    : Record<never, never>;

export type QuerySourceListOptions<
  TInput,
  TFilter,
  TCapabilities extends QuerySourceCapabilities<boolean, boolean>,
> = QuerySourceInputOptions<TInput> &
  QuerySourceModeOptions<TFilter, TCapabilities> & {
    limit?: number;
  };

type QuerySourceListArgs<
  TInput,
  TFilter,
  TCapabilities extends QuerySourceCapabilities<boolean, boolean>,
> =
  {} extends QuerySourceListOptions<TInput, TFilter, TCapabilities>
    ? [opts?: QuerySourceListOptions<TInput, TFilter, TCapabilities>]
    : [opts: QuerySourceListOptions<TInput, TFilter, TCapabilities>];

export interface QuerySource<
  TRecord,
  TInput,
  TFilter,
  TCapabilities extends QuerySourceCapabilities<boolean, boolean>,
> {
  integration: string;
  resource: string;
  list(
    ...args: QuerySourceListArgs<TInput, TFilter, TCapabilities>
  ): Promise<QueryResourceResult<TRecord>>;
}

export function makeQuerySource<TRecord, TInput, TFilter>(
  integrationName: string,
  resourceName: string,
  capabilities: typeof FILTER_ONLY_QUERY_SOURCE_CAPABILITIES
): QuerySource<TRecord, TInput, TFilter, typeof FILTER_ONLY_QUERY_SOURCE_CAPABILITIES>;
export function makeQuerySource<TRecord, TInput>(
  integrationName: string,
  resourceName: string,
  capabilities: typeof SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES
): QuerySource<TRecord, TInput, never, typeof SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES>;
export function makeQuerySource<TRecord, TInput, TFilter>(
  integrationName: string,
  resourceName: string,
  capabilities: typeof FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES
): QuerySource<TRecord, TInput, TFilter, typeof FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES>;
export function makeQuerySource<TRecord, TInput, TFilter>(
  integrationName: string,
  resourceName: string,
  // _capabilities exists only for overload dispatch; it carries no runtime semantics.
  _capabilities: QuerySourceCapabilities<boolean, boolean>
): QuerySource<TRecord, TInput, TFilter, QuerySourceCapabilities<boolean, boolean>> {
  return {
    integration: integrationName,
    resource: resourceName,
    async list(
      ...[opts]: QuerySourceListArgs<TInput, TFilter, QuerySourceCapabilities<boolean, boolean>>
    ): Promise<QueryResourceResult<TRecord>> {
      const hasFilterOption =
        opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'filter');
      const hasSearchOption =
        opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'search');
      if (hasFilterOption && hasSearchOption) {
        throw new Error('Provide either `filter` or `search`, not both.');
      }

      // Cast is safe: overload signatures enforce capability constraints at call sites.
      const normalizedOptions = (opts ?? {}) as QuerySourceListOptions<
        TInput,
        TFilter,
        QuerySourceCapabilities<boolean, boolean>
      >;
      // queryIntegrationResource keeps the legacy <TRecord, TFilter, TInput> order;
      // makeQuerySource exposes the new <TRecord, TInput, TFilter> convention.
      return queryIntegrationResource<TRecord, TFilter, TInput>(
        integrationName,
        resourceName,
        normalizedOptions
      );
    },
  };
}
