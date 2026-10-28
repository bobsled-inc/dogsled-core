import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';

import { CommandError } from '@bobsled-inc/protocol';
import { resolvePathWithinDir } from '@bobsled-inc/model-spec/shared';

import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';

interface FixtureCatalogEntry {
  name: string;
  description: string;
  sourceCheckoutPath: (packageRoot: string) => string;
  sourceCheckoutOnly?: string;
}

interface FixtureOptions {
  output?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

const PACKAGE_NAME = '@bobsled-inc/entity-graph';

const FIXTURES: FixtureCatalogEntry[] = [
  {
    name: 'b2b-company-master',
    description: 'Resolution, survivorship, and truthset fixtures for company mastering.',
    sourceCheckoutPath: (packageRoot) => path.join(packageRoot, 'tests/fixtures/specs/resolutions'),
  },
  {
    name: 'entity-resolution-sdk',
    description: 'Runnable entity resolution and SDK example project (source checkout only).',
    sourceCheckoutPath: (packageRoot) =>
      path.join(packageRoot, '../../examples/entity-resolution-sdk'),
    sourceCheckoutOnly: 'examples/entity-resolution-sdk',
  },
];

export function findEntityGraphPackageRoot(startDir: string = import.meta.dirname): string {
  let current = path.resolve(startDir);
  for (;;) {
    const manifestPath = path.join(current, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
      if (manifest.name === PACKAGE_NAME) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new CommandError(`Cannot locate the ${PACKAGE_NAME} package root.`, 1);
    }
    current = parent;
  }
}

export function resolveFixtureSourcePath(name: string, packageRoot: string): string | undefined {
  const fixture = FIXTURES.find((entry) => entry.name === name);
  if (!fixture) return undefined;
  return [
    path.join(packageRoot, 'fixtures', fixture.name),
    fixture.sourceCheckoutPath(packageRoot),
  ].find((candidate) => fs.existsSync(candidate));
}

function fixtureListPayload() {
  return {
    command: 'entity-graph.fixtures.list',
    fixtures: FIXTURES.map((fixture) => ({
      name: fixture.name,
      description: fixture.description,
    })),
  };
}

function renderFixtureListText(payload: ReturnType<typeof fixtureListPayload>): string {
  return `${payload.fixtures
    .map((fixture) => `${fixture.name}: ${fixture.description}`)
    .join('\n')}\n`;
}

function renderFixtureCopyText(payload: {
  fixture: string;
  output_dir: string;
  copied_files: string[];
}): string {
  return (
    [`Copied ${payload.fixture} to ${payload.output_dir}`, ...payload.copied_files].join('\n') +
    '\n'
  );
}

function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(filePath));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function resolveFormat(options: FixtureOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
}

function listFixtures(options: FixtureOptions): void {
  const format = resolveFormat(options);
  const payload = fixtureListPayload();
  if (options.quiet) return;
  emitEntityGraphPayload(payload, format, () => renderFixtureListText(payload));
}

function copyFixture(name: string, options: FixtureOptions): void {
  const fixture = FIXTURES.find((entry) => entry.name === name);
  if (!fixture) {
    throw new CommandError(
      `Unknown fixture "${name}". Available: ${FIXTURES.map((entry) => entry.name).join(', ')}`,
      2
    );
  }
  const cwd = process.cwd();
  const outputDir = resolvePathWithinDir(
    cwd,
    options.output ?? fixture.name,
    'Fixture output path'
  );
  const sourcePath = resolveFixtureSourcePath(fixture.name, findEntityGraphPackageRoot());
  if (!sourcePath && fixture.sourceCheckoutOnly) {
    throw new CommandError(
      `Fixture "${fixture.name}" is available from a source checkout only. Clone the Dogsled repository and use ${fixture.sourceCheckoutOnly}.`,
      1
    );
  }
  if (!sourcePath) {
    throw new CommandError(
      `Fixture "${fixture.name}" is not included in this installation. Reinstall Dogsled or copy it from a source checkout.`,
      1
    );
  }
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  try {
    fs.cpSync(sourcePath, outputDir, {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Unable to copy fixture "${fixture.name}": ${message}`, 1);
  }
  const copiedFiles = collectFiles(outputDir).sort();
  const payload = {
    command: 'entity-graph.fixtures.copy',
    fixture: fixture.name,
    output_dir: outputDir,
    copied_files: copiedFiles,
  };
  const format = resolveFormat(options);
  if (options.quiet) return;
  emitEntityGraphPayload(payload, format, () => renderFixtureCopyText(payload));
}

export function registerFixturesCommand(program: Command): void {
  const fixtures = program.command('fixtures').description('List or copy entity graph fixtures');

  fixtures
    .command('list', { isDefault: true })
    .description('List maintained entity graph fixtures')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-essential output')
    .action((opts: FixtureOptions) => listFixtures(opts));

  fixtures
    .command('copy')
    .description('Copy a maintained entity graph fixture')
    .argument('<name>', 'Fixture name')
    .option('-o, --output <dir>', 'Destination directory under the current project')
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-essential output')
    .action((name: string, opts: FixtureOptions) => copyFixture(name, opts));
}
