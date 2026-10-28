/**
 * Project configuration file support.
 *
 * Loads the optional extractor configuration: a root `extractor.yml`, or a
 * file declaring `type: extractor_config` anywhere in the project.
 */

import { findConfigurationEntry, type ProjectIndex } from '@bobsled-inc/project-index';
import YAML from 'yaml';

import { ExtractorConfigSchema } from './schemas/config.js';
import { normalizeSpec } from './schemas/normalize.js';
import type { ExtractorConfig } from './types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_FILE_NAME = 'extractor.yml';
const MAX_CONFIG_FILE_SIZE = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ExtractorConfig = {
  integrations_dir: 'integrations',
  resources_dir: 'resources',
  state_dir: '.extractor',
  output_dir: 'output',
  batch_dir: 'batch',
  default_batch_format: 'jsonl',
  default_output: 'stdout',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadExtractorConfigOptions {
  /** Prebuilt project index; `cwd` is scanned when omitted. */
  index?: ProjectIndex;
}

/**
 * Load the project's extractor configuration: the file declaring
 * `type: extractor_config`, or an untyped root `extractor.yml`.
 * Returns parsed config or null if the project has none.
 * Throws on invalid config. Problems in other project files are left to the
 * project loaders.
 */
export function loadExtractorConfig(
  cwd: string,
  options: LoadExtractorConfigOptions = {}
): ExtractorConfig | null {
  const entry = findConfigurationEntry(cwd, 'extractor_config', options.index);
  if (!entry) return null;

  const size = Buffer.byteLength(entry.content, 'utf8');
  if (size > MAX_CONFIG_FILE_SIZE) {
    throw new Error(`${entry.path} too large: ${size} bytes (max ${MAX_CONFIG_FILE_SIZE})`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(entry.content);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid YAML';
    throw new Error(`Invalid ${entry.path}: ${message}`);
  }
  if (raw === null || raw === undefined) {
    return null;
  }

  const parsed = ExtractorConfigSchema.safeParse(normalizeSpec(raw).data);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${entry.path}: ${messages}`);
  }

  return parsed.data;
}

/**
 * Resolve effective config: config file > defaults.
 */
export function resolveExtractorConfig(projectConfig: ExtractorConfig | null): ExtractorConfig {
  return { ...DEFAULT_CONFIG, ...projectConfig };
}
