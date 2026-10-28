import { normalizeForEachConfig } from './for-each.js';

import type { ApiResourceSpec, ResourceSpec } from '../types/index.js';

type ForEachConfigInput = ApiResourceSpec['extract']['for_each'];

type OrderableResource = {
  spec: Pick<ResourceSpec, 'extract' | 'name'>;
};

interface ResourceOrderOptions {
  onWarning?: (message: string) => void;
}

function insertByOriginalOrder(queue: string[], name: string, order: Map<string, number>): void {
  const target = order.get(name) ?? Number.MAX_SAFE_INTEGER;
  let index = 0;

  while (index < queue.length) {
    const current = order.get(queue[index]!) ?? Number.MAX_SAFE_INTEGER;
    if (target < current) {
      break;
    }
    index += 1;
  }

  queue.splice(index, 0, name);
}

export function orderResourcesForExtraction<T extends OrderableResource>(
  resources: T[],
  options: ResourceOrderOptions = {}
): T[] {
  const byName = new Map<string, T>(
    resources.map((resource) => [resource.spec.name, resource] as const)
  );
  const order = new Map<string, number>(
    resources.map((resource, index) => [resource.spec.name, index] as const)
  );
  const indegree = new Map<string, number>(
    resources.map((resource) => [resource.spec.name, 0] as const)
  );
  const childrenByParent = new Map<string, string[]>();

  for (const resource of resources) {
    const extract =
      resource.spec.extract && typeof resource.spec.extract === 'object'
        ? (resource.spec.extract as { for_each?: unknown })
        : undefined;
    const parentName = normalizeForEachConfig(extract?.for_each as ForEachConfigInput)?.resource;
    if (!parentName || !byName.has(parentName)) {
      continue;
    }

    indegree.set(resource.spec.name, (indegree.get(resource.spec.name) ?? 0) + 1);
    const children = childrenByParent.get(parentName) ?? [];
    children.push(resource.spec.name);
    childrenByParent.set(parentName, children);
  }

  const ready = resources
    .map((resource) => resource.spec.name)
    .filter((name) => (indegree.get(name) ?? 0) === 0);
  const orderedNames: string[] = [];

  while (ready.length > 0) {
    const nextName = ready.shift()!;
    orderedNames.push(nextName);

    const children = (childrenByParent.get(nextName) ?? []).sort(
      (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)
    );

    for (const childName of children) {
      const remaining = (indegree.get(childName) ?? 0) - 1;
      indegree.set(childName, remaining);
      if (remaining === 0) {
        insertByOriginalOrder(ready, childName, order);
      }
    }
  }

  if (orderedNames.length !== resources.length) {
    const unresolvedNames = resources
      .map((resource) => resource.spec.name)
      .filter((name) => !orderedNames.includes(name));
    options.onWarning?.(
      `Unable to fully order resources by for_each dependency; preserving declared order for: ${unresolvedNames.join(', ')}`
    );
    return resources;
  }

  return orderedNames.map((name) => byName.get(name)!);
}
