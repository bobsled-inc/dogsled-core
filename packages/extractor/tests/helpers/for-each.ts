import type { ResourceSpec } from '../../src/types/index.js';

export function withForEach(
  resource: ResourceSpec,
  forEach: NonNullable<ResourceSpec['extract']['for_each']>
): ResourceSpec {
  return { ...resource, extract: { ...resource.extract, for_each: forEach } };
}
