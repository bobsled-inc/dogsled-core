import { ProjectSkillValidationError } from './errors.js';
import type {
  ProjectGuide,
  ProjectGuideSummary,
  ProjectSkill,
  ProjectSkillReference,
  ProjectSkillReferenceKind,
  ProjectSkillRegistry,
} from './schema.js';

export type ProjectSkillReferenceResolution =
  | { status: 'found'; canonicalName: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates?: string[] };

export interface ProjectSkillReferenceCatalog {
  resolve(
    kind: ProjectSkillReferenceKind,
    name: string
  ): ProjectSkillReferenceResolution | Promise<ProjectSkillReferenceResolution>;
}

export async function validateProjectSkillReferences(
  registry: ProjectSkillRegistry,
  catalog: ProjectSkillReferenceCatalog
): Promise<ProjectSkillRegistry> {
  const issues: ProjectSkillValidationError['issues'] = [];

  for (const skill of registry.skills) {
    for (const reference of skill.references) {
      const resolution = await catalog.resolve(reference.kind, reference.name);
      if (resolution.status === 'not_found') {
        issues.push({
          path: `${skill.filePath}:references`,
          message: `unknown ${reference.kind} reference "${reference.name}"`,
        });
      } else if (resolution.status === 'ambiguous') {
        const candidates = resolution.candidates?.length
          ? `; use one of: ${resolution.candidates.join(', ')}`
          : '';
        issues.push({
          path: `${skill.filePath}:references`,
          message: `ambiguous ${reference.kind} reference "${reference.name}"${candidates}`,
        });
      }
    }
  }

  if (issues.length > 0) throw new ProjectSkillValidationError(issues);
  return registry;
}

export function toProjectSkillSummary(skill: ProjectSkill): Omit<ProjectSkill, 'content'> {
  const { content: _content, ...summary } = skill;
  return summary;
}

export function toProjectGuideSummary(guide: ProjectGuide): ProjectGuideSummary {
  const { content: _content, ...summary } = guide;
  return summary;
}

export function normalizeProjectSkillReference(reference: ProjectSkillReference): string {
  return `${reference.kind}:${reference.name.toLocaleLowerCase('en-US')}`;
}
