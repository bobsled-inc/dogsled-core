import { readFileSync } from 'node:fs';

import type { Readable, Writable } from 'node:stream';

import { Command } from 'commander';
import { z } from 'zod';

import { embedMany, type EmbedInput, type EmbedResult } from '@bobsled-inc/ai';
import { EnvSecretResolver } from '@bobsled-inc/connections';
import {
  CommandError,
  EXIT_ERROR,
  EXIT_VALIDATION,
  parseEnvPlaceholder,
  validateModelProviderConfig,
} from '@bobsled-inc/protocol';

import { EmbedderConfigSchema } from '../config.js';
import {
  buildErrorLogMessage,
  runEmbedder,
  writeStructuredLog,
  type EmbedderLogOptions,
} from '../runtime/processor.js';
import type { EmbedderConfig } from '../config.js';

export interface BuildConfigInputOptions {
  configPath?: string;
  configJson?: string;
}

export interface RunEmbedCommandDependencies {
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  env?: Record<string, string | undefined>;
  logOptions?: EmbedderLogOptions;
}

interface CliOutputFlags {
  json?: boolean;
  logFormat?: string;
  quiet?: boolean;
  verbose?: boolean;
}

function resolveEmbedderLogOptions(options: CliOutputFlags): EmbedderLogOptions {
  const requestedFormat = options.json ? 'json' : (options.logFormat ?? 'json');
  const result = z.enum(['json', 'pretty']).safeParse(requestedFormat);
  if (!result.success) {
    throw new CommandError(
      `Invalid --log-format "${requestedFormat}". Expected one of: json, pretty.`,
      EXIT_VALIDATION
    );
  }

  return {
    logFormat: result.data,
    quiet: options.quiet ?? false,
    verbose: options.verbose ?? false,
  };
}

export function inferEmbedderLogOptions(argv: string[]): EmbedderLogOptions {
  const inferred: CliOutputFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === '--json') {
      inferred.json = true;
      continue;
    }
    if (arg === '--quiet' || arg === '-q') {
      inferred.quiet = true;
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      inferred.verbose = true;
      continue;
    }
    if (arg === '--log-format' && argv[index + 1]) {
      inferred.logFormat = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--log-format=')) {
      inferred.logFormat = arg.slice('--log-format='.length);
    }
  }

  try {
    return resolveEmbedderLogOptions(inferred);
  } catch {
    return {
      logFormat: 'json',
      quiet: inferred.quiet ?? false,
      verbose: inferred.verbose ?? false,
    };
  }
}

function parseConfigJson(raw: string, sourceLabel: string): EmbedderConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      `Invalid embedder config JSON from ${sourceLabel}: ${message}`,
      EXIT_VALIDATION
    );
  }

  const result = EmbedderConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new CommandError(`Invalid embedder config:\n${issues}`, EXIT_VALIDATION);
  }

  return result.data;
}

export function buildEmbedderConfigInput(options: BuildConfigInputOptions): EmbedderConfig {
  const hasConfigPath = typeof options.configPath === 'string';
  const hasConfigJson = typeof options.configJson === 'string';

  if (hasConfigPath === hasConfigJson) {
    throw new CommandError(
      'Exactly one of --config <path> or --config-json <json> is required.',
      EXIT_VALIDATION
    );
  }

  if (options.configPath) {
    let raw: string;
    try {
      raw = readFileSync(options.configPath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandError(
        `Unable to read embedder config at ${options.configPath}: ${message}`,
        EXIT_VALIDATION
      );
    }
    return parseConfigJson(raw, `file "${options.configPath}"`);
  }

  return parseConfigJson(options.configJson!, 'the --config-json flag');
}

export function parseEmbedderConfig(raw: unknown): EmbedderConfig {
  return EmbedderConfigSchema.parse(raw);
}

async function resolveApiKey(
  apiKey: string,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const name = parseEnvPlaceholder(apiKey);
  if (name === null) {
    return apiKey;
  }

  const resolver = new EnvSecretResolver(env);
  return resolver.resolve(name);
}

function defaultDimension(config: EmbedderConfig): number | undefined {
  if (config.dimension !== undefined) {
    return config.dimension;
  }
  if (config.provider === 'amazon-bedrock' && config.model === 'amazon.titan-embed-text-v2:0') {
    return 1024;
  }
  if (config.provider === 'openai' && config.model === 'text-embedding-3-small') {
    return 1536;
  }
  if (config.provider === 'openai' && config.model === 'text-embedding-3-large') {
    return 3072;
  }
  return undefined;
}

async function embedBatch(
  config: EmbedderConfig,
  texts: string[],
  env: Record<string, string | undefined>
): Promise<{ vectors: number[][]; tokensUsed: number }> {
  const inputs: EmbedInput[] = texts.map((text, index) => ({
    id: String(index),
    text,
  }));
  const results: EmbedResult[] = [];
  for await (const result of embedMany(config, inputs, { env })) {
    results.push(result);
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    throw new CommandError(failures.map((failure) => failure.message).join('; '), EXIT_ERROR);
  }

  const vectors = new Array<number[]>(texts.length);
  let tokensUsed = 0;
  for (const result of results) {
    if (!result.ok) {
      continue;
    }
    vectors[Number(result.id)] = result.vector;
    tokensUsed += result.tokenUsage;
  }

  return { vectors, tokensUsed };
}

export async function runEmbedCommand(
  config: EmbedderConfig,
  dependencies: RunEmbedCommandDependencies = {}
): Promise<void> {
  validateModelProviderConfig(config);
  const env = dependencies.env ?? process.env;
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const errorOutput = dependencies.errorOutput ?? process.stderr;
  const dimensions = defaultDimension(config);

  if (dimensions === undefined || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new CommandError(
      `Embedding model "${config.model}" must define a positive dimension`,
      EXIT_VALIDATION
    );
  }

  const resolvedConfig =
    'api_key' in config && typeof config.api_key === 'string'
      ? { ...config, api_key: await resolveApiKey(config.api_key, env) }
      : config;

  const embedFn =
    env['DOGSLED_EMBED_STUB'] === '1'
      ? async (texts: string[]) => ({
          vectors: texts.map(() => Array.from({ length: dimensions }, () => 0)),
          tokensUsed: 0,
        })
      : async (texts: string[]) => {
          return embedBatch(resolvedConfig, texts, env);
        };

  await runEmbedder({
    input,
    output,
    errorOutput,
    config,
    dimensions,
    batchSize: 100,
    embedFn,
    tmpDir: env['DOGSLED_EMBEDDER_TMP_DIR'],
    logOptions: dependencies.logOptions,
  });
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Read protocol messages from stdin and enrich configured fields with embeddings')
    .option('--config <path>', 'Path to an embedder config JSON file')
    .option('--config-json <json>', 'Inline embedder config JSON')
    .option('--json', 'Emit structured JSON logs to stderr')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('--log-format <format>', 'Control log format: json or pretty')
    .action(
      async (opts: {
        config?: string;
        configJson?: string;
        json?: boolean;
        verbose?: boolean;
        quiet?: boolean;
        logFormat?: string;
      }) => {
        const config = buildEmbedderConfigInput({
          configPath: opts.config,
          configJson: opts.configJson,
        });
        await runEmbedCommand(config, {
          logOptions: resolveEmbedderLogOptions(opts),
        });
      }
    );
}

export function handleRunError(
  error: unknown,
  output: Writable = process.stderr,
  logOptions: EmbedderLogOptions = {}
): void {
  if (error instanceof CommandError) {
    writeStructuredLog(output, buildErrorLogMessage(error.message), logOptions);
    process.exitCode = error.exitCode;
    return;
  }

  if (error instanceof z.ZodError) {
    const issueMessage = error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    writeStructuredLog(
      output,
      buildErrorLogMessage(`Invalid embedder config:\n${issueMessage}`),
      logOptions
    );
    process.exitCode = EXIT_VALIDATION;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  writeStructuredLog(output, buildErrorLogMessage(message), logOptions);
  process.exitCode = EXIT_ERROR;
}
