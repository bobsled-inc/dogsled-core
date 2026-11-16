import { collectEnvironmentReferences } from '@bobsled-inc/protocol';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify } from 'yaml';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import { ROOT_CONFIG_FILE_SPELLINGS } from '@bobsled-inc/project-index';

import { PROJECT_GUIDE_MAX_FILE_BYTES } from '../project-skills/index.js';
import { SetupAnswersSchema } from './types.js';
import { recommendSetup } from './recommend.js';
import { starterProjectSkillFile } from './project-skills.js';
import { buildAgentGuide, formatDestination } from './agent-guide.js';
import { SETUP_ANSWERS_FILE } from './answers-path.js';
import { SETUP_ANSWERS_FILE_SPELLINGS } from './legacy-names.js';

import type {
  RenderedSetupFile,
  SetupAnswers,
  SetupDestination,
  SetupSecretRef,
  SetupSource,
} from './types.js';

export { writeRenderedSetupFiles } from './render-files.js';

const ROOT_CONFIG_FILE = 'bobsled.yml';

const PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function defaultDestinationName(destinationType: SetupDestination['type']): string {
  return `${destinationType}_destination`;
}

function buildBobsledConfig(recommended: ReturnType<typeof recommendSetup>): string {
  const destinationName = defaultDestinationName(recommended.destination.type);

  const pipelines = Object.fromEntries(
    recommended.sources.map((source) => {
      const pipelineEntry: Record<string, unknown> = {
        schedule: source.schedule,
        source: source.integration,
        destination: destinationName,
      };
      if (source.resources && source.resources.length > 0) {
        pipelineEntry['resources'] = source.resources;
      } else {
        // Pipelines must declare resources. With no explicit selection, leave
        // an empty list so `dogsled setup doctor` flags it for the operator.
        pipelineEntry['resources'] = [];
      }
      return [source.integration, pipelineEntry];
    })
  );

  const config = {
    destinations: {
      [destinationName]: {
        ...recommended.destination,
        auth_env_vars: [...collectEnvironmentReferences(recommended.destination)],
      },
    },
    defaults: {
      timeout: '2h',
      retry: {
        attempts: 2,
        backoff: 'exponential',
      },
    },
    pipelines,
  };

  return stringify(config);
}

function buildPipelineTable(sources: SetupSource[], destination: SetupDestination): string {
  const rows = sources
    .map(
      (source) =>
        `| ${source.integration} | ${source.schedule ?? 'daily'} | ${formatDestination(destination)} |`
    )
    .join('\n');

  return [
    '| Pipeline | Schedule | Destination |',
    '| -------- | -------- | ----------- |',
    rows,
  ].join('\n');
}

function buildSecretChecklist(secretRefs: SetupSecretRef[]): string {
  const items = secretRefs
    .map((ref) => `- \`${ref.name}\` — ${ref.description ?? 'Required secret reference'}`)
    .join('\n');

  return `# Secrets Checklist

These are the secret references currently expected for this repo.

${items}

Store actual secret values in environment variables or a secret manager. Do not commit raw values.`;
}

function buildSummary(recommended: ReturnType<typeof recommendSetup>): string {
  const missing = recommended.missingItems;
  const done = [
    'selected integrations',
    `selected ${recommended.destination.type} as the destination`,
    'wrote the setup answers file',
  ];
  const remaining =
    missing.length === 0
      ? '- No blocking items remain.'
      : missing.map((item) => `- ${item}`).join('\n');

  return `# Setup Summary

## Current Goal

${recommended.goal}

## Current Status

Cowork has:

${done.map((item) => `- ${item}`).join('\n')}

We still need:

${remaining}

## Next Step

Open this repo in Cowork and ask it to continue Dogsled setup from the local files.`;
}

function buildReadme(repoName: string, recommended: ReturnType<typeof recommendSetup>): string {
  return `# ${repoName}

Dogsled-managed data pipelines for ${recommended.goal}

## Pipelines

${buildPipelineTable(recommended.sources, recommended.destination)}

## Manual Operations

- Validate config: \`dogsled runner validate\`
- Check setup blockers: \`dogsled setup doctor\`
- Run one pipeline locally: \`dogsled runner run <pipeline>\`

## Secrets

${recommended.credentialRefs.map((ref) => `- \`${ref.name}\``).join('\n')}`;
}

function buildStartHere(): string {
  return `# Start Here

This repo was set up with the Dogsled Cowork flow.

## What You Should Do

1. Open this repo in Claude Cowork.
2. Ask Cowork to continue Dogsled setup from the local files.
3. Answer any remaining questions.
4. Add any missing credentials Cowork asks for.

## Suggested Prompt

Continue Dogsled setup for this repo.

Please:

- read \`AGENTS.md\`
- read \`bobsled.setup.answers.yml\`
- read \`bobsled.setup.summary.md\`
- tell me what is already configured
- tell me what is still missing
- finish setup if enough information is available
- keep instructions in plain English`;
}

function buildTroubleshooting(): string {
  return `# Cowork Troubleshooting

- Run \`dogsled setup doctor\` for a plain-English readiness report.
- Run \`dogsled runner validate\` if \`bobsled.yml\` changed.
- Never place raw secrets into repo files; store only secret references or placeholders.`;
}

function buildDashboardState(
  answers: SetupAnswers,
  recommended: ReturnType<typeof recommendSetup>
): string {
  return JSON.stringify(
    {
      project: {
        repo_name: answers.project.repo_name,
        status: recommended.missingItems.length === 0 ? 'ready' : 'needs_credentials',
      },
      setup: {
        phase: recommended.missingItems.length === 0 ? 'ready-to-run' : 'gathering-inputs',
        summary: recommended.summary,
      },
      blockers: recommended.missingItems,
      next_actions: recommended.nextActions,
    },
    null,
    2
  );
}

/** Render the Dogsled setup artifacts from a setup answers object. */
export async function renderSetupFiles(answersInput: SetupAnswers): Promise<RenderedSetupFile[]> {
  const answers = SetupAnswersSchema.parse(answersInput);
  const recommended = recommendSetup({ answers });
  const normalizedAnswers = SetupAnswersSchema.parse({
    ...answers,
    project: {
      ...answers.project,
      repo_name: recommended.repoName,
    },
    goals: {
      ...answers.goals,
      summary: recommended.goal,
      preset: recommended.preset.id,
    },
    sources: recommended.sources,
    destination: recommended.destination,
    credentials: {
      required_secret_refs: recommended.credentialRefs,
    },
    status: {
      setup_phase: recommended.missingItems.length === 0 ? 'ready-to-run' : 'gathering-inputs',
      missing_items: recommended.missingItems,
    },
  });

  const bobsledConfig = buildBobsledConfig(recommended);
  const agentGuide =
    buildAgentGuide(recommended.repoName, recommended.sources, recommended.destination) + '\n';
  const agentGuideBytes = Buffer.byteLength(agentGuide, 'utf8');
  if (agentGuideBytes > PROJECT_GUIDE_MAX_FILE_BYTES) {
    throw new CommandError(
      `Rendered AGENTS.md is ${agentGuideBytes} bytes; maximum is ${PROJECT_GUIDE_MAX_FILE_BYTES}`,
      EXIT_VALIDATION
    );
  }

  return [
    { path: ROOT_CONFIG_FILE, content: bobsledConfig },
    { path: 'README.md', content: buildReadme(recommended.repoName, recommended) + '\n' },
    {
      path: 'AGENTS.md',
      preserveExisting: true,
      content: agentGuide,
    },
    starterProjectSkillFile(recommended.repoName),
    { path: 'docs/cowork-start-here.md', content: buildStartHere() + '\n' },
    {
      path: 'docs/cowork-secret-checklist.md',
      content: buildSecretChecklist(recommended.credentialRefs) + '\n',
    },
    { path: 'docs/cowork-troubleshooting.md', content: buildTroubleshooting() + '\n' },
    { path: SETUP_ANSWERS_FILE, content: stringify(normalizedAnswers) },
    { path: 'bobsled.setup.summary.md', content: buildSummary(recommended) + '\n' },
    {
      path: 'dogsled.dashboard.state.json',
      content: buildDashboardState(normalizedAnswers, recommended) + '\n',
    },
  ];
}

/** The file to write instead of `current`: an existing file under an earlier spelling, newest first. */
function existingSpelling(outDir: string, current: string, spellings: readonly string[]): string {
  if (existsSync(path.join(outDir, current))) return current;
  return [...spellings].reverse().find((name) => existsSync(path.join(outDir, name))) ?? current;
}

/**
 * Point the rendered root config and answers file at the names the target directory already uses,
 * so re-running setup in a project from an earlier Core generation rewrites its files in place
 * instead of adding a second root config next to them.
 */
export function renderIntoExistingSpellings(
  files: RenderedSetupFile[],
  outDir: string
): RenderedSetupFile[] {
  const targets = new Map([
    [ROOT_CONFIG_FILE, existingSpelling(outDir, ROOT_CONFIG_FILE, ROOT_CONFIG_FILE_SPELLINGS)],
    [
      SETUP_ANSWERS_FILE,
      existingSpelling(outDir, SETUP_ANSWERS_FILE, SETUP_ANSWERS_FILE_SPELLINGS),
    ],
  ]);
  return files.map((file) => {
    const target = targets.get(file.path);
    return target && target !== file.path ? { ...file, path: target } : file;
  });
}

function getPackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const baseDir = path.dirname(thisFile);
  const packageRoot =
    path.basename(baseDir) === 'dist'
      ? path.resolve(baseDir, '..')
      : path.resolve(baseDir, '..', '..');
  return packageRoot;
}

/** Return the installed cowork asset directory for this package build. */
export function getCoworkAssetsDir(): string {
  return path.join(getPackageRoot(), 'cowork');
}

/** Copy the packaged cowork assets into a target repository. */
export function installCoworkAssets(targetDir: string): string[] {
  try {
    const copied: string[] = [];
    const assetsDir = getCoworkAssetsDir();
    const pluginTarget = path.join(targetDir, '.claude', 'plugins', 'bobsled-setup');
    mkdirSync(path.dirname(pluginTarget), { recursive: true });
    cpSync(path.join(assetsDir, 'bobsled-setup-plugin'), pluginTarget, { recursive: true });
    copied.push(path.relative(targetDir, pluginTarget));

    const docsTarget = path.join(targetDir, 'docs');
    mkdirSync(docsTarget, { recursive: true });
    for (const assetName of [
      'cowork-bootstrap.md',
      'cowork-dashboard-prompt.md',
      'cowork-troubleshooting.md',
    ]) {
      const source = path.join(assetsDir, assetName);
      const destination = path.join(docsTarget, assetName);
      cpSync(source, destination);
      copied.push(path.relative(targetDir, destination));
    }

    const answersPath = path.join(targetDir, 'bobsled.setup.answers.yml');
    const starter = SetupAnswersSchema.parse({
      project: {
        repo_state: 'new',
      },
      goals: {},
      sources: [],
      credentials: {
        required_secret_refs: [],
      },
      status: {
        setup_phase: 'gathering-inputs',
        missing_items: [],
      },
    });
    try {
      writeFileSync(answersPath, stringify(starter), { encoding: 'utf-8', flag: 'wx' });
      copied.push(path.relative(targetDir, answersPath));
    } catch (error: unknown) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'EEXIST') {
        throw error;
      }
    }

    return copied;
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (typeof errno?.code === 'string' && PERMISSION_ERROR_CODES.has(errno.code)) {
      throw new CommandError(
        `Permission denied writing to "${targetDir}".\n` +
          `If this directory is read-only or on a mounted volume, use:\n\n` +
          `  dogsled setup install --dir /path/to/writable/directory\n\n` +
          `Then copy the generated files into your repo.`,
        2
      );
    }
    throw error;
  }
}
