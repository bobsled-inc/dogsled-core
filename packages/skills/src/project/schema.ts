import { z } from 'zod';

export const PROJECT_SKILL_SCHEMA_VERSION = 1 as const;
export const PROJECT_SKILL_GUIDE_SCHEMA_VERSION = 2 as const;
export const PROJECT_SKILL_PACKAGE_SCHEMA_VERSION = 3 as const;
export const PROJECT_SKILL_SCOPED_GUIDE_SCHEMA_VERSION = 4 as const;

export const PROJECT_SKILL_MAX_COUNT = 100;
export const PROJECT_SKILL_MAX_FILE_BYTES = 1024 * 1024;
export const PROJECT_SKILL_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const PROJECT_SKILL_MAX_PACKAGE_FILES = 2_000;

export const PROJECT_GUIDE_FILE_NAME = 'AGENTS.md' as const;
export const PROJECT_GUIDE_MAX_FILE_BYTES = 32 * 1024;

export const ProjectSkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[\p{Ll}\p{Lo}\p{Lm}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Lm}\p{Nd}]+)*$/u,
    'must use lower-case kebab-case'
  );

const ProjectSkillLegacyNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(?:[\p{Ll}\p{Lo}\p{Lm}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Lm}\p{Nd}]+)*|[a-z0-9][a-z0-9_-]{0,63})$/u
  );

export const ProjectSkillReferenceKindSchema = z.enum(['model', 'resource', 'action', 'pipeline']);

export const ProjectSkillReferenceSchema = z
  .object({
    kind: ProjectSkillReferenceKindSchema,
    name: z.string().trim().min(1).max(256),
  })
  .strict();

export const ProjectSkillPackageMetadataSchema = z
  .object({
    triggers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    references: z.array(ProjectSkillReferenceSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const triggers = new Set<string>();
    value.triggers.forEach((trigger, index) => {
      const normalized = trigger.toLocaleLowerCase('en-US');
      if (triggers.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate trigger after trimming and case folding',
          path: ['triggers', index],
        });
      }
      triggers.add(normalized);
    });

    const references = new Set<string>();
    value.references.forEach((reference, index) => {
      const normalized = `${reference.kind}\u0000${reference.name.toLocaleLowerCase('en-US')}`;
      if (references.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate reference after canonical normalization',
          path: ['references', index],
        });
      }
      references.add(normalized);
    });
  });

export const ProjectSkillFrontMatterSchema = z
  .object({
    /** Required outside `skills/<name>/SKILL.md`; optional there. */
    type: z.literal('skill').optional(),
    name: ProjectSkillLegacyNameSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().optional(),
    triggers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    references: z.array(ProjectSkillReferenceSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const triggers = new Set<string>();
    value.triggers.forEach((trigger, index) => {
      const normalized = trigger.toLocaleLowerCase('en-US');
      if (triggers.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate trigger after trimming and case folding',
          path: ['triggers', index],
        });
      }
      triggers.add(normalized);
    });

    const references = new Set<string>();
    value.references.forEach((reference, index) => {
      const normalized = `${reference.kind}\u0000${reference.name.toLocaleLowerCase('en-US')}`;
      if (references.has(normalized)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate reference after canonical normalization',
          path: ['references', index],
        });
      }
      references.add(normalized);
    });
  });

export const ProjectSkillResourceSchema = z
  .object({
    path: z.string().min(1).max(1024),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export const ProjectSkillSchema = z
  .object({
    name: ProjectSkillLegacyNameSchema,
    description: z.string().min(1).max(1024),
    license: z.string().min(1).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    allowedTools: z.string().optional(),
    triggers: z.array(z.string()),
    references: z.array(ProjectSkillReferenceSchema),
    content: z.string(),
    filePath: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    packageHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    resources: z.array(ProjectSkillResourceSchema).optional(),
  })
  .strict();

const ProjectSkillLegacyManifestSchema = ProjectSkillSchema.omit({
  packageHash: true,
  resources: true,
}).strict();

const ProjectSkillPackageManifestSchema = ProjectSkillSchema.extend({
  packageHash: z.string().regex(/^[0-9a-f]{64}$/),
  resources: z.array(ProjectSkillResourceSchema),
}).strict();

export const ProjectGuideFrontMatterSchema = z.object({
  type: z.literal('guide').optional(),
  description: z.string().trim().min(1).max(500).optional(),
});

export const ProjectGuideSchema = z
  .object({
    path: z.string().min(1).max(1024),
    description: z.string().min(1).max(500).optional(),
    content: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const ProjectRootGuideSchema = ProjectGuideSchema.extend({
  path: z.literal(PROJECT_GUIDE_FILE_NAME),
}).strict();

export const ProjectSkillsManifestV1Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_SKILL_SCHEMA_VERSION),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    skills: z.array(ProjectSkillLegacyManifestSchema),
  })
  .strict();

export const ProjectSkillsManifestV2Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_SKILL_GUIDE_SCHEMA_VERSION),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    skills: z.array(ProjectSkillLegacyManifestSchema),
    guide: ProjectRootGuideSchema,
  })
  .strict();

export const ProjectSkillsManifestV3Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_SKILL_PACKAGE_SCHEMA_VERSION),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    skills: z.array(ProjectSkillPackageManifestSchema),
    guide: ProjectRootGuideSchema.optional(),
  })
  .strict();

export const ProjectSkillsManifestV4Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_SKILL_SCOPED_GUIDE_SCHEMA_VERSION),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    skills: z.array(z.union([ProjectSkillLegacyManifestSchema, ProjectSkillPackageManifestSchema])),
    guides: z.array(ProjectGuideSchema.omit({ content: true })),
  })
  .strict();

export const ProjectSkillsManifestSchema = z.discriminatedUnion('schemaVersion', [
  ProjectSkillsManifestV1Schema,
  ProjectSkillsManifestV2Schema,
  ProjectSkillsManifestV3Schema,
  ProjectSkillsManifestV4Schema,
]);

export type ProjectSkillReferenceKind = z.infer<typeof ProjectSkillReferenceKindSchema>;
export type ProjectSkillReference = z.infer<typeof ProjectSkillReferenceSchema>;
export type ProjectSkillPackageMetadata = z.infer<typeof ProjectSkillPackageMetadataSchema>;
export type ProjectSkillResource = z.infer<typeof ProjectSkillResourceSchema>;
export type ProjectSkillFrontMatter = z.infer<typeof ProjectSkillFrontMatterSchema>;
export type ProjectSkill = z.infer<typeof ProjectSkillSchema>;
export type ProjectSkillsManifestV1 = z.infer<typeof ProjectSkillsManifestV1Schema>;
export type ProjectSkillsManifestV2 = z.infer<typeof ProjectSkillsManifestV2Schema>;
export type ProjectSkillsManifestV3 = z.infer<typeof ProjectSkillsManifestV3Schema>;
export type ProjectSkillsManifestV4 = z.infer<typeof ProjectSkillsManifestV4Schema>;
export type ProjectSkillsManifest =
  | (ProjectSkillsManifestV1 & { guide?: never })
  | ProjectSkillsManifestV2
  | ProjectSkillsManifestV3
  | ProjectSkillsManifestV4;

export type ProjectSkillSummary = Omit<ProjectSkill, 'content'>;

export type ProjectGuideFrontMatter = z.infer<typeof ProjectGuideFrontMatterSchema>;
export type ProjectGuide = z.infer<typeof ProjectGuideSchema>;
export type ProjectGuideSummary = Omit<ProjectGuide, 'content'>;

export interface ProjectSkillRegistry {
  skills: ProjectSkill[];
}
