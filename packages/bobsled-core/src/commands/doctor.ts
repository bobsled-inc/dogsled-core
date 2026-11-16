import YAML from 'yaml';
import { checkProjectModelReferences } from '../runtime/doctor/project-models.js';
import type { Command } from 'commander';

import { resolveProviderModels } from '@bobsled-inc/ai';
import {
  isBlockingProjectIndexIssue,
  scanProject,
  type ProjectIndex,
  type ProjectIndexIssue,
} from '@bobsled-inc/project-index';
import { CommandError, EXIT_ERROR, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import * as fmt from '../lib/output/formatter.js';
import { resolveCliBobsledProject } from '../runner/config/cli-project-location.js';
import type { BobsledProjectLocation } from '../runner/config/loader.js';
import { validateCliProjectPipelines } from '../runner/commands/validation.js';
import {
  checkMcpUnfilteredInProduction,
  checkSdkStale,
  type DoctorFinding,
} from '../runtime/doctor/serving-checks.js';
import {
  ProjectDocumentValidationError,
  inspectProjectSkillAdapters,
  loadProjectGuide,
  validateProjectSkills,
} from '../project-skills/index.js';
import { AGENT_GUIDE_PLACEHOLDER_SENTENCE } from '../setup/agent-guide.js';
import type { GlobalOptions } from '../types/index.js';

interface DoctorOutputOptions extends ReturnType<typeof fmt.toOutputOptions> {
  yaml?: boolean;
}

interface DoctorOptions {
  config?: string;
  projectRoot?: string;
  guide?: boolean;
  json?: boolean;
  yaml?: boolean;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  filePath?: string;
  fieldPath?: string;
  relatedFilePaths?: string[];
}

function doctorErrorMessage(error: unknown): string {
  if (error instanceof ProjectDocumentValidationError) {
    return error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function describeIndexIssues(issues: readonly ProjectIndexIssue[]): string {
  const listed = issues
    .slice(0, 20)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return issues.length > 20 ? `${listed}; and ${issues.length - 20} more` : listed;
}

/**
 * Report the project scan: problems that stop Dogsled commands as an error, and
 * files Dogsled skipped (symbolic links, files owned by other tools, unknown
 * types outside Dogsled folders) as a warning, so nothing is skipped unseen.
 */
export function checkProjectFiles(projectRoot: string, index?: ProjectIndex): DoctorCheck[] {
  let scanned: ProjectIndex;
  try {
    scanned = index ?? scanProject(projectRoot);
  } catch (error) {
    return [{ name: 'project.files', status: 'error', message: doctorErrorMessage(error) }];
  }
  const blocking = scanned.issues.filter((issue) => isBlockingProjectIndexIssue(scanned, issue));
  const skipped = scanned.issues.filter((issue) => !isBlockingProjectIndexIssue(scanned, issue));
  const checks: DoctorCheck[] = [
    blocking.length > 0
      ? { name: 'project.files', status: 'error', message: describeIndexIssues(blocking) }
      : {
          name: 'project.files',
          status: 'ok',
          message: `${scanned.entries.length} project file${scanned.entries.length === 1 ? '' : 's'} recognized`,
        },
  ];
  if (skipped.length > 0) {
    checks.push({
      name: 'project.files.skipped',
      status: 'warn',
      message: `Dogsled skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}: ${describeIndexIssues(skipped)}`,
    });
  }
  return checks;
}

/** Scan the project once for the file and Skill checks; `undefined` when the root cannot be listed. */
function scanDoctorProject(projectRoot: string): ProjectIndex | undefined {
  try {
    return scanProject(projectRoot);
  } catch {
    return undefined;
  }
}

export async function checkProjectSkills(
  projectRoot: string,
  index?: ProjectIndex
): Promise<DoctorCheck[]> {
  try {
    const scanned = index ?? scanProject(projectRoot);
    const registry = await validateProjectSkills(projectRoot, { guide: false, index: scanned });
    if (registry.skills.length === 0) {
      return [{ name: 'project.skills', status: 'ok', message: 'No Project Skills configured' }];
    }

    const checks: DoctorCheck[] = [
      {
        name: 'project.skills',
        status: 'ok',
        message: `${registry.skills.length} Project Skill${registry.skills.length === 1 ? '' : 's'} valid`,
      },
    ];
    const report = inspectProjectSkillAdapters(projectRoot, scanned);
    for (const adapter of report.statuses) {
      checks.push({
        name: `project.skills.adapters.${adapter.agent}.${adapter.skill}`,
        status: adapter.state === 'unchanged' ? 'ok' : 'error',
        message: `${adapter.state}: ${adapter.path}${adapter.message ? ` (${adapter.message})` : ''}`,
      });
    }
    return checks;
  } catch (error) {
    return [{ name: 'project.skills', status: 'error', message: doctorErrorMessage(error) }];
  }
}

export async function checkProjectGuide(projectRoot: string): Promise<DoctorCheck[]> {
  try {
    const guide = await loadProjectGuide(projectRoot);
    if (!guide) {
      return [{ name: 'project.guide', status: 'ok', message: 'No Project guide configured' }];
    }
    if (guide.content.includes(AGENT_GUIDE_PLACEHOLDER_SENTENCE)) {
      return [
        {
          name: 'project.guide',
          status: 'warn',
          message:
            'Project guide AGENTS.md still contains the setup scaffold placeholder; describe the data before agents rely on it',
        },
      ];
    }
    return [
      {
        name: 'project.guide',
        status: 'ok',
        message: `Project guide ${guide.path} valid (${guide.byteLength} bytes)`,
      },
    ];
  } catch (error) {
    return [{ name: 'project.guide', status: 'error', message: doctorErrorMessage(error) }];
  }
}

function writeDoctor(payload: unknown, options: DoctorOutputOptions): void {
  if (options.quiet) {
    return;
  }
  if (options.yaml) {
    fmt.output(YAML.stringify(payload).trimEnd(), { ...options, json: false });
    return;
  }
  if (options.json) {
    fmt.output(payload, options);
    return;
  }

  const result = payload as { valid: boolean; checks: DoctorCheck[] };
  for (const check of result.checks) {
    fmt.output(`${check.status.toUpperCase()} ${check.name}: ${check.message}`, options);
  }
}

function resolveProject(configPath?: string, projectRoot?: string): BobsledProjectLocation {
  const project = resolveCliBobsledProject({ configPath, projectRoot });
  if (!project) {
    throw new CommandError(
      'Could not find a Dogsled Project. Pass --project-root <path>.',
      EXIT_ERROR
    );
  }
  return project;
}

const SERVING_CHECK_NAMES = {
  mcp_unfiltered_in_production: 'mcp.unfiltered_in_production',
  sdk_stale: 'sdk.stale',
} as const satisfies Record<DoctorFinding['check'], string>;

export function servingCheckName(check: DoctorFinding['check']): string {
  return SERVING_CHECK_NAMES[check];
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check Dogsled project health')
    .option('--config <path>', 'Path to dogsled.yml')
    .option('--project-root <path>', 'Dogsled Project root (default: current directory)')
    .option('--no-guide', 'Skip Project guide validation')
    .option('--json', 'Emit JSON')
    .option('--yaml', 'Emit YAML')
    .action(async (commandOrOptions: Command | DoctorOptions) => {
      const options =
        typeof (commandOrOptions as Command).opts === 'function'
          ? (commandOrOptions as Command).opts<DoctorOptions>()
          : (commandOrOptions as DoctorOptions);
      const globalOptions = program.opts<GlobalOptions>();
      const baseOutputOptions = fmt.toOutputOptions(globalOptions);
      const outputOptions: DoctorOutputOptions = {
        ...baseOutputOptions,
        json: options.yaml ? false : (options.json ?? baseOutputOptions.json),
        yaml: options.yaml,
      };
      const configPath = options.config ?? globalOptions.config;
      const project = resolveProject(configPath, options.projectRoot ?? globalOptions.projectRoot);
      const { projectRoot, index } = project;
      const validation = await validateCliProjectPipelines({
        projectRoot,
        index,
        ...(configPath ? { configPath: project.configPaths[0]! } : {}),
      });
      const checks: DoctorCheck[] = validation.warnings.map((message) => ({
        name: 'dogsled-config.warning',
        status: 'warn',
        message,
      }));
      for (const issue of validation.errors) {
        checks.push({
          name: 'dogsled-config',
          status: 'error',
          message: `${issue.path}: ${issue.message}`,
          filePath: issue.filePath,
          ...(issue.fieldPath ? { fieldPath: issue.fieldPath } : {}),
          ...(issue.relatedFilePaths ? { relatedFilePaths: issue.relatedFilePaths } : {}),
        });
      }
      const config = validation.project?.config;
      const modelEntries = Object.entries(config?.platform?.models ?? {}) as [
        string,
        Parameters<typeof resolveProviderModels>[0],
      ][];

      if (modelEntries.length === 0) {
        checks.push({
          name: 'platform.models',
          status: 'warn',
          message: 'No model roles configured',
        });
      }

      for (const [role, connection] of modelEntries) {
        try {
          const providerModels = await resolveProviderModels(connection);
          checks.push({
            name: `platform.models.${role}`,
            status: providerModels.embeddingModel || providerModels.languageModel ? 'ok' : 'warn',
            message: `${connection.provider}/${connection.model} resolved`,
          });
        } catch (error) {
          checks.push({
            name: `platform.models.${role}`,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (config?.platform?.budget?.ai_cost_daily_usd !== undefined) {
        checks.push({
          name: 'platform.budget.ai_cost_daily_usd',
          status: 'ok',
          message: `$${config.platform.budget.ai_cost_daily_usd} daily AI budget configured`,
        });
      }

      const servingFindings: DoctorFinding[] = [
        checkMcpUnfilteredInProduction(),
        checkSdkStale({ rootDir: projectRoot }),
      ];
      for (const finding of servingFindings) {
        checks.push({
          name: servingCheckName(finding.check),
          status:
            finding.severity === 'fail' ? 'error' : finding.severity === 'warn' ? 'warn' : 'ok',
          message: finding.summary,
        });
      }

      const projectIndex = index ?? scanDoctorProject(projectRoot);
      checks.push(...checkProjectFiles(projectRoot, projectIndex));
      if (
        projectIndex &&
        !projectIndex.issues.some((issue) => isBlockingProjectIndexIssue(projectIndex, issue))
      ) {
        checks.push(...checkProjectModelReferences(projectIndex));
      }
      checks.push(...(await checkProjectSkills(projectRoot, projectIndex)));
      if (options.guide === false) {
        checks.push({
          name: 'project.guide',
          status: 'ok',
          message: 'Project guide validation skipped by --no-guide',
        });
      } else {
        checks.push(...(await checkProjectGuide(projectRoot)));
      }

      const payload = {
        valid: checks.every((check) => check.status !== 'error'),
        checks,
      };
      writeDoctor(payload, outputOptions);
      process.exitCode = payload.valid ? 0 : EXIT_VALIDATION;
    });
}
