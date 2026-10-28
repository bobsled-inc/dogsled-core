import { createHash } from 'node:crypto';

import {
  normalizeDocumentText,
  parseYamlFrontMatter,
  splitFrontMatter,
  toDocumentIssues,
} from './document.js';
import { ProjectSkillValidationError, projectSkillError } from './errors.js';
import {
  ProjectSkillFrontMatterSchema,
  type ProjectSkill,
  type ProjectSkillPackageMetadata,
} from './schema.js';

export interface ParseProjectSkillOptions {
  /**
   * Folder the caller requires the Skill's `name` to match. Project loaders
   * omit it: a Skill's identity is its declared `name`, wherever it lives.
   */
  directoryName?: string;
  /** Project-relative path of the Skill file; part of the Skill's content hash. */
  filePath: string;
  /** Package-sidecar metadata overrides the corresponding inline fields. */
  packageMetadata?: ProjectSkillPackageMetadata;
}

function hashNormalizedSkill(skill: Omit<ProjectSkill, 'contentHash'>): string {
  const { allowedTools, compatibility, license, metadata, ...legacySkill } = skill;
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...legacySkill,
        references: legacySkill.references.map(({ kind, name }) => ({ kind, name })),
        ...(license === undefined ? {} : { license }),
        ...(compatibility === undefined ? {} : { compatibility }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(allowedTools === undefined ? {} : { allowedTools }),
      })
    )
    .digest('hex');
}

export function parseProjectSkill(
  rawDocument: string,
  options: ParseProjectSkillOptions
): ProjectSkill {
  const split = splitFrontMatter(normalizeDocumentText(rawDocument));
  if (!split) {
    throw projectSkillError(
      options.filePath,
      'missing YAML front matter delimited by lines containing only ---'
    );
  }

  const rawFrontMatter = parseYamlFrontMatter(
    split.frontMatter,
    options.filePath,
    projectSkillError
  );
  const parsed = ProjectSkillFrontMatterSchema.safeParse(rawFrontMatter);
  if (!parsed.success) {
    throw new ProjectSkillValidationError(toDocumentIssues(parsed.error.issues, options.filePath));
  }

  if (options.directoryName !== undefined && parsed.data.name !== options.directoryName) {
    throw projectSkillError(
      options.filePath,
      `front-matter name "${parsed.data.name}" must match directory "${options.directoryName}"`
    );
  }

  const content = split.body.trim();

  const normalized: Omit<ProjectSkill, 'contentHash'> = {
    name: parsed.data.name,
    description: parsed.data.description,
    triggers: options.packageMetadata?.triggers ?? parsed.data.triggers,
    references: options.packageMetadata?.references ?? parsed.data.references,
    content,
    filePath: options.filePath.replaceAll('\\', '/'),
    ...(parsed.data.license === undefined ? {} : { license: parsed.data.license }),
    ...(parsed.data.compatibility === undefined
      ? {}
      : { compatibility: parsed.data.compatibility }),
    ...(parsed.data.metadata === undefined
      ? {}
      : {
          metadata: Object.fromEntries(
            Object.entries(parsed.data.metadata).sort(([a], [b]) => a.localeCompare(b))
          ),
        }),
    ...(parsed.data['allowed-tools'] === undefined
      ? {}
      : { allowedTools: parsed.data['allowed-tools'] }),
  };

  return { ...normalized, contentHash: hashNormalizedSkill(normalized) };
}
