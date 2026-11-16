import { resolveProjectIndex } from '@bobsled-inc/project-index';
import {
  loadProjectSkillDocuments,
  validateProjectSkillReferences,
  type LoadProjectGuideDocumentOptions,
  type LoadProjectSkillDocumentsOptions,
  type ProjectSkillReferenceCatalog,
  type ProjectSkillRegistry,
} from '@bobsled-inc/skills/project';

import {
  buildProjectSkillReferenceCatalog,
  type ProjectSkillHostDeclarations,
} from './reference-catalog.js';

/**
 * `declaredEnvNames` and `hostManagedModelAuth` are accepted for compatibility
 * and have no effect: Skill reference checks read names only.
 */
export interface ProjectSkillsOptions
  extends LoadProjectSkillDocumentsOptions, ProjectSkillHostDeclarations {
  guide?: false | LoadProjectGuideDocumentOptions;
  referenceCatalog?: ProjectSkillReferenceCatalog;
  validateReferences?: boolean;
}

export async function validateLoadedProjectSkills(
  projectRoot: string,
  registry: ProjectSkillRegistry,
  options: ProjectSkillsOptions = {}
): Promise<ProjectSkillRegistry> {
  if (options.validateReferences === false) return registry;
  if (registry.skills.every((skill) => skill.references.length === 0)) return registry;
  const catalog =
    options.referenceCatalog ??
    (await buildProjectSkillReferenceCatalog(projectRoot, options.index));
  return validateProjectSkillReferences(registry, catalog);
}

/** Load the project's Skills and validate their references from one project scan. */
export async function loadAndValidateProjectSkills(
  projectRoot: string,
  options: ProjectSkillsOptions = {}
): Promise<ProjectSkillRegistry> {
  const scanned = { ...options, index: resolveProjectIndex(projectRoot, options.index) };
  const registry = loadProjectSkillDocuments(projectRoot, scanned);
  return validateLoadedProjectSkills(projectRoot, registry, scanned);
}
