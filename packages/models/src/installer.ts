import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import { buildModelPackage, getModelPackageDefinition } from './generator.js';

import type { InstallModelPackageOptions, InstallModelPackageResult } from './types.js';

export function installModelPackage(
  name: string,
  options: InstallModelPackageOptions = {}
): InstallModelPackageResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const modelPackage = buildModelPackage(getModelPackageDefinition(name), {
    rawSchema: options.rawSchema,
    sourceDir: options.sourceDir,
    modelDir: options.modelDir,
    metricDir: options.metricDir,
    relationshipDir: options.relationshipDir,
  });

  const outputPaths = modelPackage.files.map((file) => resolve(cwd, file.path));
  if (!options.overwrite) {
    const existing = outputPaths.find((filePath) => existsSync(filePath));
    if (existing) {
      throw new CommandError(`Refusing to overwrite existing file: ${existing}`);
    }
  }

  for (let index = 0; index < modelPackage.files.length; index++) {
    const file = modelPackage.files[index]!;
    const outputPath = outputPaths[index]!;
    mkdirSync(join(outputPath, '..'), { recursive: true });
    writeFileSync(outputPath, file.content, 'utf-8');
  }

  return {
    packageName: modelPackage.name,
    writtenFiles: modelPackage.files.map((file) => file.path),
    sourceCount: modelPackage.sourceSpecs.length,
    stagingCount: modelPackage.stagingSpecs.length,
    martCount: modelPackage.martSpecs.length,
    metricCount: modelPackage.metricSpecs.length,
    relationshipCount: modelPackage.relationshipSpecs.length,
  };
}
