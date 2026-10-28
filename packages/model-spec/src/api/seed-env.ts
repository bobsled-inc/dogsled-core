/**
 * Shared seed environment helpers for the seed orchestrators
 * (`seed-project.ts` and `seed-diff.ts`).
 */

import * as fs from 'node:fs';
import { resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';

import type { SupportedDialect } from '../compiler/index.js';
import { readCsv } from '../compiler/seed/csv-reader.js';
import type { ParsedSeedSpec } from '../compiler/seed/parser.js';
import { validateSeedData } from '../compiler/seed/validation.js';
import { loadProjectConfig, resolveConfig } from '../config.js';
import { CommandError } from '../errors.js';
import { discoverProjectSeeds } from './project-seeds.js';

import type { DiscoveredBareSeedCsv } from './project-seeds.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface ResolvedSeedEnv {
  projectRoot: string;
  dialect: SupportedDialect;
  schema: string;
  specs: ReadonlyMap<string, ParsedSeedSpec>;
  bareCsvFiles: readonly DiscoveredBareSeedCsv[];
}

export function resolveSeedEnv(
  cwd: string,
  opts: { dialect?: SupportedDialect; schema?: string; seedsDir?: string; index?: ProjectIndex }
): ResolvedSeedEnv {
  const index = resolveProjectIndex(cwd, opts.index);
  const projectRoot = fs.realpathSync(cwd);
  const { config } = loadProjectConfig(cwd, { index });
  const configuredSeedsDir = opts.seedsDir ?? config?.seeds_dir;
  const resolved = resolveConfig(
    {
      dialect: opts.dialect,
      schema: opts.schema,
      ...(configuredSeedsDir ? { seedsDir: configuredSeedsDir } : {}),
    },
    config
  );
  const discovery = discoverProjectSeeds(cwd, {
    index,
    ...(configuredSeedsDir ? { seedsDir: resolved.seedsDir } : {}),
  });
  return {
    projectRoot,
    dialect: resolved.dialect,
    schema: resolved.schema,
    specs: discovery.specs,
    bareCsvFiles: discovery.bareCsvFiles,
  };
}

export function readSeedCsv(parsed: ParsedSeedSpec) {
  if (parsed.csvError) throw new Error(parsed.csvError);
  const csvContent = parsed.csvContent ?? fs.readFileSync(parsed.csvPath, 'utf-8');
  const expectedColumns = parsed.spec.schema.columns.map((c) => c.name);
  const csvData = readCsv(csvContent, {
    delimiter: parsed.spec.payload.delimiter,
    maxRows: parsed.spec.validation?.max_rows,
    expectedColumns,
  });
  const validation = validateSeedData(parsed, csvData);
  if (validation.issues.length > 0) {
    throw new CommandError(validation.issues.map((issue) => issue.message).join(' '), 2);
  }
  return { csvData, expectedColumns };
}
