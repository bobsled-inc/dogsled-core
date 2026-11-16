import path from 'node:path';

import YAML from 'yaml';

import {
  ProjectDocumentValidationError,
  configureProjectSkillAdapters,
  getProjectSkill,
  loadProjectSkillDocuments,
  loadProjectGuide,
  loadProjectSkills,
  syncProjectSkillAdapters,
  toProjectGuideSummary,
  toProjectSkillSummary,
  type ProjectDocumentIssue,
  type ProjectGuide,
  type ProjectSkillAdapterReport,
  type ProjectSkillRegistry,
} from '../project-skills/index.js';

import * as fmt from '../lib/output/formatter.js';
import { validateLoadedProjectSkills } from '../project-skills/validation.js';
import { resolveCliBobsledProject } from '../runner/config/cli-project-location.js';

import type { GlobalOptions } from '../types/index.js';

export interface SkillOutputOptions {
  yaml?: boolean;
}

export interface SkillConfigureOptions extends SkillOutputOptions {
  copy?: boolean;
}

export interface SkillValidateOptions extends SkillOutputOptions {
  guide?: boolean;
}

export function resolveSkillProjectRoot(
  configPath?: string,
  startDir = process.cwd(),
  projectRoot?: string
): string {
  return (
    resolveCliBobsledProject({ configPath, projectRoot, cwd: startDir })?.projectRoot ??
    path.resolve(startDir, projectRoot ?? '.')
  );
}

function outputData(
  data: unknown,
  options: SkillOutputOptions,
  globalOptions: GlobalOptions,
  renderText: (outputOptions: ReturnType<typeof fmt.toOutputOptions>) => void
): void {
  const outputOptions = fmt.toOutputOptions(globalOptions);
  if (options.yaml) {
    fmt.output(YAML.stringify(data, { lineWidth: 120 }).trimEnd(), {
      ...outputOptions,
      json: false,
    });
  } else if (outputOptions.json) {
    fmt.output(data, outputOptions);
  } else {
    renderText(outputOptions);
  }
}

function reportValidationIssues(
  issues: ProjectDocumentIssue[],
  options: SkillOutputOptions,
  globalOptions: GlobalOptions
): void {
  outputData({ ok: false, issues }, options, globalOptions, (outputOptions) => {
    for (const issue of issues) fmt.error(`${issue.path}: ${issue.message}`, outputOptions);
  });
  process.exitCode = 2;
}

async function withSkillErrors(
  options: SkillOutputOptions,
  globalOptions: GlobalOptions,
  operation: () => Promise<void> | void
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ProjectDocumentValidationError) {
      reportValidationIssues(error.issues, options, globalOptions);
      return;
    }
    throw error;
  }
}

export async function runSkillList(
  options: SkillOutputOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  await withSkillErrors(options, globalOptions, async () => {
    const projectRoot = resolveSkillProjectRoot(
      globalOptions.config,
      process.cwd(),
      globalOptions.projectRoot
    );
    const registry = await loadProjectSkills(projectRoot, { guide: false });
    const summaries = registry.skills.map(toProjectSkillSummary);
    outputData(summaries, options, globalOptions, (outputOptions) => {
      if (summaries.length === 0) {
        fmt.info('No Project Skills found.', outputOptions);
        return;
      }
      fmt.table(
        ['Name', 'Description', 'Hash', 'Path'],
        summaries.map((skill) => [
          skill.name,
          skill.description,
          skill.contentHash,
          skill.filePath,
        ]),
        outputOptions
      );
    });
  });
}

export async function runSkillShow(
  name: string,
  options: SkillOutputOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  await withSkillErrors(options, globalOptions, async () => {
    const projectRoot = resolveSkillProjectRoot(
      globalOptions.config,
      process.cwd(),
      globalOptions.projectRoot
    );
    const skill = await getProjectSkill(projectRoot, name, { guide: false });
    if (!skill) {
      reportValidationIssues(
        [{ path: 'skills', message: `Project Skill "${name}" was not found` }],
        options,
        globalOptions
      );
      return;
    }
    outputData(skill, options, globalOptions, (outputOptions) => {
      fmt.info(`${skill.name}: ${skill.description}`, outputOptions);
      fmt.output(skill.content, { ...outputOptions, json: false });
    });
  });
}

export async function runSkillValidate(
  name: string | undefined,
  options: SkillValidateOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  await withSkillErrors(options, globalOptions, async () => {
    const projectRoot = resolveSkillProjectRoot(
      globalOptions.config,
      process.cwd(),
      globalOptions.projectRoot
    );
    const skillIssues: ProjectDocumentIssue[] = [];
    const guideIssues: ProjectDocumentIssue[] = [];
    let loaded: ProjectSkillRegistry | undefined;
    let guide: ProjectGuide | undefined;

    try {
      loaded = loadProjectSkillDocuments(projectRoot);
    } catch (error) {
      if (error instanceof ProjectDocumentValidationError) skillIssues.push(...error.issues);
      else throw error;
    }

    if (options.guide !== false) {
      try {
        guide = await loadProjectGuide(projectRoot);
      } catch (error) {
        if (error instanceof ProjectDocumentValidationError) guideIssues.push(...error.issues);
        else throw error;
      }
    }

    let registry: ProjectSkillRegistry | undefined;
    if (loaded) {
      const selected = name
        ? { skills: loaded.skills.filter((skill) => skill.name === name) }
        : loaded;
      if (name && selected.skills.length === 0) {
        skillIssues.push({ path: 'skills', message: `Project Skill "${name}" was not found` });
      } else {
        try {
          registry = await validateLoadedProjectSkills(projectRoot, selected);
        } catch (error) {
          if (error instanceof ProjectDocumentValidationError) skillIssues.push(...error.issues);
          else throw error;
        }
      }
    }

    const issues = [...skillIssues, ...guideIssues];
    if (issues.length > 0) {
      reportValidationIssues(issues, options, globalOptions);
      return;
    }
    if (!registry) throw new Error('Project Skill validation did not produce a registry');

    const payload = {
      ok: true,
      count: registry.skills.length,
      skills: registry.skills.map((skill) => ({
        name: skill.name,
        contentHash: skill.contentHash,
      })),
      guide: guide ? toProjectGuideSummary(guide) : null,
    };
    outputData(payload, options, globalOptions, (outputOptions) => {
      fmt.success(
        `${payload.count} Project Skill${payload.count === 1 ? '' : 's'} valid.`,
        outputOptions
      );
      if (guide) {
        fmt.success(`Project guide ${guide.path} valid.`, outputOptions);
      } else if (options.guide === false) {
        fmt.info('Project guide validation skipped.', outputOptions);
      } else {
        fmt.info('No Project guide found.', outputOptions);
      }
    });
  });
}

function outputAdapterReport(
  report: ProjectSkillAdapterReport,
  options: SkillOutputOptions,
  globalOptions: GlobalOptions
): void {
  outputData(report, options, globalOptions, (outputOptions) => {
    if (report.statuses.length === 0) {
      fmt.info('No Project Skill adapters needed.', outputOptions);
      return;
    }
    fmt.table(
      ['Agent', 'Skill', 'Mode', 'State', 'Path'],
      report.statuses.map((entry) => [
        entry.agent,
        entry.skill,
        entry.mode,
        entry.state,
        entry.path,
      ]),
      outputOptions
    );
  });
  if (!report.ok) process.exitCode = 2;
}

export async function runSkillConfigure(
  options: SkillConfigureOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  await withSkillErrors(options, globalOptions, () => {
    const projectRoot = resolveSkillProjectRoot(
      globalOptions.config,
      process.cwd(),
      globalOptions.projectRoot
    );
    outputAdapterReport(
      configureProjectSkillAdapters(projectRoot, { copy: options.copy }),
      options,
      globalOptions
    );
  });
}

export async function runSkillSync(
  options: SkillOutputOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  await withSkillErrors(options, globalOptions, () => {
    const projectRoot = resolveSkillProjectRoot(
      globalOptions.config,
      process.cwd(),
      globalOptions.projectRoot
    );
    outputAdapterReport(syncProjectSkillAdapters(projectRoot), options, globalOptions);
  });
}
