import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { Command } from 'commander';

import * as fmt from '../lib/output/formatter.js';
import {
  recommendSetup,
  parseSetupAnswersFile,
  writeSetupAnswersFile,
} from '../setup/recommend.js';
import { buildSetupDescribePayload } from '../setup/catalog.js';
import {
  getCoworkAssetsDir,
  installCoworkAssets,
  renderSetupFiles,
  writeRenderedSetupFiles,
} from '../setup/render.js';
import { doctorSetup } from '../setup/doctor.js';
import { SetupAnswersSchema } from '../setup/types.js';

import type { GlobalOptions } from '../types/index.js';

function buildOutputOptions(
  opts: { json?: boolean; verbose?: boolean; quiet?: boolean },
  globalOpts: GlobalOptions
): ReturnType<typeof fmt.toOutputOptions> {
  return fmt.toOutputOptions({
    ...globalOpts,
    json: opts.json ?? globalOpts.json,
    verbose: opts.verbose ?? globalOpts.verbose,
    quiet: opts.quiet ?? globalOpts.quiet,
  });
}

function exportCoworkAssets(targetPath: string, format: 'dir' | 'zip'): void {
  const assetsDir = getCoworkAssetsDir();

  if (format === 'dir') {
    mkdirSync(targetPath, { recursive: true });
    cpSync(assetsDir, targetPath, { recursive: true });
    return;
  }

  const tempDir = path.join(path.dirname(targetPath), `.bobsled-setup-export-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  cpSync(assetsDir, path.join(tempDir, 'cowork'), { recursive: true });

  const result = spawnSync('zip', ['-rq', targetPath, 'cowork'], {
    cwd: tempDir,
    encoding: 'utf-8',
  });
  rmSync(tempDir, { recursive: true, force: true });

  if (result.status !== 0) {
    throw new Error(result.stderr || 'zip command failed');
  }
}

function renderRecommendationHuman(
  recommendation: ReturnType<typeof recommendSetup>,
  outputOpts: ReturnType<typeof fmt.toOutputOptions>
): void {
  fmt.info(recommendation.summary, outputOpts);
  fmt.info(`Recommended preset: ${recommendation.preset.displayName}`, outputOpts);
  fmt.info(
    `Sources: ${recommendation.sources.map((source) => source.integration).join(', ')}`,
    outputOpts
  );
  fmt.info(`Destination: ${recommendation.destination.type}`, outputOpts);
  if (recommendation.missingItems.length > 0) {
    fmt.warn(`Missing items: ${recommendation.missingItems.join(', ')}`, outputOpts);
  }
}

export function createSetupGroup(): Command {
  const group = new Command('setup');

  group.description('Recommend, write and check a project setup from a plain-English goal');

  group
    .command('describe')
    .description('Describe the setup questionnaire, catalog, presets, and validation rules')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action((opts: { json?: boolean; verbose?: boolean; quiet?: boolean }, cmd: Command) => {
      const outputOpts = buildOutputOptions(opts, cmd.optsWithGlobals<GlobalOptions>());
      const payload = buildSetupDescribePayload();

      if (outputOpts.json) {
        fmt.output(payload, outputOpts);
        return;
      }

      fmt.info(`Questions: ${payload.questionnaire.length}`, outputOpts);
      fmt.info(`Integrations: ${payload.integrations.length}`, outputOpts);
      fmt.info(`Destinations: ${payload.destinations.length}`, outputOpts);
      fmt.info(`Presets: ${payload.presets.map((preset) => preset.id).join(', ')}`, outputOpts);
    });

  group
    .command('recommend')
    .description('Recommend integrations, a destination, schedules, and required secret refs')
    .option('--goal <text>', 'Plain-English setup goal')
    .option('--answers <path>', 'Path to bobsled.setup.answers.yml', 'bobsled.setup.answers.yml')
    .option('--write', 'Write the normalized recommendation back to the answers file')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(
      (
        opts: {
          goal?: string;
          answers: string;
          write?: boolean;
          json?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        },
        cmd: Command
      ) => {
        const outputOpts = buildOutputOptions(opts, cmd.optsWithGlobals<GlobalOptions>());
        const answersPath = path.resolve(opts.answers);
        const answers = existsSync(answersPath)
          ? parseSetupAnswersFile(answersPath)
          : SetupAnswersSchema.parse({
              project: {
                repo_state: 'new',
              },
              goals: {},
              sources: [],
              credentials: {
                required_secret_refs: [],
              },
              status: {
                missing_items: [],
              },
            });

        const recommendation = recommendSetup({ goal: opts.goal, answers });

        if (opts.write) {
          const normalized = SetupAnswersSchema.parse({
            ...answers,
            project: {
              ...answers.project,
              repo_name: recommendation.repoName,
            },
            goals: {
              ...answers.goals,
              summary: recommendation.goal,
              preset: recommendation.preset.id,
            },
            sources: recommendation.sources,
            destination: recommendation.destination,
            credentials: {
              required_secret_refs: recommendation.credentialRefs,
            },
            status: {
              setup_phase:
                recommendation.missingItems.length === 0 ? 'recommended' : 'gathering-inputs',
              missing_items: recommendation.missingItems,
            },
          });
          writeSetupAnswersFile(answersPath, normalized);
        }

        if (outputOpts.json) {
          fmt.output(recommendation, outputOpts);
          return;
        }

        renderRecommendationHuman(recommendation, outputOpts);
      }
    );

  group
    .command('render')
    .description(
      'Render bobsled.yml, repo docs, resume files, and dashboard state from setup answers'
    )
    .option('--answers <path>', 'Path to bobsled.setup.answers.yml', 'bobsled.setup.answers.yml')
    .option('--out-dir <dir>', 'Target directory', '.')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(
      async (
        opts: {
          answers: string;
          outDir: string;
          json?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        },
        cmd: Command
      ) => {
        const outputOpts = buildOutputOptions(opts, cmd.optsWithGlobals<GlobalOptions>());
        const answers = parseSetupAnswersFile(path.resolve(opts.answers));
        const files = await renderSetupFiles(answers);
        const { written, preserved } = writeRenderedSetupFiles(files, path.resolve(opts.outDir));

        if (outputOpts.json) {
          fmt.output(
            files.map((file) => file.path),
            outputOpts
          );
          return;
        }

        fmt.success(`Rendered ${written.length} setup files.`, outputOpts);
        for (const filePath of written) {
          fmt.info(filePath, outputOpts);
        }
        for (const filePath of preserved) {
          fmt.info(
            `Preserved existing ${filePath} (edit it in place, or delete it to regenerate the scaffold).`,
            outputOpts
          );
        }
      }
    );

  group
    .command('doctor')
    .description('Explain setup blockers and stale generated files in plain English and JSON')
    .option('--answers <path>', 'Path to bobsled.setup.answers.yml', 'bobsled.setup.answers.yml')
    .option('--config <path>', 'Path to bobsled.yml')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(
      async (
        opts: {
          answers?: string;
          config?: string;
          projectRoot?: string;
          json?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        },
        cmd: Command
      ) => {
        const outputOpts = buildOutputOptions(opts, cmd.optsWithGlobals<GlobalOptions>());
        const report = await doctorSetup({
          cwd: process.cwd(),
          answersPath: opts.answers,
          configPath: opts.config ?? cmd.optsWithGlobals<GlobalOptions>().config,
          projectRoot: opts.projectRoot ?? cmd.optsWithGlobals<GlobalOptions>().projectRoot,
        });

        if (outputOpts.json) {
          fmt.output(report, outputOpts);
          if (report.status === 'blocked') {
            process.exitCode = 2;
          }
          return;
        }

        if (report.status === 'ready') {
          fmt.success(report.summary, outputOpts);
        } else {
          fmt.error(report.summary, outputOpts);
        }

        for (const check of report.checks) {
          if (check.status === 'pass') fmt.info(`${check.name}: ${check.message}`, outputOpts);
          if (check.status === 'warn') fmt.warn(`${check.name}: ${check.message}`, outputOpts);
          if (check.status === 'fail') fmt.error(`${check.name}: ${check.message}`, outputOpts);
        }

        if (report.status === 'blocked') {
          process.exitCode = 2;
        }
      }
    );

  group
    .command('install')
    .description('Install the bundled Cowork setup assets into the current or target repo')
    .option('--dir <dir>', 'Target directory', '.')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(
      (
        opts: {
          dir: string;
          json?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        },
        cmd: Command
      ) => {
        const outputOpts = buildOutputOptions(opts, cmd.optsWithGlobals<GlobalOptions>());
        const targetDir = path.resolve(opts.dir);
        mkdirSync(targetDir, { recursive: true });
        const copied = installCoworkAssets(targetDir);

        if (outputOpts.json) {
          fmt.output({ copied }, outputOpts);
          return;
        }

        fmt.success(`Installed Cowork setup assets into ${targetDir}`, outputOpts);
        for (const item of copied) {
          fmt.info(item, outputOpts);
        }
      }
    );

  group
    .command('export')
    .description('Export the bundled Cowork plugin and docs as a directory or zip bundle')
    .option('--output <path>', 'Output path', './bobsled-cowork-kit.zip')
    .option('--format <format>', 'dir or zip', 'zip')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(
      (
        opts: {
          output: string;
          format: 'dir' | 'zip';
          json?: boolean;
          verbose?: boolean;
          quiet?: boolean;
        },
        cmd: Command
      ) => {
        const outputOpts = buildOutputOptions(opts, cmd.optsWithGlobals<GlobalOptions>());
        const outputPath = path.resolve(opts.output);
        exportCoworkAssets(outputPath, opts.format);

        if (outputOpts.json) {
          fmt.output({ output: outputPath, format: opts.format }, outputOpts);
          return;
        }

        fmt.success(`Exported Cowork assets to ${outputPath}`, outputOpts);
      }
    );

  return group;
}
