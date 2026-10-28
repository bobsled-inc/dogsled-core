import type { LookupOnlyApiResourceSpec, ResourceSpec } from './resource.js';

/** True when a Resource supports lookup but cannot run as an extraction job. */
export function isLookupOnlyApiResource(
  resource: ResourceSpec
): resource is LookupOnlyApiResourceSpec {
  return (
    'lookup' in resource &&
    resource.lookup !== undefined &&
    (!('extract' in resource) || resource.extract === undefined)
  );
}

export interface ResourceCapabilities {
  extract: boolean;
  lookup: boolean;
  query: boolean;
}

/** Return the operations that callers may run for a parsed Resource. */
export function getResourceCapabilities(resource: ResourceSpec): ResourceCapabilities {
  return {
    extract: !isLookupOnlyApiResource(resource),
    lookup: 'lookup' in resource && resource.lookup !== undefined,
    query: 'query' in resource && resource.query !== undefined,
  };
}
