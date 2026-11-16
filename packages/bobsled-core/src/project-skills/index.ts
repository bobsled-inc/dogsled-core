import { entriesOfKind, resolveProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';
import {
  buildProjectSkillDocumentsManifest,
  loadIndexedProjectGuides,
  loadProjectGuideDocument,
  type LoadProjectGuideDocumentOptions,
  type ProjectGuide,
  type ProjectSkill,
  type ProjectSkillRegistry,
  type ProjectSkillsManifest,
} from '@bobsled-inc/skills/project';

import { loadAndValidateProjectSkills, type ProjectSkillsOptions } from './validation.js';

export * from '@bobsled-inc/skills/project';
export {
  buildProjectSkillReferenceCatalog,
  BobsledProjectSkillReferenceCatalog,
  type ProjectSkillHostDeclarations,
  type ProjectSkillReferenceNames,
} from './reference-catalog.js';
export type { ProjectSkillsOptions } from './validation.js';
export {
  PROJECT_SKILL_ADAPTERS,
  configureProjectSkillAdapters,
  inspectProjectSkillAdapters,
  syncProjectSkillAdapters,
  type ConfigureProjectSkillAdaptersOptions,
  type ProjectSkillAdapterAgent,
  type ProjectSkillAdapterMode,
  type ProjectSkillAdapterReport,
  type ProjectSkillAdapterState,
  type ProjectSkillAdapterStatus,
} from './adapters.js';

function loadConfiguredProjectGuides(
  index: ProjectIndex,
  options: ProjectSkillsOptions
): readonly ProjectGuide[] {
  return options.guide === false ? [] : loadIndexedProjectGuides(index, options.guide);
}

export async function loadProjectSkills(
  projectRoot: string,
  options: ProjectSkillsOptions = {}
): Promise<ProjectSkillRegistry> {
  const index = resolveProjectIndex(projectRoot, options.index);
  const registry = await loadAndValidateProjectSkills(projectRoot, { ...options, index });
  loadConfiguredProjectGuides(index, options);
  return registry;
}

export async function getProjectSkill(
  projectRoot: string,
  name: string,
  options: ProjectSkillsOptions = {}
): Promise<ProjectSkill | undefined> {
  const registry = await loadProjectSkills(projectRoot, options);
  return registry.skills.find((skill) => skill.name === name);
}

export async function validateProjectSkills(
  projectRoot: string,
  options: ProjectSkillsOptions = {}
): Promise<ProjectSkillRegistry> {
  return loadProjectSkills(projectRoot, options);
}

export async function loadProjectGuide(
  projectRoot: string,
  options: LoadProjectGuideDocumentOptions = {}
): Promise<ProjectGuide | undefined> {
  return loadProjectGuideDocument(projectRoot, options);
}

export async function buildProjectSkillsManifest(
  projectRoot: string,
  options: ProjectSkillsOptions = {}
): Promise<ProjectSkillsManifest> {
  const index = resolveProjectIndex(projectRoot, options.index);
  const registry = await loadAndValidateProjectSkills(projectRoot, { ...options, index });
  const guides = loadConfiguredProjectGuides(index, options);
  const guide = guides.find((entry) => entry.path === 'AGENTS.md');
  const hasScopedGuide = entriesOfKind(index, 'guide').some(
    (entry) => entry.path !== 'AGENTS.md' || entry.declaredType === 'guide'
  );
  return buildProjectSkillDocumentsManifest(registry, guide, {
    guides,
    scopedGuides: hasScopedGuide,
  });
}
