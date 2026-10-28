/**
 * `model generate` command — generate Model Spec YAML model specs from existing SQL.
 *
 * Pairs with the existing `compile` command. Currently scoped to Snowflake
 * views; sources must be supplied via `--sources` so the generator can
 * resolve `FROM` and `JOIN` table references.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';
import YAML from 'yaml';

import {
  generateModelSpecFromSql,
  ModelSpecGenerationError,
  type ModelSpecSqlDialect,
} from '../compiler/index.js';
import { SourceSpecSchema, type SourceSpec } from '../compiler/schemas.js';
import { CommandError } from '../errors.js';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';
import * as out from '../output.js';

import { parseGlobalFlags } from './common.js';

interface GenerateOptions {
  fromsql?: string;
  sqldialect?: string;
  output?: string;
  name?: string;
  description?: string;
  sources?: string[];
  defaultConnection?: string;
  ctePrefix?: string;
}

const SUPPORTED_DIALECTS: ReadonlyArray<ModelSpecSqlDialect> = ['snowflake'];

async function generateHandler(
  localOptions: GenerateOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);

  if (!localOptions.fromsql) {
    throw new CommandError(
      '--fromsql <file> is required: pass the path to a SQL file (or `-` for stdin) to generate models from.'
    );
  }

  if (!localOptions.sources || localOptions.sources.length === 0) {
    throw new CommandError(
      '--sources <path>... is required: the generator resolves FROM/JOIN table refs against user-provided source specs.'
    );
  }

  const dialect = (localOptions.sqldialect ?? 'snowflake').toLowerCase();
  if (!SUPPORTED_DIALECTS.includes(dialect as ModelSpecSqlDialect)) {
    throw new CommandError(
      `--sqldialect \`${dialect}\` is not supported. Supported: ${SUPPORTED_DIALECTS.join(', ')}.`,
      2
    );
  }

  const inputFile = localOptions.fromsql;
  const sql = inputFile === '-' ? readStdin() : fs.readFileSync(inputFile, 'utf-8');
  if (!sql.trim()) {
    throw new CommandError('Input SQL is empty.');
  }

  const sources = loadSourceSpecs(localOptions.sources);
  if (!flags.quiet) out.info(`Loaded ${sources.length} source spec(s).`);

  const modelName = localOptions.name ?? deriveModelName(inputFile);

  let result: ReturnType<typeof generateModelSpecFromSql>;
  try {
    const opts: Parameters<typeof generateModelSpecFromSql>[1] = {
      dialect: dialect as ModelSpecSqlDialect,
      sources,
      modelName,
    };
    if (localOptions.description !== undefined) opts.description = localOptions.description;
    if (localOptions.ctePrefix !== undefined) opts.cteNamePrefix = localOptions.ctePrefix;
    if (localOptions.defaultConnection !== undefined) {
      opts.defaultConnection = localOptions.defaultConnection;
    }
    result = generateModelSpecFromSql(sql, opts);
  } catch (err) {
    if (err instanceof ModelSpecGenerationError) {
      throw new CommandError(`[${err.code}] ${err.message}`, 2);
    }
    throw err;
  }

  for (const w of result.warnings) out.warn(w);

  if (localOptions.output) {
    fs.mkdirSync(localOptions.output, { recursive: true });
    for (const model of result.models) {
      const filePath = path.join(localOptions.output, `${model.name}.yml`);
      fs.writeFileSync(filePath, serializeYaml(model), 'utf-8');
      if (!flags.quiet) out.info(`Wrote ${filePath}`);
    }
  } else {
    const multi = result.models.length > 1;
    for (const model of result.models) {
      if (multi) process.stdout.write(`# --- model: ${model.name} ---\n`);
      process.stdout.write(serializeYaml(model));
      if (multi) process.stdout.write('\n');
    }
  }

  if (!flags.quiet) {
    out.success(`Generated ${result.models.length} model(s).`);
  }
}

function readStdin(): string {
  // Synchronously read everything piped to stdin. `process.stdin.read()` only
  // returns buffered chunks and would silently truncate slow pipes.
  return fs.readFileSync(0, 'utf-8');
}

function loadSourceSpecs(paths: string[]): SourceSpec[] {
  // Non-recursive: directory entries are read at the top level only. If your
  // sources live in nested folders, pass each leaf directory or file
  // explicitly.
  const specs: SourceSpec[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      throw new CommandError(`Source file not found: ${p}`);
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) {
        if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
          specs.push(parseSourceFile(path.join(p, entry)));
        }
      }
    } else {
      specs.push(parseSourceFile(p));
    }
  }
  return specs;
}

function parseSourceFile(filePath: string): SourceSpec {
  const text = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Invalid YAML in ${filePath}: ${msg}`, 2);
  }
  const result = SourceSpecSchema.safeParse(parsed);
  if (!result.success) {
    throw new CommandError(
      formatSpecValidationMessage('source', filePath, result.error, {
        schema: SourceSpecSchema,
      }),
      2
    );
  }
  return result.data;
}

function serializeYaml(model: unknown): string {
  return YAML.stringify(model, { lineWidth: 0, indent: 2 });
}

function deriveModelName(inputFile: string): string {
  if (inputFile === '-') return 'generated_model';
  const base = path.basename(inputFile, path.extname(inputFile));
  // Sanitize to a valid identifier.
  return base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
}

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description('Generate Model Spec YAML model specs from existing SQL (Snowflake views only)')
    .requiredOption(
      '--fromsql <file>',
      'Path to the SQL file to convert into Model Spec models (or `-` to read from stdin)'
    )
    .option(
      '--sqldialect <dialect>',
      `SQL dialect of the input file (supported: ${SUPPORTED_DIALECTS.join(', ')})`,
      'snowflake'
    )
    .option(
      '-s, --sources <path...>',
      'Source spec file(s) or directory containing source YAMLs (required)'
    )
    .option('-o, --output <dir>', 'Write YAML files to a directory (default: stdout)')
    .option('-n, --name <name>', 'Override the head model name (default: derived from filename)')
    .option('-d, --description <text>', 'Description for the head model')
    .option(
      '--cte-prefix <prefix>',
      'Prefix for ephemeral models lifted from CTEs (default: <name>__)'
    )
    .option(
      '--default-connection <handle>',
      'Default connection used when source.table matches by short name only'
    )
    .action(async (opts: GenerateOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await generateHandler(opts, globalOptions);
    });
}
