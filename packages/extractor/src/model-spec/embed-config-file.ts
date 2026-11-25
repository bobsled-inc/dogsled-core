/**
 * Loader for the JSON file the `dogsled pipeline` orchestrator writes when it
 * relays the pipeline's resolved `embed:` block to the extractor subprocess.
 * The file is consumed only by `--emit-model-spec-source` to pre-fill embedding
 * columns in the printed scaffold.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import type { ResolvedResourceEmbedConfig } from './generate-source.js';

const EmbedFieldSchema = z
  .object({
    field: z.string().min(1),
    as: z.string().min(1).optional(),
  })
  .strict();

// Permissive — the same JSON file is also consumed by `dogsled embed`, which
// validates the full discriminated union (provider auth variants, api_key,
// region, base_url, etc.). The scaffold only needs the shared core fields.
const EmbedConfigFileSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    dimension: z.number().int().positive().optional(),
    streams: z.record(z.string(), z.array(EmbedFieldSchema).min(1)),
  })
  .passthrough()
  .refine((config) => config.model !== undefined || config.provider === 'host', {
    path: ['model'],
    message: 'model is required unless the provider is host',
  });

export type EmbedConfigFile = z.infer<typeof EmbedConfigFileSchema>;

export function loadEmbedConfigFile(path: string): EmbedConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Unable to read embed config file ${path}: ${message}`, EXIT_VALIDATION);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      `Embed config file ${path} is not valid JSON: ${message}`,
      EXIT_VALIDATION
    );
  }

  const result = EmbedConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '<root>',
      message: issue.message,
    }));
    throw new CommandError(`Invalid embed config file ${path}.`, EXIT_VALIDATION, {
      valid: false,
      errors,
    });
  }
  return result.data;
}

/**
 * CLI helper — load the embed config file when `--emit-model-spec-source` is set,
 * reject `--embed-config-file` invocations that lack `--emit-model-spec-source`,
 * and return `undefined` otherwise. Keeps the extract command's option
 * wiring compact.
 */
export function resolveEmbedConfigFromOptions(
  emitModelSpecSource: boolean | undefined,
  embedConfigFile: string | undefined
): EmbedConfigFile | undefined {
  if (embedConfigFile && !emitModelSpecSource) {
    throw new CommandError(
      '--embed-config-file requires --emit-model-spec-source.',
      EXIT_VALIDATION,
      {
        valid: false,
        errors: [
          {
            path: '--embed-config-file',
            message:
              '--embed-config-file can only be used together with --emit-model-spec-source — the file is only consumed when emitting the Model Spec source scaffold.',
          },
        ],
      }
    );
  }
  if (!emitModelSpecSource || !embedConfigFile) {
    return undefined;
  }
  return loadEmbedConfigFile(embedConfigFile);
}

export function resolveResourceEmbedConfig(
  config: EmbedConfigFile,
  resourceName: string
): ResolvedResourceEmbedConfig | undefined {
  const fields = config.streams[resourceName];
  if (!fields || fields.length === 0) {
    return undefined;
  }
  // Without an explicit dimension and model we cannot pre-fill VECTOR columns in
  // the scaffold. The embedder still infers dimension at runtime for known models,
  // and asks the host application for both with provider `host`.
  if (config.dimension === undefined || config.model === undefined) {
    return undefined;
  }
  return {
    provider: config.provider,
    model: config.model,
    dimension: config.dimension,
    fields,
  };
}
