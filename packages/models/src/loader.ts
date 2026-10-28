import { listResourceFiles } from '@bobsled-inc/integrations';
import { CommandError } from '@bobsled-inc/protocol';

import { clearDefinitionsCache, modelPackageDefinitions } from './definitions/index.js';
import { buildModelPackage, getModelPackageDefinition } from './generator.js';

import type { ModelPackage, ModelPackageSummary } from './types.js';

const packageCache = new Map<string, ModelPackage>();
const packageSummaryCache = new Map<string, ModelPackageSummary>();

export function listModelPackages(): ModelPackageSummary[] {
  return modelPackageDefinitions.map((definition) => getModelPackageSummary(definition.name));
}

export function getModelPackage(name: string): ModelPackage {
  if (packageCache.has(name)) {
    return packageCache.get(name)!;
  }

  const definition = getModelPackageDefinition(name);
  const modelPackage = buildModelPackage(definition);
  packageCache.set(name, modelPackage);
  return modelPackage;
}

function getModelPackageSummary(name: string): ModelPackageSummary {
  const cached = packageSummaryCache.get(name);
  if (cached) {
    return cached;
  }

  const definition = getModelPackageDefinition(name);
  const includeResources = definition.includeResources;
  const resourceNames = listResourceFiles(definition.name);
  const includedResourceNames = includeResources
    ? resourceNames.filter((resourceName) => includeResources.includes(resourceName))
    : resourceNames;

  if (includeResources) {
    const availableNames = new Set(resourceNames);
    const missing = includeResources.filter((resourceName) => !availableNames.has(resourceName));
    if (missing.length > 0) {
      throw new CommandError(
        `Model package "${definition.name}" is missing requested resources: ${missing.join(', ')}`,
        2
      );
    }
  }

  if (includedResourceNames.length === 0) {
    throw new CommandError(
      `Model package "${definition.name}" resolved zero resources. Check that the integration has published resource specs.`,
      2
    );
  }

  const resourceCount = includedResourceNames.length;
  const summary = {
    name: definition.name,
    displayName: definition.displayName,
    description: definition.description,
    tags: definition.tags,
    resourceCount,
    stagingCount: resourceCount,
    martCount: definition.marts.length,
    metricCount: definition.metrics.length,
    relationshipCount: definition.relationships.length,
    totalFiles:
      resourceCount * 2 +
      definition.marts.length +
      definition.metrics.length +
      definition.relationships.length,
  } satisfies ModelPackageSummary;

  packageSummaryCache.set(name, summary);
  return summary;
}

export function clearModelPackageCache(): void {
  packageCache.clear();
  packageSummaryCache.clear();
  clearDefinitionsCache();
}
