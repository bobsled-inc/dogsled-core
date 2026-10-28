/**
 * Load resolver for V2 three-block resource specs.
 *
 * Resolves a LoaderConfig from a resource's inline `load:` block, the project-level
 * `default_load:` from extractor.yml, or a CLI `--load-file` escape hatch.
 *
 * Precedence:
 *   1. resource.load  (inline on the resource)
 *   2. projectConfig.default_load  (from extractor.yml)
 *   3. CLI --load-file  (operator escape hatch)
 *   4. Error  (no load destination resolvable)
 *
 * Resource-level load replaces project-level completely (no deep-merge).
 */

import * as fs from 'node:fs/promises';

import { CommandError, SCHEMA_BEHAVIORS } from '@bobsled-inc/protocol';
import YAML from 'yaml';
import { z } from 'zod';

import type { LoaderConfig } from '../schemas/config.js';
import {
  resolveIntegration,
  targetToLoaderConfig,
  validateTargetCapability,
} from './target-loader.js';
import { assertYamlFileSize } from './yaml-file-security.js';
import type { TargetFile } from '../schemas/target.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `load:` block on a V2 resource or `default_load:` in
 * extractor.yml. Mirrors `LoadBlockSchema` in `@bobsled-inc/extractor` --
 * kept local because the loader does not depend on the extractor package.
 */
export const LoadBlockSchema = z
  .object({
    integration: z.string().min(1),
    overrides: z
      .object({
        role: z.string().optional(),
        database: z.string().optional(),
        schema: z.string().optional(),
        warehouse: z.string().optional(),
      })
      .strict()
      .optional(),
    defaults: z
      .object({
        load_strategy: z.enum(['append', 'merge', 'full_refresh']).optional(),
        schema_behavior: z.enum(SCHEMA_BEHAVIORS).optional(),
        target_schema_template: z.string().optional(),
        buffer_size: z.coerce.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LoadBlock = z.infer<typeof LoadBlockSchema>;

export interface LoadResolverInput {
  /** The resource's inline load block (from resource.load). */
  resourceLoad?: LoadBlock;
  /** The project-level default_load block (from extractor.yml). */
  defaultLoad?: LoadBlock;
  /** Path to a --load-file YAML (CLI escape hatch). */
  loadFilePath?: string;
  /** Resource name, for error messages. */
  resourceName: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a LoadBlock from a --load-file YAML path.
 * The file contains a bare load block (integration + optional overrides/defaults).
 */
async function loadBlockFromFile(filePath: string): Promise<LoadBlock> {
  await assertYamlFileSize(filePath, 'Load file');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new CommandError(`Load file not found at ${filePath}`, 2);
    }
    throw err;
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new CommandError(
      `Failed to parse load YAML at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }

  const result = LoadBlockSchema.safeParse(doc);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new CommandError(`Invalid load file at ${filePath}: ${issues}`, 2);
  }

  return result.data;
}

/**
 * Convert a LoadBlock into a TargetFile-compatible shape so we can reuse
 * the existing targetToLoaderConfig adapter.
 */
function loadBlockToTargetFile(block: LoadBlock, resourceName: string): TargetFile {
  return {
    spec_version: '1' as const,
    type: 'target' as const,
    name: `__load_${resourceName}`,
    integration: block.integration,
    overrides: block.overrides,
    defaults: block.defaults,
  };
}

/**
 * Resolve a LoaderConfig from a V2 resource spec using the precedence chain:
 * resource.load > default_load > --load-file > error.
 */
export async function resolveLoadFromResource(
  input: LoadResolverInput,
  env: Record<string, string | undefined>,
  projectDir: string
): Promise<LoaderConfig> {
  let loadBlock: LoadBlock | undefined;

  if (input.resourceLoad) {
    loadBlock = input.resourceLoad;
  } else if (input.defaultLoad) {
    loadBlock = input.defaultLoad;
  } else if (input.loadFilePath) {
    loadBlock = await loadBlockFromFile(input.loadFilePath);
  }

  if (!loadBlock) {
    throw new CommandError(
      `No load destination resolvable for resource "${input.resourceName}". ` +
        `Add a load: block on the resource, set default_load in extractor.yml, ` +
        `or pass --load-file.`,
      2
    );
  }

  const targetFile = loadBlockToTargetFile(loadBlock, input.resourceName);
  const integration = await resolveIntegration(projectDir, loadBlock.integration);
  validateTargetCapability(targetFile, integration);

  return targetToLoaderConfig(targetFile, integration, env);
}
