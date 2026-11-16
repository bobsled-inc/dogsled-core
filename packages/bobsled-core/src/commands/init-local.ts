/**
 * `bobsled init` — zero-config, account-less project scaffolding.
 *
 * Creates a self-contained Bobsled Core project that boots without any account.
 * DuckLake is the default destination, but the command supports any DatabaseDestination
 * the loader handles via `--destination <kind>`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import * as fmt from '../lib/output/formatter.js';
import type { GlobalOptions } from '../types/index.js';

export type LocalDestinationKind = 'ducklake' | 'duckdb' | 'postgres' | 'snowflake' | 'bigquery';

const SUPPORTED_DESTINATIONS: readonly LocalDestinationKind[] = [
  'ducklake',
  'duckdb',
  'postgres',
  'snowflake',
  'bigquery',
];

export interface LocalInitOptions {
  /** Project directory name; created relative to CWD. */
  projectName?: string;
  /** Destination flag — defaults to `ducklake`. */
  destination?: string;
  /** Skip DuckLake-default behavior and choose DuckDB-classic. */
  duckdb?: boolean;
  /** Force DuckLake-default (alias for the default flow). */
  ducklake?: boolean;
  /** Any flag in this set triggers the local flow. */
  local?: boolean;
}

export function shouldRunLocalInit(opts: LocalInitOptions): boolean {
  return Boolean(opts.local || opts.ducklake || opts.duckdb || opts.destination);
}

export function resolveLocalDestination(opts: LocalInitOptions): LocalDestinationKind {
  if (opts.destination) {
    if (!SUPPORTED_DESTINATIONS.includes(opts.destination as LocalDestinationKind)) {
      throw new CommandError(
        `Unsupported destination "${opts.destination}". Supported: ${SUPPORTED_DESTINATIONS.join(', ')}`,
        2
      );
    }
    return opts.destination as LocalDestinationKind;
  }
  if (opts.duckdb) return 'duckdb';
  // Default: ducklake (and --ducklake alias).
  return 'ducklake';
}

/**
 * Validate that `projectName` is a single safe path segment that can't escape CWD.
 * Rejects: path separators, leading dots (hidden / parent traversal), leading dashes
 * (could be parsed as a flag), and anything that resolves outside CWD after normalizing.
 */
function assertSafeProjectName(projectName: string): void {
  // Reject control characters (newline, tab, carriage return, NUL through 0x1F, DEL)
  // and edge whitespace — these would break the YAML scalar even after the quoting
  // pass, and bash completion / shell history can paste them invisibly.

  const hasControlChars = /[\u0000-\u001F\u007F]/.test(projectName);
  const hasEdgeWhitespace = projectName !== projectName.trim();
  if (
    projectName.length === 0 ||
    hasControlChars ||
    hasEdgeWhitespace ||
    projectName.includes('/') ||
    projectName.includes('\\') ||
    projectName.startsWith('.') ||
    projectName.startsWith('-')
  ) {
    throw new CommandError(
      `Invalid project name "${projectName}" — must be a single non-hidden path segment ` +
        `(no slashes, no control chars, no edge whitespace, no leading "." or "-").`,
      2
    );
  }
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, projectName);
  const rel = path.relative(cwd, resolved);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CommandError(
      `Project directory must live inside the current working directory; ` +
        `got "${resolved}" for project "${projectName}".`,
      2
    );
  }
}

export async function runLocalInit(
  opts: LocalInitOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  const outputOpts = fmt.toOutputOptions(globalOptions);
  const destination = resolveLocalDestination(opts);
  const projectName = opts.projectName ?? 'my-brain';
  assertSafeProjectName(projectName);
  const projectDir = path.resolve(process.cwd(), projectName);

  await assertProjectDirInitializable(projectDir, projectName);

  // Normalize all filesystem failures (permission denied, disk full, etc.) into
  // CommandError with the runtime-error exit code so callers see consistent
  // user-facing messages instead of raw Node ENOENT/EACCES strings. CommandError
  // raised inside the block (e.g. by validation paths added later) propagates
  // verbatim.
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, 'integrations'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'sources'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.bobsled'), { recursive: true });

    if (destination === 'ducklake') {
      await fs.mkdir(path.join(projectDir, '.bobsled', 'lake'), { recursive: true });
    }

    await fs.writeFile(path.join(projectDir, 'integrations', '.gitkeep'), '');
    await fs.writeFile(path.join(projectDir, 'sources', '.gitkeep'), '');

    await fs.writeFile(
      path.join(projectDir, '.bobsled', 'config.yml'),
      renderLocalDestinationConfig(destination),
      'utf-8'
    );
    await fs.writeFile(path.join(projectDir, 'bobsled.yml'), renderBobsledYaml(), 'utf-8');
    await fs.writeFile(path.join(projectDir, '.gitignore'), renderGitignore(), 'utf-8');
    await fs.writeFile(
      path.join(projectDir, 'README.md'),
      renderReadme(projectName, destination),
      'utf-8'
    );
  } catch (err: unknown) {
    if (err instanceof CommandError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Unable to scaffold project "${projectName}": ${message}`, 1);
  }

  fmt.success(`Created Bobsled Core project at ${projectDir}`, outputOpts);
  fmt.info(`Default destination: ${destination}`, outputOpts);
  fmt.info(`Next steps:`, outputOpts);
  fmt.info(`  cd ${projectName}`, outputOpts);
  fmt.info(`  Add integrations/<name>.yml and resources/<name>/<resource>.yml`, outputOpts);
  fmt.info(
    `  bobsled extract run --integration <name> <resource> | ${renderLocalLoadCommand(destination)}`,
    outputOpts
  );
  fmt.info(`  ${renderLocalQueryHint(destination)}`, outputOpts);
}

async function assertProjectDirInitializable(
  projectDir: string,
  projectName: string
): Promise<void> {
  try {
    const stat = await fs.lstat(projectDir);
    if (stat.isSymbolicLink()) {
      throw new CommandError(
        `Refusing to initialize: "${projectName}" already exists as a symlink. ` +
          `Choose a new project name or remove the existing path first.`,
        2
      );
    }
    if (!stat.isDirectory()) {
      throw new CommandError(
        `Refusing to initialize: "${projectName}" exists as a file, not a directory.`,
        2
      );
    }

    const entries = await fs.readdir(projectDir);
    if (entries.length > 0) {
      throw new CommandError(
        `Refusing to initialize: "${projectName}" already exists and is not empty. ` +
          `Choose a new project name or remove the existing directory first.`,
        2
      );
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    if (err instanceof CommandError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Unable to access "${projectName}": ${message}`, 1);
  }
}

function renderLocalDestinationConfig(destination: LocalDestinationKind): string {
  const header = [
    '# .bobsled/config.yml',
    '# Where `bobsled source-query` stores API-backed sources declared with `mode: lazy`.',
    '# `bobsled load run` does not read this file; pass destination flags to it instead.',
  ];
  switch (destination) {
    case 'ducklake':
      return [
        ...header,
        'default_destination:',
        '  dest: ducklake',
        '  catalogUrl: ducklake:.bobsled/lake/catalog.ducklake',
        '  targetSchema: bronze',
        '',
      ].join('\n');
    case 'duckdb':
      return [
        ...header,
        'default_destination:',
        '  dest: duckdb',
        '  dbPath: .bobsled/bobsled.duckdb',
        '  targetSchema: bronze',
        '',
      ].join('\n');
    case 'postgres':
      return [
        ...header,
        '# Lazy sources support ducklake, duckdb, bigquery, and snowflake. Postgres projects',
        '# keep lazy sources in the local DuckLake catalog.',
        'default_destination:',
        '  dest: ducklake',
        '  catalogUrl: ducklake:.bobsled/lake/catalog.ducklake',
        '  targetSchema: bronze',
        '',
      ].join('\n');
    case 'snowflake':
      return [
        ...header,
        '# Replace the placeholder values. Values are read as written, so use key-pair',
        '# auth (privateKeyPath) and keep secrets out of this file.',
        'default_destination:',
        '  dest: snowflake',
        '  account: my_account',
        '  username: my_user',
        '  privateKeyPath: ./keys/snowflake.p8',
        '  warehouse: my_warehouse',
        '  database: my_database',
        '  targetSchema: bronze',
        '',
      ].join('\n');
    case 'bigquery':
      return [
        ...header,
        '# Replace the placeholder project. Credentials come from Application Default Credentials.',
        'default_destination:',
        '  dest: bigquery',
        '  projectId: my-gcp-project',
        '  datasetId: bronze',
        '',
      ].join('\n');
  }
}

function renderBobsledYaml(): string {
  return [
    '# bobsled.yml',
    '# Pipeline configuration for this project. Integrations live in integrations/,',
    '# resources in resources/<integration>/, and SQL models in models/.',
    '# Reference: https://github.com/bobsled-inc/bobsled-core/blob/main/docs/reference/project-files.md',
    '',
    '# AI model roles used by embeddings and agentic models. Remove this block if',
    '# you do not use them. Credentials come from the AWS default credential chain.',
    'platform:',
    '  models:',
    '    default_embedding_v1:',
    '      provider: amazon-bedrock',
    '      model: amazon.titan-embed-text-v2:0',
    '',
    '# Example pipeline (commented out). Uncomment after adding integrations/stripe.yml',
    '# and its resources, then run `bobsled runner validate`.',
    '# destinations:',
    '#   warehouse:',
    '#     type: duckdb',
    '#     db_path: .bobsled/bobsled.duckdb',
    '# pipelines:',
    '#   stripe:',
    '#     schedule: manual',
    '#     source: stripe',
    '#     destination: warehouse',
    '#     resources: [customers, invoices]',
    '',
  ].join('\n');
}

function renderGitignore(): string {
  return ['# Generated by bobsled init', '.bobsled/*', '!.bobsled/config.yml', 'output/', ''].join(
    '\n'
  );
}

function renderLocalLoadCommand(destination: LocalDestinationKind): string {
  if (destination === 'duckdb') {
    return 'bobsled load run --dest duckdb --db-path .bobsled/bobsled.duckdb';
  }
  if (destination === 'ducklake') {
    return 'bobsled load run --dest ducklake --ducklake-catalog-url ducklake:.bobsled/lake/catalog.ducklake';
  }
  return `bobsled load run --dest ${destination}`;
}

function renderLocalQueryHint(destination: LocalDestinationKind): string {
  if (destination === 'duckdb') {
    return 'bobsled query "SELECT * FROM <resource> LIMIT 5" --db-path .bobsled/bobsled.duckdb';
  }
  if (destination === 'ducklake') {
    return 'bobsled query "LOAD ducklake; ATTACH \'ducklake:.bobsled/lake/catalog.ducklake\' AS lake; SELECT * FROM lake.main.<resource> LIMIT 5" --db-path .bobsled/query.duckdb';
  }
  return `# Query the loaded tables in ${destination} with your usual SQL client.`;
}

function renderReadme(projectName: string, destination: LocalDestinationKind): string {
  const loadCommand = renderLocalLoadCommand(destination);
  const queryHint = renderLocalQueryHint(destination);
  return [
    `# ${projectName}`,
    '',
    `A Bobsled Core project created with \`bobsled init\`. Default destination: **${destination}**.`,
    '',
    '## First run',
    '',
    'Add an integration at `integrations/<name>.yml` and one or more resources under',
    '`resources/<name>/`. Then extract and load:',
    '',
    '```bash',
    'bobsled extract run --integration <name> <resource> \\',
    `  | ${loadCommand}`,
    queryHint,
    '```',
    '',
    '## Layout',
    '',
    '- `bobsled.yml`: pipelines, destinations, and AI model roles.',
    '- `integrations/`: one file per API, database, or file source.',
    '- `sources/`: model sources, and documents you want to ingest.',
    '- `.bobsled/`: local settings, state, and data (git-ignored except `config.yml`).',
    '',
    'Documentation: https://github.com/bobsled-inc/bobsled-core/tree/main/docs',
    '',
  ].join('\n');
}
