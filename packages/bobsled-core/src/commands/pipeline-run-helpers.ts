import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { InvalidArgumentError } from 'commander';

import {
  CommandError,
  EXIT_VALIDATION,
  declaredHostEnvironmentNames,
  withDeclaredAuthEnvVars,
} from '@bobsled-inc/protocol';
import { EmbedderConfigSchema } from '@bobsled-inc/embedder/schema';

import type { EmbedConfig, NamedDestination } from '../runner/config/schema.js';
import type { PipelineOptions } from './pipeline.js';
import { NamedDestinationSchema } from '../runner/config/schema.js';

export function getRuntimeCwd(dependencies: { cwd?: string }): string {
  return dependencies.cwd ?? process.cwd();
}

export function getRuntimeEnv(dependencies: { env?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return { ...process.env, ...dependencies.env };
}

export function collectInput(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseDestinationsJson(value: string): NamedDestination[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new InvalidArgumentError(
      `Invalid --destinations-json payload: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result = NamedDestinationSchema.array().safeParse(parsed);
  if (!result.success) {
    throw new InvalidArgumentError(
      `Invalid --destinations-json payload: ${result.error.issues.map((issue) => issue.message).join('; ')}`
    );
  }

  return result.data;
}

export function getDestinations(options: PipelineOptions): NamedDestination[] | undefined {
  if (options.destinations) {
    return options.destinations;
  }
  if (options.destinationsJson) {
    return parseDestinationsJson(options.destinationsJson);
  }
  return undefined;
}

function parseEmbedConfigJson(
  value: string,
  declaredEnvNames: readonly string[] = []
): EmbedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CommandError(
      `Invalid --embed-config-json payload: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_VALIDATION
    );
  }

  const result = EmbedderConfigSchema.safeParse(withDeclaredAuthEnvVars(parsed, declaredEnvNames));
  if (!result.success) {
    throw new CommandError(
      `Invalid --embed-config-json payload: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
      EXIT_VALIDATION
    );
  }

  return result.data;
}

export function getEmbedConfig(options: PipelineOptions): EmbedConfig | undefined {
  if (!options.embedConfigJson) {
    return undefined;
  }

  return parseEmbedConfigJson(options.embedConfigJson);
}

export function buildEmbedArgs(
  embedConfigPath: string,
  options: Pick<PipelineOptions, 'verbose'>
): string[] {
  const args = ['run', '--config', embedConfigPath];

  if (options.verbose) {
    args.push('--verbose');
  }
  // Preserve the structured side channel; presentation belongs to the parent
  // pipeline process so metrics remain available in pretty and quiet modes.
  args.push('--log-format', 'json');

  return args;
}

function createEmbedTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-embed-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeEmbedConfigFile(embedTmpDir: string, embedConfig: EmbedConfig): string {
  const embedConfigPath = path.join(embedTmpDir, 'embed-config.json');
  fs.writeFileSync(embedConfigPath, JSON.stringify(embedConfig), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return embedConfigPath;
}

export function maybeRemoveFile(filePath: string | undefined): void {
  if (!filePath) {
    return;
  }

  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

export function maybeRemoveDir(dirPath: string | undefined): void {
  if (!dirPath) {
    return;
  }

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

export function prepareEmbedConfig(embedConfig: EmbedConfig): {
  configPath: string;
  tmpDir: string;
} {
  const tmpDir = createEmbedTempDir();
  try {
    return {
      configPath: writeEmbedConfigFile(tmpDir, embedConfig),
      tmpDir,
    };
  } catch (error) {
    maybeRemoveDir(tmpDir);
    throw error;
  }
}

export function applyHostEnvironmentDeclarations(
  options: PipelineOptions,
  env: NodeJS.ProcessEnv | undefined
): PipelineOptions {
  const declaredEnvNames = declaredHostEnvironmentNames(options.declaredEnvNames, env);
  const destinations = getDestinations(options)?.map((destination) => ({
    ...destination,
    auth_env_vars: [...(destination.auth_env_vars ?? []), ...declaredEnvNames],
  }));
  return {
    ...options,
    // Stays unset for a CLI run: only a host run carries a declaration list.
    ...(options.declaredEnvNames === undefined ? {} : { declaredEnvNames }),
    ...(destinations ? { destinations } : {}),
    ...(options.embedConfigJson && declaredEnvNames.length
      ? {
          embedConfigJson: JSON.stringify(
            parseEmbedConfigJson(options.embedConfigJson, declaredEnvNames)
          ),
        }
      : {}),
  };
}
