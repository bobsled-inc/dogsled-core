import {
  listModelPackages as _listModelPackages,
  getModelPackage as _getModelPackage,
} from '@bobsled-inc/models';

import type { ModelPackage, ModelPackageSummary } from '@bobsled-inc/models';

export type { ModelPackage, ModelPackageSummary };

// Cache stays warm between requests — pre-populated at startup via instrumentation.ts.
// To force a refresh after writing YAML, restart the server.

export async function withModelPackageCache<T>(fn: () => Promise<T> | T): Promise<T> {
  return fn();
}

export function listModelPackages(): ModelPackageSummary[] {
  return _listModelPackages();
}

export function getModelPackage(name: string): ModelPackage {
  return _getModelPackage(name);
}

export const modelPackagesBatched = {
  list: _listModelPackages,
  get: _getModelPackage,
} as const;
