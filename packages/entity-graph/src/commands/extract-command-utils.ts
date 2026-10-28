import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';
import { loadProjectConfig, resolveConfig } from '@bobsled-inc/model-spec/shared';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';
import type { z } from 'zod';

import { discoverSpecsOfType } from '../compiler/parse-utils.js';

export interface ExtractCommandSpecRef {
  name: string;
  path: string;
}

export interface AiCommandErrorPayload {
  kind: 'schema_violation' | 'budget_exceeded' | 'provider_error';
  budget_remaining?: number;
  provider_id?: string;
}

export interface ExtractCommandResult {
  ok: true;
  command: string;
  entity: string;
  schema: string;
  dry_run: boolean;
  executed: boolean;
  spec_count: number;
  specs: ExtractCommandSpecRef[];
  chunks_processed: number;
  count: number;
  by_resolution_method: Record<string, number>;
  budget_used: number;
  diagnostics?: unknown;
}

export type AiRuntimeFailure = {
  error: 'schema_violation' | 'budget_exceeded' | 'provider_error';
  message?: string;
  budget_remaining?: number;
  provider_id?: string;
};

export function isAiFailure(value: unknown): value is { ok: false } & AiRuntimeFailure {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === false &&
    ['schema_violation', 'budget_exceeded', 'provider_error'].includes(
      String((value as { error?: unknown }).error)
    )
  );
}

export function normalizeAiRuntimeFailure(error: AiRuntimeFailure): CommandError {
  const payload: AiCommandErrorPayload = {
    kind: error.error,
    ...(error.budget_remaining !== undefined ? { budget_remaining: error.budget_remaining } : {}),
    ...(error.provider_id !== undefined ? { provider_id: error.provider_id } : {}),
  };
  const exitCode = error.error === 'schema_violation' ? 2 : 1;
  return new CommandError(
    error.message ?? `AI extraction failed: ${error.error}`,
    exitCode,
    payload
  );
}

export function resolveExtractionSpecDir(options: {
  cwd?: string;
  specDir?: string;
  integration?: string;
}): string {
  if (options.specDir && options.integration) {
    throw new CommandError('--integration and --spec-dir are mutually exclusive.', 2);
  }
  const cwd = options.cwd ?? process.cwd();
  if (options.specDir) return path.resolve(cwd, options.specDir);
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  return path.join(cwd, resolved.entityGraphDir);
}

export function discoverTypedSpecs<T extends { name: string }>(
  specDir: string,
  typeTag: string,
  schema: z.ZodType<T>
): Array<T & { filePath: string }> {
  return discoverSpecsOfType(
    specDir,
    typeTag,
    (filePath, raw) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new CommandError(
          formatSpecValidationMessage(typeTag, filePath, parsed.error, { schema }),
          2
        );
      }
      return { ...parsed.data, filePath };
    },
    {
      label: typeTag,
      makeError: (message) => new CommandError(message, 2),
    }
  );
}

export function loadOneYamlSpec<T>(filePath: string, schema: z.ZodType<T>, label: string): T {
  const raw = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage(label, filePath, parsed.error, { schema }),
      2
    );
  }
  return parsed.data;
}

export function renderExtractHuman(result: ExtractCommandResult): string {
  if (result.dry_run) {
    return [
      `${result.command}: dry run for ${result.entity}`,
      `schema: ${result.schema}`,
      `specs: ${result.specs.map((spec) => spec.name).join(', ') || '(none)'}`,
    ].join('\n');
  }
  return `${result.command}: extracted ${result.count} row(s) for ${result.entity}.`;
}
