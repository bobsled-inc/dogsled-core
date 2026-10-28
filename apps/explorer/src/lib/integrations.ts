import {
  listIntegrations as _listIntegrations,
  getIntegration as _getIntegration,
  getResources as _getResources,
  getResource as _getResource,
  searchIntegrations as _searchIntegrations,
  CATEGORIES,
} from '@bobsled-inc/integrations';

import type {
  IntegrationSummary,
  Integration,
  IntegrationResource,
} from '@bobsled-inc/integrations';

export type { IntegrationSummary, Integration, IntegrationResource };
export { CATEGORIES };

// Cache stays warm between requests — pre-populated at startup via instrumentation.ts.
// To force a refresh after writing YAML, restart the server.

export async function withIntegrationCache<T>(fn: () => Promise<T> | T): Promise<T> {
  return fn();
}

export function listIntegrations(): IntegrationSummary[] {
  return _listIntegrations();
}

export function getIntegration(name: string): Integration {
  return _getIntegration(name);
}

export function getResources(integrationName: string): IntegrationResource[] {
  return _getResources(integrationName);
}

export function getResource(integrationName: string, resourceName: string): IntegrationResource {
  return _getResource(integrationName, resourceName);
}

export function searchIntegrations(query: string): IntegrationSummary[] {
  return _searchIntegrations(query);
}

export const integrationsBatched = {
  list: _listIntegrations,
  get: _getIntegration,
  getResources: _getResources,
  getResource: _getResource,
  search: _searchIntegrations,
} as const;
