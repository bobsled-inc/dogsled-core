import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import YAML from 'yaml';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';

import { PolicySpecSchema } from './schema.js';
import type { PolicySpec } from './schema.js';

const MAX_POLICY_SPEC_SIZE = 512 * 1024;

export interface PolicyParseResult {
  spec: PolicySpec;
  filePath: string;
}

export interface PolicyParseError {
  filePath: string;
  message: string;
}

function parsePolicyFile(filePath: string): PolicySpec {
  if (!existsSync(filePath)) {
    throw new CommandError(`Policy file not found: ${filePath}`, 2);
  }
  const stats = statSync(filePath);
  if (stats.size > MAX_POLICY_SPEC_SIZE) {
    throw new CommandError(`Policy file ${filePath} exceeds 512 KB limit`, 2);
  }

  const raw = YAML.parse(readFileSync(filePath, 'utf-8')) as unknown;
  const parsed = PolicySpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('policy', filePath, parsed.error, {
        schema: PolicySpecSchema,
      }),
      2
    );
  }
  return parsed.data;
}

/** Discover all *.policy.yml files in a spec directory. */
export function discoverPolicyFiles(specDir: string): string[] {
  if (!existsSync(specDir)) return [];

  return readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.policy.yml'))
    .map((entry) => join(specDir, entry.name))
    .sort();
}

/** Load the single policy file found in specDir, or null if none exists. */
export function loadPolicySpec(specDir: string): PolicyParseResult | null {
  const files = discoverPolicyFiles(specDir);
  if (files.length === 0) return null;

  if (files.length > 1) {
    throw new CommandError(
      `Multiple *.policy.yml files found in ${specDir}: ${files.join(', ')}. ` +
        'Use --policy-file <path> to select one explicitly.',
      2
    );
  }

  const filePath = files[0];
  if (!filePath) return null;

  const spec = parsePolicyFile(filePath);
  return { spec, filePath };
}

/** Load a policy spec from an explicit file path. */
export function loadPolicySpecFromFile(filePath: string): PolicySpec {
  return parsePolicyFile(resolve(filePath));
}

/** Validate all policy files in specDir, returning errors for each invalid file. */
export function validatePolicyFiles(specDir: string): {
  valid: PolicyParseResult[];
  errors: PolicyParseError[];
} {
  const files = discoverPolicyFiles(specDir);
  const valid: PolicyParseResult[] = [];
  const errors: PolicyParseError[] = [];

  for (const filePath of files) {
    try {
      const spec = parsePolicyFile(filePath);
      valid.push({ spec, filePath });
    } catch (error) {
      errors.push({
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { valid, errors };
}
