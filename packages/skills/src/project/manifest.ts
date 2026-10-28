import { createHash } from 'node:crypto';

import {
  PROJECT_SKILL_GUIDE_SCHEMA_VERSION,
  PROJECT_SKILL_PACKAGE_SCHEMA_VERSION,
  PROJECT_SKILL_SCOPED_GUIDE_SCHEMA_VERSION,
  PROJECT_SKILL_SCHEMA_VERSION,
  ProjectSkillsManifestSchema,
  type ProjectGuide,
  type ProjectSkillRegistry,
  type ProjectSkillsManifest,
} from './schema.js';

export function buildProjectSkillDocumentsManifest(
  registry: ProjectSkillRegistry,
  guide?: ProjectGuide,
  options: { guides?: readonly ProjectGuide[]; scopedGuides?: boolean } = {}
): ProjectSkillsManifest {
  const skills = registry.skills.map((skill) => ({
    ...skill,
    filePath: skill.filePath.replaceAll('\\', '/'),
  }));
  const skillHashes = skills.map(
    ({ contentHash: skillHash, packageHash }) => packageHash ?? skillHash
  );
  const guides = [...(options.guides ?? (guide ? [guide] : []))].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const scopedGuides = options.scopedGuides === true;
  const hashInputs = scopedGuides
    ? [...skillHashes, ...guides.map((entry) => `guide:${entry.path}:${entry.contentHash}`)]
    : guide
      ? [...skillHashes, `guide:${guide.contentHash}`]
      : skillHashes;
  const contentHash = createHash('sha256').update(JSON.stringify(hashInputs)).digest('hex');
  const usesPackageSchema = skills.some(
    (skill) =>
      skill.packageHash !== undefined ||
      skill.resources !== undefined ||
      skill.license !== undefined ||
      skill.compatibility !== undefined ||
      skill.metadata !== undefined ||
      skill.allowedTools !== undefined
  );

  if (scopedGuides) {
    return ProjectSkillsManifestSchema.parse({
      schemaVersion: PROJECT_SKILL_SCOPED_GUIDE_SCHEMA_VERSION,
      contentHash,
      skills,
      guides: guides.map(({ content: _content, ...metadata }) => metadata),
    });
  }

  return ProjectSkillsManifestSchema.parse({
    schemaVersion: usesPackageSchema
      ? PROJECT_SKILL_PACKAGE_SCHEMA_VERSION
      : guide
        ? PROJECT_SKILL_GUIDE_SCHEMA_VERSION
        : PROJECT_SKILL_SCHEMA_VERSION,
    contentHash,
    skills,
    ...(guide ? { guide } : {}),
  });
}
