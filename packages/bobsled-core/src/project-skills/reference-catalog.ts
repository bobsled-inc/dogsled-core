import { buildCatalogManifest } from '@bobsled-inc/integrations/catalog';
import { listActions, loadActions } from '@bobsled-inc/integrations/actions';
import type { ProjectIndex } from '@bobsled-inc/project-index';
import type {
  ProjectSkillReferenceCatalog,
  ProjectSkillReferenceKind,
  ProjectSkillReferenceResolution,
} from '@bobsled-inc/skills/project';

import {
  loadProjectPipelineConfigNames,
  type LoadProjectPipelineConfigOptions,
} from '../runner/config/project-resolver.js';
import { discoverProjectModels } from '../runner/config/model-discovery.js';
import { openBobsledProject } from '../runner/config/project-files.js';
import { discoverProjectResourceNames } from '../runner/config/resolve-resource.js';

const REFERENCE_KINDS: ProjectSkillReferenceKind[] = ['model', 'resource', 'action', 'pipeline'];

export type ProjectSkillReferenceNames = Record<ProjectSkillReferenceKind, string[]>;

/**
 * Host declarations accepted for compatibility. The catalog reads only model
 * and pipeline names and never applies credential declaration checks, so these
 * options have no effect on it. Project validation, compile, and runs still
 * use them.
 */
export type ProjectSkillHostDeclarations = Pick<
  LoadProjectPipelineConfigOptions,
  'declaredEnvNames' | 'hostManagedModelAuth'
>;

function emptyNames(): Record<ProjectSkillReferenceKind, Set<string>> {
  return {
    model: new Set(),
    resource: new Set(),
    action: new Set(),
    pipeline: new Set(),
  };
}

export class BobsledProjectSkillReferenceCatalog implements ProjectSkillReferenceCatalog {
  readonly names: ProjectSkillReferenceNames;

  constructor(names: Partial<ProjectSkillReferenceNames>) {
    this.names = {
      model: [...(names.model ?? [])].sort(),
      resource: [...(names.resource ?? [])].sort(),
      action: [...(names.action ?? [])].sort(),
      pipeline: [...(names.pipeline ?? [])].sort(),
    };
  }

  resolve(kind: ProjectSkillReferenceKind, name: string): ProjectSkillReferenceResolution {
    const candidates = this.names[kind];
    if (candidates.includes(name)) return { status: 'found', canonicalName: name };
    if (name.includes('/')) return { status: 'not_found' };

    const bareMatches = candidates.filter((candidate) => candidate.split('/').at(-1) === name);
    if (bareMatches.length === 1) {
      return { status: 'found', canonicalName: bareMatches[0] ?? name };
    }
    if (bareMatches.length > 1) return { status: 'ambiguous', candidates: bareMatches };
    return { status: 'not_found' };
  }
}

/**
 * Names a Project Skill may reference: the project's models, pipelines,
 * resources, and actions, read from the project index wherever the files live,
 * plus the bundled catalog's resources and actions. Structurally invalid
 * pipeline config still fails, but credential declarations are not checked
 * here; Project validation enforces them. The third argument is accepted for
 * compatibility and ignored.
 */
export async function buildProjectSkillReferenceCatalog(
  projectRoot: string,
  index?: ProjectIndex,
  _hostDeclarations: ProjectSkillHostDeclarations = {}
): Promise<BobsledProjectSkillReferenceCatalog> {
  const project = openBobsledProject(projectRoot, index);
  const names = emptyNames();
  const { config } = loadProjectPipelineConfigNames(project.root, project.index);

  const models = discoverProjectModels(config, project);
  for (const modelName of models.keys()) names.model.add(modelName);
  for (const pipelineName of Object.keys(config.pipelines)) names.pipeline.add(pipelineName);

  for (const source of buildCatalogManifest().sources) {
    for (const resource of source.resources) {
      names.resource.add(`${source.name}/${resource.name}`);
    }
  }
  for (const resourceName of discoverProjectResourceNames(project)) {
    names.resource.add(resourceName);
  }

  for (const action of listActions()) names.action.add(action.qualifiedName);
  for (const action of loadActions('', project.index)) {
    names.action.add(action.qualifiedName);
  }

  return new BobsledProjectSkillReferenceCatalog(
    Object.fromEntries(
      REFERENCE_KINDS.map((kind) => [kind, [...names[kind]]])
    ) as ProjectSkillReferenceNames
  );
}
