import { describe, expect, it } from 'vitest';

import {
  PROJECT_SKILL_GUIDE_SCHEMA_VERSION,
  PROJECT_SKILL_SCHEMA_VERSION,
  PROJECT_SKILL_SCOPED_GUIDE_SCHEMA_VERSION,
  ProjectSkillsManifestV1Schema,
  ProjectSkillsManifestV2Schema,
  ProjectSkillsManifestV3Schema,
  ProjectSkillsManifestV4Schema,
  ProjectSkillsManifestSchema,
  buildProjectSkillDocumentsManifest,
  loadProjectSkillPackage,
  parseProjectGuide,
  type ProjectSkill,
} from '../../src/project/index.js';

function skill(name: string, content: string): ProjectSkill {
  return {
    name,
    description: `${name} description`,
    triggers: [],
    references: [],
    content,
    filePath: `skills/${name}/SKILL.md`,
    contentHash: content
      .padEnd(64, '0')
      .slice(0, 64)
      .replace(/[^a-f0-9]/g, 'a'),
  };
}

describe('buildProjectSkillDocumentsManifest', () => {
  it('builds a self-contained versioned manifest without absolute paths', () => {
    const manifest = buildProjectSkillDocumentsManifest({ skills: [skill('alpha', '# Alpha')] });

    expect(ProjectSkillsManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(PROJECT_SKILL_SCHEMA_VERSION);
    expect(manifest.skills[0]?.content).toBe('# Alpha');
    expect(JSON.stringify(manifest)).not.toContain(process.cwd());
  });

  it('changes the combined hash when one Skill hash changes', () => {
    const first = buildProjectSkillDocumentsManifest({ skills: [skill('alpha', 'a')] });
    const second = buildProjectSkillDocumentsManifest({ skills: [skill('alpha', 'b')] });

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('folds the Project guide into the manifest and its combined hash', () => {
    const registry = { skills: [skill('alpha', '# Alpha')] };
    const guide = parseProjectGuide('# Acme data\n\nRevenue is USD.\n');
    const without = buildProjectSkillDocumentsManifest(registry);
    const withGuide = buildProjectSkillDocumentsManifest(registry, guide);

    expect(ProjectSkillsManifestSchema.parse(withGuide)).toEqual(withGuide);
    expect(without.schemaVersion).toBe(PROJECT_SKILL_SCHEMA_VERSION);
    expect(withGuide.schemaVersion).toBe(PROJECT_SKILL_GUIDE_SCHEMA_VERSION);
    expect(without).not.toHaveProperty('guide');
    expect(withGuide.guide).toEqual(guide);
    expect(withGuide.contentHash).not.toBe(without.contentHash);
    expect(buildProjectSkillDocumentsManifest(registry).contentHash).toBe(without.contentHash);
  });

  it('keeps v1 strict and reserves v2 for manifests carrying a guide', () => {
    const registry = { skills: [skill('alpha', '# Alpha')] };
    const without = buildProjectSkillDocumentsManifest(registry);
    const withGuide = buildProjectSkillDocumentsManifest(registry, parseProjectGuide('# Guide\n'));

    expect(ProjectSkillsManifestV1Schema.parse(without)).toEqual(without);
    expect(ProjectSkillsManifestV2Schema.parse(withGuide)).toEqual(withGuide);
    expect(ProjectSkillsManifestV1Schema.safeParse({ ...without, guide: undefined }).success).toBe(
      false
    );
    expect(() =>
      ProjectSkillsManifestV1Schema.parse({
        ...withGuide,
        schemaVersion: PROJECT_SKILL_SCHEMA_VERSION,
      })
    ).toThrow();
    expect(() =>
      ProjectSkillsManifestV2Schema.parse({
        ...without,
        schemaVersion: PROJECT_SKILL_GUIDE_SCHEMA_VERSION,
      })
    ).toThrow();
  });

  it('requires package fields only in v3 manifests', () => {
    const entrypoint =
      '---\nname: licensed\ndescription: Licensed guidance.\nlicense: Apache-2.0\n---\n';
    const packageSkill = loadProjectSkillPackage({
      entrypointPath: 'skills/licensed/SKILL.md',
      entrypoint,
    });
    const manifest = buildProjectSkillDocumentsManifest({ skills: [packageSkill] });
    const legacy = buildProjectSkillDocumentsManifest({ skills: [skill('alpha', '# Alpha')] });

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.skills[0]).toMatchObject({
      packageHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      resources: [],
    });
    expect(ProjectSkillsManifestV3Schema.parse(manifest)).toEqual(manifest);
    expect(() =>
      ProjectSkillsManifestV1Schema.parse({
        ...legacy,
        skills: [{ ...legacy.skills[0], packageHash: packageSkill.packageHash, resources: [] }],
      })
    ).toThrow();
    expect(() =>
      ProjectSkillsManifestV2Schema.parse({
        ...buildProjectSkillDocumentsManifest(
          { skills: [skill('alpha', '# Alpha')] },
          parseProjectGuide('# Guide\n')
        ),
        skills: [{ ...skill('alpha', '# Alpha'), packageHash: packageSkill.packageHash }],
      })
    ).toThrow();
    expect(() =>
      ProjectSkillsManifestV3Schema.parse({
        ...manifest,
        skills: [{ ...packageSkill, packageHash: undefined, resources: undefined }],
      })
    ).toThrow();
  });

  it('changes the combined hash when only the guide changes', () => {
    const registry = { skills: [] };
    const first = buildProjectSkillDocumentsManifest(registry, parseProjectGuide('# One\n'));
    const second = buildProjectSkillDocumentsManifest(registry, parseProjectGuide('# Two\n'));

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('writes nested guide paths and hashes in the scoped manifest version', () => {
    const rootGuide = parseProjectGuide('# Root context\n');
    const nestedGuide = parseProjectGuide('# PGA context\n', 'golf/datagolf/pga/AGENTS.md');
    const manifest = buildProjectSkillDocumentsManifest({ skills: [] }, rootGuide, {
      guides: [nestedGuide, rootGuide],
      scopedGuides: true,
    });

    expect(manifest.schemaVersion).toBe(PROJECT_SKILL_SCOPED_GUIDE_SCHEMA_VERSION);
    expect(ProjectSkillsManifestV4Schema.parse(manifest)).toEqual(manifest);
    expect(manifest.guides.map(({ path, contentHash }) => [path, contentHash])).toEqual([
      ['AGENTS.md', rootGuide.contentHash],
      ['golf/datagolf/pga/AGENTS.md', nestedGuide.contentHash],
    ]);
    expect(manifest.guides[0]).not.toHaveProperty('content');
  });
});
