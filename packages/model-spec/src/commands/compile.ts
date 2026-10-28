/**
 * `model compile` command — thin CLI wrapper over `compileProject`.
 *
 * All project loading, fan-out, metadata validation, and result assembly live
 * in `../api/compile-project.ts`. This file owns only arg parsing, stdout / FS
 * output formatting, and the `--include-metadata` output-dir invariant.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';

import { compileProject, firstCompileError } from '../api/compile-project.js';
import { CommandError } from '../errors.js';
import * as out from '../output.js';

import { createIntegrationOption, parseGlobalFlags } from './common.js';

interface CompileOptions {
  output?: string;
  integration?: string;
  includeMetadata?: boolean;
}

async function compileHandler(
  modelNames: string[],
  localOptions: CompileOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags(globalOptions);

  if (localOptions.includeMetadata && !localOptions.output) {
    throw new CommandError(
      '--include-metadata requires --output <dir>: metric/relationship/entity-relationship/VQ JSON ' +
        'files cannot be interleaved with SQL on stdout. Re-run with `--output target/`.',
      2
    );
  }

  const result = await compileProject(process.cwd(), {
    integration: localOptions.integration,
    models: modelNames,
    warnings: true,
    includeMetadata: localOptions.includeMetadata,
  });

  for (const w of result.warnings) out.warn(w);
  for (const s of result.skipped) out.warn(s.message);

  const firstError = firstCompileError(result);
  if (firstError) throw new CommandError(firstError);

  if (result.byIntegration.length === 0) {
    if (!flags.quiet) out.info('No integrations produced any models — nothing to compile.');
    return;
  }

  let totalSuccesses = 0;
  const multi = result.byIntegration.length > 1;

  for (const group of result.byIntegration) {
    const successes = group.results.filter((r): r is typeof r & { ok: true } => r.ok);

    if (localOptions.output) {
      const outDir = path.join(localOptions.output, group.handle);
      fs.mkdirSync(outDir, { recursive: true });
      for (const s of successes) {
        const filePath = path.join(outDir, `${s.modelName.toUpperCase()}.sql`);
        fs.writeFileSync(filePath, s.sql + '\n', 'utf-8');
        if (!flags.quiet) out.info(`Wrote ${filePath}`);
      }
    } else {
      if (multi) process.stdout.write(`-- integration: ${group.handle}\n`);
      for (const s of successes) {
        if (successes.length > 1) process.stdout.write(`-- ${s.modelName}\n`);
        process.stdout.write(s.sql + '\n\n');
      }
    }

    totalSuccesses += successes.length;
    if (!flags.quiet && multi) {
      out.success(`[${group.handle}] Compiled ${successes.length} model(s).`);
    }
  }

  if (localOptions.includeMetadata && localOptions.output && result.metadata) {
    writeMetadataJson(localOptions.output, result.metadata, flags.quiet);
  }

  if (!flags.quiet) out.success(`Compiled ${totalSuccesses} model(s).`);
}

function writeMetadataJson(
  outputDir: string,
  metadata: NonNullable<Awaited<ReturnType<typeof compileProject>>['metadata']>,
  quiet: boolean
): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const writeJson = (filename: string, items: unknown[]): void => {
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2) + '\n', 'utf-8');
    if (!quiet) out.info(`Wrote ${filePath}`);
  };
  writeJson(
    'metrics.json',
    [...metadata.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))
  );
  writeJson(
    'relationships.json',
    [...metadata.relationships.values()].sort((a, b) => a.name.localeCompare(b.name))
  );
  writeJson(
    'entity-relationships.json',
    [...metadata.entityRelationships.values()].sort((a, b) => a.name.localeCompare(b.name))
  );
  writeJson(
    'vqs.json',
    [...metadata.vqs.values()].sort((a, b) => a.name.localeCompare(b.name))
  );
}

export function registerCompileCommand(program: Command): void {
  program
    .command('compile')
    .description('Compile YAML specs into warehouse SQL DDL')
    .argument('[model...]', 'Model names to compile (default: all)')
    .option('-o, --output <dir>', 'Write SQL files to a directory (default: stdout)')
    .option(
      '--include-metadata',
      'Emit metrics.json / relationships.json / entity-relationships.json / vqs.json alongside SQL (requires --output)'
    )
    .addOption(createIntegrationOption())
    .action(async (modelNames: string[], opts: CompileOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await compileHandler(modelNames, opts, globalOptions);
    });
}
