/* eslint-disable dogsled/no-console */
/**
 * Generate YAML mart files from TypeScript model package definitions.
 *
 * Usage: npx tsx packages/models/scripts/generate-yaml.ts
 *
 * Outputs:
 *   packages/models/marts/<integration>/package.yml
 *   packages/models/marts/<integration>/<mart_name>.yml
 *   packages/models/marts/<integration>/metrics/<metric_name>.yml
 *   packages/models/marts/<integration>/relationships/<relationship_name>.yml
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { modelPackageDefinitions } from '../src/definitions/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const martsRoot = join(__dirname, '..', 'marts');

for (const pkg of modelPackageDefinitions) {
  const pkgDir = join(martsRoot, pkg.name);
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });

  // Build package.yml with snake_case keys
  const packageManifest: Record<string, unknown> = {
    name: pkg.name,
    display_name: pkg.displayName,
    description: pkg.description,
    tags: pkg.tags,
  };

  if (pkg.connection !== undefined) {
    packageManifest.connection = pkg.connection;
  }

  if (pkg.includeResources !== undefined) {
    packageManifest.include_resources = pkg.includeResources;
  }

  writeFileSync(
    join(pkgDir, 'package.yml'),
    stringify(packageManifest, { lineWidth: 0, minContentWidth: 0 }),
    'utf-8'
  );

  // Write each mart as its own YAML file
  for (const mart of pkg.marts) {
    const filename = `${mart.name}.yml`;
    writeFileSync(
      join(pkgDir, filename),
      stringify(mart, { lineWidth: 0, minContentWidth: 0 }),
      'utf-8'
    );
  }

  const metricsDir = join(pkgDir, 'metrics');
  mkdirSync(metricsDir, { recursive: true });
  for (const metric of pkg.metrics) {
    writeFileSync(
      join(metricsDir, `${metric.name}.yml`),
      stringify(metric, { lineWidth: 0, minContentWidth: 0 }),
      'utf-8'
    );
  }

  const relationshipsDir = join(pkgDir, 'relationships');
  mkdirSync(relationshipsDir, { recursive: true });
  for (const relationship of pkg.relationships) {
    writeFileSync(
      join(relationshipsDir, `${relationship.name}.yml`),
      stringify(relationship, { lineWidth: 0, minContentWidth: 0 }),
      'utf-8'
    );
  }

  console.log(
    `${pkg.name}: package.yml + ${pkg.marts.length} mart(s) + ${pkg.metrics.length} metric(s) + ${pkg.relationships.length} relationship(s)`
  );
}

console.log(`\nGenerated ${modelPackageDefinitions.length} packages in ${martsRoot}`);
