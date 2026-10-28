import {
  queryResource,
  type QueryFilterInput,
  type QueryResourceResult,
} from '@bobsled-inc/extractor';

import { loadQueryableResourceSpecs } from './catalog.js';

export interface QueryIntegrationResourceInput {
  [key: string]: unknown;
}

export interface QueryIntegrationResourceRecord {
  [key: string]: unknown;
}

export interface QueryIntegrationResourceOptions<
  TFilter = QueryFilterInput,
  TInput = QueryIntegrationResourceInput,
> {
  input?: TInput;
  filter?: TFilter;
  search?: string;
  limit?: number;
}

export async function queryIntegrationResource<
  TRecord = QueryIntegrationResourceRecord,
  TFilter = QueryFilterInput,
  TInput = QueryIntegrationResourceInput,
>(
  integrationName: string,
  resourceName: string,
  opts: QueryIntegrationResourceOptions<TFilter, TInput> = {}
): Promise<QueryResourceResult<TRecord>> {
  const loaded = loadQueryableResourceSpecs(integrationName, resourceName);
  if (!loaded) {
    throw new Error(
      `Resource "${integrationName}.${resourceName}" does not expose a query surface.`
    );
  }

  return queryResource<TRecord>({
    integration: loaded.integration,
    resource: loaded.resource,
    input: opts.input as Record<string, unknown> | undefined,
    filter: opts.filter as QueryFilterInput | undefined,
    search: opts.search,
    limit: opts.limit,
  });
}

export type QuerySourceResourceInput = QueryIntegrationResourceInput;
export type QuerySourceResourceRecord = QueryIntegrationResourceRecord;
export type QuerySourceResourceOptions<
  TFilter = QueryFilterInput,
  TInput = QuerySourceResourceInput,
> = QueryIntegrationResourceOptions<TFilter, TInput>;

export const querySourceResource = queryIntegrationResource;
