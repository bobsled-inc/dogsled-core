import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { resolveCliBobsledProject } from '../runner/config/cli-project-location.js';
import { validateCliProjectPipelines } from '../runner/commands/validation.js';
import { recommendSetup } from './recommend.js';
import { SetupAnswersSchema } from './types.js';

import type { SetupDoctorReport, SetupAnswers } from './types.js';
import { resolveSetupAnswersPath } from './answers-path.js';

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\breplace-me\b/i,
  /(?:^|[\s/@:=-])your-(?:project|bucket|database|account|org|region|dataset|warehouse|schema|table|api-key|token|dsn|url|host)\b/i,
  /\bexample\.com\b/i,
];

function hasPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

/** Inspect the local setup state and report blockers before local execution. */
export async function doctorSetup(options: {
  cwd: string;
  answersPath?: string;
  configPath?: string;
  projectRoot?: string;
}): Promise<SetupDoctorReport> {
  const checks: SetupDoctorReport['checks'] = [];
  const blockers = new Set<string>();
  const nextActions = new Set<string>();
  const project = resolveCliBobsledProject({
    configPath: options.configPath,
    projectRoot: options.projectRoot,
    cwd: options.cwd,
  });
  const projectRoot = project?.projectRoot ?? path.resolve(options.projectRoot ?? options.cwd);
  const answersPath = resolveSetupAnswersPath(
    options.answersPath ?? 'bobsled.setup.answers.yml',
    projectRoot
  );
  const { index } = project ?? { projectRoot };

  let answers: SetupAnswers | undefined;

  if (!existsSync(answersPath)) {
    checks.push({
      name: 'answers-file',
      status: 'fail',
      message: 'bobsled.setup.answers.yml is missing.',
      fix: 'Run `dogsled setup install` or `dogsled setup recommend --write` first.',
    });
    blockers.add('Missing setup answers file');
    nextActions.add('Create bobsled.setup.answers.yml with `dogsled setup recommend --write`.');
  } else {
    const parsed = SetupAnswersSchema.safeParse(parseYaml(readFileSync(answersPath, 'utf-8')));
    if (!parsed.success) {
      checks.push({
        name: 'answers-file',
        status: 'fail',
        message: 'bobsled.setup.answers.yml is invalid.',
        fix: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
      blockers.add('Invalid setup answers file');
    } else {
      answers = parsed.data;
      checks.push({
        name: 'answers-file',
        status: 'pass',
        message: 'bobsled.setup.answers.yml is present and readable.',
      });
    }
  }

  if (answers) {
    const recommended = recommendSetup({ answers });
    const credRefsToCheck =
      answers.credentials.required_secret_refs.length > 0
        ? answers.credentials.required_secret_refs
        : recommended.credentialRefs;

    if (!answers.goals.summary) {
      checks.push({
        name: 'goal',
        status: 'fail',
        message: 'No setup goal has been recorded yet.',
        fix: 'Add goals.summary to bobsled.setup.answers.yml.',
      });
      blockers.add('Missing setup goal');
    } else {
      checks.push({
        name: 'goal',
        status: 'pass',
        message: `Setup goal: ${answers.goals.summary}`,
      });
    }

    if (recommended.sources.length === 0) {
      checks.push({
        name: 'sources',
        status: 'fail',
        message: 'No integrations are selected yet.',
        fix: 'Add at least one source integration.',
      });
      blockers.add('No integrations selected');
    } else {
      checks.push({
        name: 'sources',
        status: 'pass',
        message: `Selected integrations: ${recommended.sources.map((source) => source.integration).join(', ')}`,
      });
    }

    if (credRefsToCheck.some((ref) => ref.status === 'missing')) {
      const missingSecretNames = credRefsToCheck
        .filter((ref) => ref.status === 'missing')
        .map((ref) => ref.name);
      checks.push({
        name: 'credentials',
        status: 'fail',
        message: `Missing credential references: ${missingSecretNames.join(', ')}`,
        fix: 'Add environment variable names or mark which references are already configured.',
      });
      for (const secretName of missingSecretNames) {
        blockers.add(secretName);
      }
      nextActions.add('Gather the missing credentials or secret references.');
    } else {
      checks.push({
        name: 'credentials',
        status: 'pass',
        message: 'All expected credential references are present.',
      });
    }

    for (const [field, value] of Object.entries(recommended.destination)) {
      if (hasPlaceholder(value)) {
        checks.push({
          name: 'destination-placeholders',
          status: 'warn',
          message: `Destination field "${field}" still uses a placeholder value.`,
          fix: 'Replace the placeholder with your real destination setting before running pipelines.',
        });
        nextActions.add('Replace any placeholder destination values in bobsled.setup.answers.yml.');
      }
    }
  }

  const validation = await validateCliProjectPipelines({
    projectRoot,
    index,
    ...(options.configPath && project?.configPaths[0]
      ? { configPath: project.configPaths[0] }
      : {}),
  });
  if (!validation.valid) {
    checks.push({
      name: 'bobsled-config',
      status: 'fail',
      message: `Dogsled Project configuration is invalid: ${validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      fix: 'Fix the validation issues or rerun `dogsled setup render`.',
    });
    blockers.add('Dogsled Project validation errors');
  } else if (validation.project?.configPaths.length === 0) {
    checks.push({
      name: 'bobsled-config',
      status: 'warn',
      message: 'No pipeline configuration is present yet.',
      fix: 'Add a pipeline configuration when the project needs scheduled or manual pipelines.',
    });
    nextActions.add('Add a typed pipeline configuration when the project needs a pipeline.');
  } else {
    checks.push({
      name: 'bobsled-config',
      status: 'pass',
      message: `Pipeline configuration is valid for ${validation.pipelines.length} pipeline(s).`,
    });
  }

  const ready = blockers.size === 0;
  if (ready) {
    nextActions.add('Run `dogsled runner validate`.');
    nextActions.add('Run a pipeline locally with `dogsled runner run <pipeline> --json`.');
  }

  return {
    status: ready ? 'ready' : 'blocked',
    summary: ready
      ? 'Setup is ready for local pipeline execution.'
      : `Setup is blocked by ${blockers.size} item(s): ${[...blockers].join(', ')}`,
    checks,
    nextActions: [...nextActions],
    blockers: [...blockers],
  };
}
