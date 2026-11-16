import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';
import { loadProjectSkillDocuments, type ProjectSkill } from '@bobsled-inc/skills/project';

import {
  createLink,
  createManagedCopy,
  ensureAdapterDirectory,
  expectedLinkTarget,
  inspectAdapterEntry,
  managedCopySource,
  readLinkTarget,
  removeManagedCopy,
  removeManagedLink,
  updateManagedCopy,
} from './adapter-files.js';

export const PROJECT_SKILL_ADAPTERS = [
  { agent: 'codex', directory: '.agents/skills' },
  { agent: 'claude', directory: '.claude/skills' },
] as const;

export type ProjectSkillAdapterAgent = (typeof PROJECT_SKILL_ADAPTERS)[number]['agent'];
export type ProjectSkillAdapterMode = 'link' | 'copy';
export type ProjectSkillAdapterState =
  'created' | 'unchanged' | 'updated' | 'removed' | 'missing' | 'stale' | 'conflict';

export interface ProjectSkillAdapterStatus {
  agent: ProjectSkillAdapterAgent;
  skill: string;
  mode: ProjectSkillAdapterMode;
  state: ProjectSkillAdapterState;
  path: string;
  message?: string;
}

export interface ProjectSkillAdapterReport {
  ok: boolean;
  statuses: ProjectSkillAdapterStatus[];
}

export interface ConfigureProjectSkillAdaptersOptions {
  copy?: boolean;
}

function status(
  agent: ProjectSkillAdapterAgent,
  skill: string,
  mode: ProjectSkillAdapterMode,
  state: ProjectSkillAdapterState,
  destination: string,
  projectRoot: string,
  message?: string
): ProjectSkillAdapterStatus {
  return {
    agent,
    skill,
    mode,
    state,
    path: path.relative(projectRoot, destination).split(path.sep).join('/'),
    ...(message ? { message } : {}),
  };
}

function sourcePaths(projectRoot: string, skill: ProjectSkill) {
  const sourceFile = path.join(projectRoot, ...skill.filePath.split('/'));
  return { sourceFile, sourceDirectory: path.dirname(sourceFile) };
}

/**
 * Agent skill folders expect `<name>/SKILL.md`, so only a Skill authored as a
 * `SKILL.md` file can be linked; a Skill in any other Markdown file always gets
 * a managed copy.
 */
function canLinkSkill(skill: ProjectSkill): boolean {
  return path.posix.basename(skill.filePath) === 'SKILL.md';
}

function adapterMode(skill: ProjectSkill, copy = false): ProjectSkillAdapterMode {
  return copy || !canLinkSkill(skill) ? 'copy' : 'link';
}

/**
 * The entry Bobsled Core made for a Skill whose file has since moved: a link to the
 * conventional `skills/<name>` folder, or an unedited managed copy made from
 * another Skill file. Bobsled Core may replace it; anything else is the author's.
 */
function formerBobsledEntry(
  projectRoot: string,
  adapterDirectory: string,
  destination: string,
  name: string
): ProjectSkillAdapterMode | undefined {
  const conventionalTarget = expectedLinkTarget(
    adapterDirectory,
    path.join(projectRoot, 'skills', name)
  );
  const source = managedCopySource(destination) ?? `skills/${name}/SKILL.md`;
  const inspected = inspectAdapterEntry(destination, conventionalTarget, source);
  return inspected.kind === 'link' || inspected.kind === 'copy' ? inspected.kind : undefined;
}

export function configureProjectSkillAdapters(
  projectRoot: string,
  options: ConfigureProjectSkillAdaptersOptions = {}
): ProjectSkillAdapterReport {
  const registry = loadProjectSkillDocuments(projectRoot);
  const statuses: ProjectSkillAdapterStatus[] = [];

  for (const adapter of PROJECT_SKILL_ADAPTERS) {
    const adapterDirectory = ensureAdapterDirectory(projectRoot, adapter.directory);
    for (const skill of registry.skills) {
      const mode = adapterMode(skill, options.copy);
      const destination = path.join(adapterDirectory, skill.name);
      const { sourceFile, sourceDirectory } = sourcePaths(projectRoot, skill);
      const target = expectedLinkTarget(adapterDirectory, sourceDirectory);
      const inspected = inspectAdapterEntry(destination, target, skill.filePath);
      if (inspected.kind === mode) {
        statuses.push(
          status(adapter.agent, skill.name, mode, 'unchanged', destination, projectRoot)
        );
      } else if (inspected.kind !== 'missing') {
        statuses.push(
          status(
            adapter.agent,
            skill.name,
            mode,
            'conflict',
            destination,
            projectRoot,
            inspected.message ?? `destination is already configured in ${inspected.kind} mode`
          )
        );
      } else if (mode === 'link') {
        createLink(destination, target);
        statuses.push(
          status(adapter.agent, skill.name, 'link', 'created', destination, projectRoot)
        );
      } else {
        createManagedCopy(destination, sourceFile, skill);
        statuses.push(
          status(adapter.agent, skill.name, 'copy', 'created', destination, projectRoot)
        );
      }
    }
  }
  return { ok: statuses.every((entry) => entry.state !== 'conflict'), statuses };
}

/**
 * An adapter entry no current Skill owns is Bobsled Core's to remove when it is a
 * managed copy, a link to the conventional `skills/<name>` folder, or a link
 * left under an old name to a current Skill's folder.
 */
function inspectStaleEntry(
  projectRoot: string,
  adapterDirectory: string,
  agent: ProjectSkillAdapterAgent,
  name: string,
  skillTargets: ReadonlySet<string>
): ProjectSkillAdapterStatus | undefined {
  const destination = path.join(adapterDirectory, name);
  const linkTarget = readLinkTarget(destination);
  const expectedTarget =
    linkTarget !== undefined && skillTargets.has(linkTarget)
      ? linkTarget
      : expectedLinkTarget(adapterDirectory, path.join(projectRoot, 'skills', name));
  const expectedSource = managedCopySource(destination) ?? `skills/${name}/SKILL.md`;
  const inspected = inspectAdapterEntry(destination, expectedTarget, expectedSource);
  if (inspected.kind === 'link') {
    return status(agent, name, 'link', 'stale', destination, projectRoot);
  }
  if (inspected.kind === 'copy') {
    return status(agent, name, 'copy', 'stale', destination, projectRoot);
  }
  return undefined;
}

function linkTargets(
  projectRoot: string,
  adapterDirectory: string,
  skills: readonly ProjectSkill[]
): Set<string> {
  return new Set(
    skills
      .filter(canLinkSkill)
      .map((skill) =>
        expectedLinkTarget(adapterDirectory, sourcePaths(projectRoot, skill).sourceDirectory)
      )
  );
}

/** Report each agent adapter entry for the project's Skills, reusing `index` when given. */
export function inspectProjectSkillAdapters(
  projectRoot: string,
  index?: ProjectIndex
): ProjectSkillAdapterReport {
  const registry = loadProjectSkillDocuments(projectRoot, { index });
  const sourceNames = new Set(registry.skills.map((skill) => skill.name));
  const statuses: ProjectSkillAdapterStatus[] = [];

  for (const adapter of PROJECT_SKILL_ADAPTERS) {
    const adapterDirectory = path.join(projectRoot, ...adapter.directory.split('/'));
    if (!existsSync(adapterDirectory) || lstatSync(adapterDirectory).isSymbolicLink()) {
      for (const skill of registry.skills) {
        statuses.push(
          status(
            adapter.agent,
            skill.name,
            adapterMode(skill),
            'missing',
            path.join(adapterDirectory, skill.name),
            projectRoot,
            'adapter directory is missing or not a regular directory'
          )
        );
      }
      continue;
    }

    for (const skill of registry.skills) {
      const destination = path.join(adapterDirectory, skill.name);
      const { sourceDirectory } = sourcePaths(projectRoot, skill);
      const target = expectedLinkTarget(adapterDirectory, sourceDirectory);
      const inspected = inspectAdapterEntry(destination, target, skill.filePath);
      if (inspected.kind === 'link') {
        const state = canLinkSkill(skill) ? 'unchanged' : 'stale';
        statuses.push(status(adapter.agent, skill.name, 'link', state, destination, projectRoot));
      } else if (inspected.kind === 'copy') {
        const state =
          inspected.marker?.sourceContentHash === skill.contentHash ? 'unchanged' : 'stale';
        statuses.push(status(adapter.agent, skill.name, 'copy', state, destination, projectRoot));
      } else {
        const former =
          inspected.kind === 'missing'
            ? undefined
            : formerBobsledEntry(projectRoot, adapterDirectory, destination, skill.name);
        statuses.push(
          former
            ? status(adapter.agent, skill.name, former, 'stale', destination, projectRoot)
            : status(
                adapter.agent,
                skill.name,
                adapterMode(skill),
                inspected.kind === 'missing' ? 'missing' : 'conflict',
                destination,
                projectRoot,
                inspected.message
              )
        );
      }
    }

    const targets = linkTargets(projectRoot, adapterDirectory, registry.skills);
    for (const entry of readdirSync(adapterDirectory, { withFileTypes: true })) {
      if (sourceNames.has(entry.name)) continue;
      const stale = inspectStaleEntry(
        projectRoot,
        adapterDirectory,
        adapter.agent,
        entry.name,
        targets
      );
      if (stale) statuses.push(stale);
    }
  }
  return {
    ok: statuses.every((entry) => entry.state === 'unchanged'),
    statuses,
  };
}

/** Create, repair, and remove agent adapter entries from one project scan. */
export function syncProjectSkillAdapters(
  projectRoot: string,
  index?: ProjectIndex
): ProjectSkillAdapterReport {
  const scanned = resolveProjectIndex(projectRoot, index);
  const preflight = inspectProjectSkillAdapters(projectRoot, scanned);
  if (preflight.statuses.some((entry) => entry.state === 'conflict')) return preflight;

  const registry = loadProjectSkillDocuments(projectRoot, { index: scanned });
  const byName = new Map(registry.skills.map((skill) => [skill.name, skill]));
  const statuses: ProjectSkillAdapterStatus[] = [];

  for (const adapter of PROJECT_SKILL_ADAPTERS) {
    const adapterDirectory = ensureAdapterDirectory(projectRoot, adapter.directory);
    for (const skill of registry.skills) {
      const destination = path.join(adapterDirectory, skill.name);
      const { sourceFile, sourceDirectory } = sourcePaths(projectRoot, skill);
      const target = expectedLinkTarget(adapterDirectory, sourceDirectory);
      const inspected = inspectAdapterEntry(destination, target, skill.filePath);
      if (inspected.kind === 'missing' && canLinkSkill(skill)) {
        createLink(destination, target);
        statuses.push(
          status(adapter.agent, skill.name, 'link', 'created', destination, projectRoot)
        );
      } else if (inspected.kind === 'missing') {
        createManagedCopy(destination, sourceFile, skill);
        statuses.push(
          status(adapter.agent, skill.name, 'copy', 'created', destination, projectRoot)
        );
      } else if (inspected.kind === 'link' && canLinkSkill(skill)) {
        statuses.push(
          status(adapter.agent, skill.name, 'link', 'unchanged', destination, projectRoot)
        );
      } else if (inspected.kind === 'link') {
        removeManagedLink(destination);
        createManagedCopy(destination, sourceFile, skill);
        statuses.push(
          status(adapter.agent, skill.name, 'copy', 'updated', destination, projectRoot)
        );
      } else if (inspected.kind === 'copy') {
        if (inspected.marker?.sourceContentHash === skill.contentHash) {
          statuses.push(
            status(adapter.agent, skill.name, 'copy', 'unchanged', destination, projectRoot)
          );
        } else {
          updateManagedCopy(destination, sourceFile, skill);
          statuses.push(
            status(adapter.agent, skill.name, 'copy', 'updated', destination, projectRoot)
          );
        }
      } else {
        const former = formerBobsledEntry(projectRoot, adapterDirectory, destination, skill.name);
        if (former === 'copy') {
          updateManagedCopy(destination, sourceFile, skill);
          statuses.push(
            status(adapter.agent, skill.name, 'copy', 'updated', destination, projectRoot)
          );
        } else if (former === 'link') {
          removeManagedLink(destination);
          if (canLinkSkill(skill)) createLink(destination, target);
          else createManagedCopy(destination, sourceFile, skill);
          statuses.push(
            status(
              adapter.agent,
              skill.name,
              adapterMode(skill),
              'updated',
              destination,
              projectRoot
            )
          );
        } else {
          statuses.push(
            status(
              adapter.agent,
              skill.name,
              adapterMode(skill),
              'conflict',
              destination,
              projectRoot,
              inspected.message
            )
          );
        }
      }
    }

    const targets = linkTargets(projectRoot, adapterDirectory, registry.skills);
    for (const entry of readdirSync(adapterDirectory, { withFileTypes: true })) {
      if (byName.has(entry.name)) continue;
      const stale = inspectStaleEntry(
        projectRoot,
        adapterDirectory,
        adapter.agent,
        entry.name,
        targets
      );
      if (!stale) continue;
      const destination = path.join(adapterDirectory, entry.name);
      if (stale.mode === 'link') removeManagedLink(destination);
      else removeManagedCopy(destination);
      statuses.push({ ...stale, state: 'removed' });
    }
  }

  return { ok: statuses.every((entry) => entry.state !== 'conflict'), statuses };
}
