import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDag,
  buildModelRegistry,
  buildSourceRegistry,
  collectYamlFiles,
  compileAll,
  validateAll,
} from '../../../src/compiler/index.js';
import { loadMetadataRegistry, validateMetadataReferences } from '../../../src/entities/index.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';

// Source of truth lives in src/types/bobsled-inc-models.d.ts; keep these in sync for test-only imports.
interface ModelPackageSummary {
  name: string;
}

interface ModelPackageMartSpec {
  name: string;
}

interface ModelPackagePreview {
  martSpecs: ModelPackageMartSpec[];
  metricSpecs: ModelPackageMartSpec[];
  relationshipSpecs: ModelPackageMartSpec[];
}

interface InstallModelPackageOptions {
  cwd: string;
  rawSchema: string;
}

interface InstallModelPackageResult {
  packageName: string;
  sourceCount: number;
  stagingCount: number;
  martCount: number;
  metricCount: number;
  relationshipCount: number;
  writtenFiles: string[];
}

interface ModelPackagesApi {
  clearModelPackageCache(): void;
  getModelPackage(name: string): ModelPackagePreview;
  installModelPackage(name: string, options: InstallModelPackageOptions): InstallModelPackageResult;
  listModelPackages(): ModelPackageSummary[];
}

const DIALECTS: SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'postgres',
  'databricks',
  'mysql',
  'duckdb',
];

const tempDirs: string[] = [];
let modelPackagesApi: ModelPackagesApi | null = null;

function isModelPackagesApi(module: unknown): module is ModelPackagesApi {
  if (module == null || typeof module !== 'object') {
    return false;
  }

  const candidate = module as {
    clearModelPackageCache?: unknown;
    getModelPackage?: unknown;
    installModelPackage?: unknown;
    listModelPackages?: unknown;
  };

  return (
    typeof candidate.clearModelPackageCache === 'function' &&
    typeof candidate.getModelPackage === 'function' &&
    typeof candidate.installModelPackage === 'function' &&
    typeof candidate.listModelPackages === 'function'
  );
}

try {
  const importedModule = await import('@bobsled-inc/models');
  modelPackagesApi = isModelPackagesApi(importedModule) ? importedModule : null;
} catch {
  modelPackagesApi = null;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!modelPackagesApi)('prebuilt model packages', () => {
  it('exposes the requested integrations', () => {
    expect(modelPackagesApi!.listModelPackages().map((entry) => entry.name)).toEqual([
      'asana',
      'chargebee',
      'freshdesk',
      'github',
      'gong',
      'hubspot',
      'intercom',
      'jira',
      'klaviyo',
      'langsmith',
      'linear',
      'notion',
      'pipedrive',
      'pylon',
      'quickbooks',
      'salesforce',
      'shopify',
      'slack',
      'smartlead',
      'stripe',
      'vantage',
      'vercel',
      'zendesk',
    ]);
  });

  it('installs and compiles each package across all supported dialects', async () => {
    const packages = modelPackagesApi!.listModelPackages();
    expect(packages.length).toBeGreaterThan(0);

    for (const modelPackage of packages) {
      const preview = modelPackagesApi!.getModelPackage(modelPackage.name);
      expect(preview.martSpecs.length).toBeGreaterThan(0);
      expect(preview.metricSpecs.length, `${modelPackage.name} metrics`).toBeGreaterThan(0);
      expect(
        preview.relationshipSpecs.length,
        `${modelPackage.name} relationships`
      ).toBeGreaterThan(0);

      const cwd = mkdtempSync(join(tmpdir(), `model-spec-${modelPackage.name}-`));
      tempDirs.push(cwd);

      modelPackagesApi!.installModelPackage(modelPackage.name, { cwd, rawSchema: 'raw' });

      const registryResult = buildSourceRegistry(join(cwd, 'sources'));
      expect(registryResult.ok).toBe(true);
      if (!registryResult.ok) continue;

      const dagResult = buildDag(collectYamlFiles(join(cwd, 'models')));
      expect(dagResult.ok).toBe(true);
      if (!dagResult.ok) continue;

      const metadata = await loadMetadataRegistry(cwd, {
        metricsDir: 'metrics',
        relationshipsDir: 'relationships',
        vqsDir: 'vqs',
      });
      expect(metadata.metrics.size).toBe(preview.metricSpecs.length);
      expect(metadata.relationships.size).toBe(preview.relationshipSpecs.length);
      expect(() =>
        validateMetadataReferences(metadata, {
          modelNames: new Set(dagResult.order.map((node) => node.name)),
          sourceKeys: new Set(registryResult.registry.keys()),
          integrationHandles: new Set(),
        })
      ).not.toThrow();

      for (const dialect of DIALECTS) {
        const modelNames = dagResult.order.map((node) => node.name);
        const modelRegistry = buildModelRegistry(modelNames, 'analytics', dialect);

        const validationResults = validateAll(
          dagResult.order,
          registryResult.registry,
          modelRegistry,
          {
            dialect,
            strict: true,
          }
        );
        const validationErrors = validationResults.flatMap((result) =>
          result.errors.map((error) => `${result.name}: ${error}`)
        );
        expect(validationErrors).toEqual([]);

        const compileResults = compileAll(dagResult.order, registryResult.registry, modelRegistry, {
          dialect,
          targetSchema: 'analytics',
          strict: true,
        });
        const compileErrors = compileResults
          .filter((result) => !result.ok)
          .map(
            (result) => `${result.modelName}: ${'error' in result ? result.error : 'unknown error'}`
          );
        expect(compileErrors).toEqual([]);
      }
    }
  }, 90_000);
});
