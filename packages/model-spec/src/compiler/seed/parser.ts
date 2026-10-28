/**
 * Seed spec parser — parse YAML seed specs and build a seed registry.
 *
 * Validates specs against SeedSpecSchema, resolves CSV paths
 * relative to the YAML file location, and verifies CSV file existence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';

import { SeedSpecSchema } from '../schemas.js';
import { collectYamlFiles } from '../dag.js';

import type { SeedSpec } from '../schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSeedSpec {
  name: string;
  spec: SeedSpec;
  filePath: string;
  csvPath: string;
  /** Content read through the Project-bounded seed discovery helper. */
  csvContent?: string;
  csvError?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a single seed spec file.
 *
 * Resolves the CSV path relative to the YAML file location.
 * Throws on invalid spec or missing CSV file.
 */
export function parseSeedSpec(filePath: string): ParsedSeedSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw: unknown = YAML.parse(content);

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid YAML in ${filePath}`);
  }

  // Check type field to filter non-seed specs
  const rawObj = raw as Record<string, unknown>;
  if (rawObj.type !== 'seed') {
    throw new Error(`${filePath} is not a seed spec (type: ${String(rawObj.type)})`);
  }

  const parsed = SeedSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('seed', filePath, parsed.error, {
        schema: SeedSpecSchema,
      })
    );
  }

  const spec = parsed.data;
  const yamlDir = path.dirname(filePath);
  const csvPath = path.resolve(yamlDir, spec.payload.path);

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath} (referenced from ${filePath})`);
  }

  return {
    name: spec.name,
    spec,
    filePath,
    csvPath,
  };
}

/**
 * Scan a directory for seed spec YAML files and build a registry.
 *
 * Returns a Map<name, ParsedSeedSpec> of all valid seed specs.
 * Throws on the first invalid spec encountered.
 */
export function buildSeedRegistry(seedsDir: string): Map<string, ParsedSeedSpec> {
  const registry = new Map<string, ParsedSeedSpec>();

  if (!fs.existsSync(seedsDir)) {
    return registry;
  }

  const yamlFiles = collectYamlFiles(seedsDir);

  for (const filePath of yamlFiles) {
    // Skip non-seed specs silently
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw: unknown = YAML.parse(content);
      if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).type !== 'seed') {
        continue;
      }
    } catch {
      continue;
    }

    const parsed = parseSeedSpec(filePath);

    if (registry.has(parsed.name)) {
      throw new Error(
        `Duplicate seed name "${parsed.name}" in ${parsed.filePath} and ${registry.get(parsed.name)!.filePath}`
      );
    }

    registry.set(parsed.name, parsed);
  }

  return registry;
}
