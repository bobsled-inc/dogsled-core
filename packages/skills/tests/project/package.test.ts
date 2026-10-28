import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { loadProjectSkillPackage, loadProjectSkillPackages } from '../../src/project/index.js';

const entrypoint = `---
name: skill-creator
description: Create and validate agent skills.
license: Apache-2.0
metadata:
  version: "1.0"
---

# Skill creator
`;

describe('loadProjectSkillPackage', () => {
  it('loads nested text and binary resources with a stable package hash', () => {
    const input = {
      entrypointPath: 'skills/skill-creator/SKILL.md',
      entrypoint,
      resources: [
        { path: 'scripts/nested/aggregate.py', content: 'print("ok")\n' },
        { path: 'assets/logo.png', content: Buffer.from([0, 255, 1, 128]) },
        { path: 'references/schema.md', content: '# Schema\n' },
      ],
    };

    const skill = loadProjectSkillPackage(input);
    const reordered = loadProjectSkillPackage({
      ...input,
      resources: [...input.resources].reverse(),
    });

    expect(skill.name).toBe('skill-creator');
    expect(skill.resources?.map((resource) => resource.path)).toEqual([
      'assets/logo.png',
      'references/schema.md',
      'scripts/nested/aggregate.py',
    ]);
    expect(skill.resources?.[0]).toMatchObject({
      path: 'assets/logo.png',
      byteLength: 4,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(skill.packageHash).toMatch(/^[0-9a-f]{64}$/u);
    const canonicalPackageHash = createHash('sha256')
      .update(
        JSON.stringify({
          entrypoint: {
            contentHash: createHash('sha256').update(Buffer.from(entrypoint, 'utf8')).digest('hex'),
            path: input.entrypointPath,
          },
          resources: [
            ...input.resources.map((resource) => {
              const content = Buffer.from(resource.content);
              return {
                byteLength: content.byteLength,
                contentHash: createHash('sha256').update(content).digest('hex'),
                path: resource.path,
              };
            }),
          ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
        }),
        'utf8'
      )
      .digest('hex');
    expect(skill.packageHash).toBe(canonicalPackageHash);
    expect(reordered.packageHash).toBe(skill.packageHash);
    expect(
      loadProjectSkillPackage({
        ...input,
        resources: input.resources.map((resource) =>
          resource.path === 'references/schema.md'
            ? { ...resource, content: '# Changed\n' }
            : resource
        ),
      }).packageHash
    ).not.toBe(skill.packageHash);
  });

  it('requires the entrypoint name to match the package folder', () => {
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/other-name/SKILL.md',
        entrypoint,
      })
    ).toThrow(/must match directory "other-name"/u);
  });

  it('lets the owned Dogsled sidecar override legacy inline triggers and references', () => {
    const inline = `---\nname: skill-creator\ndescription: Create and validate agent skills.\ntriggers:\n  - inline-trigger\nreferences:\n  - kind: model\n    name: inline_model\n---\n`;
    const skill = loadProjectSkillPackage({
      entrypointPath: 'skills/skill-creator/SKILL.md',
      entrypoint: inline,
      resources: [
        {
          path: 'dogsled.yaml',
          content:
            'triggers:\n  - sidecar-trigger\nreferences:\n  - kind: resource\n    name: sidecar_resource\n',
        },
      ],
    });

    expect(skill.triggers).toEqual(['sidecar-trigger']);
    expect(skill.references).toEqual([{ kind: 'resource', name: 'sidecar_resource' }]);
    expect(skill.packageHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('treats an empty Dogsled sidecar as an explicit override', () => {
    const inline = `---\nname: skill-creator\ndescription: Create and validate agent skills.\ntriggers:\n  - inline-trigger\n---\n`;
    const skill = loadProjectSkillPackage({
      entrypointPath: 'skills/skill-creator/SKILL.md',
      entrypoint: inline,
      resources: [{ path: 'dogsled.yaml', content: '{}\n' }],
    });

    expect(skill.triggers).toEqual([]);
    expect(skill.references).toEqual([]);
  });

  it('rejects invalid Dogsled sidecar YAML and unknown keys', () => {
    for (const content of ['triggers: [', 'unknown: true\n']) {
      expect(() =>
        loadProjectSkillPackage({
          entrypointPath: 'skills/skill-creator/SKILL.md',
          entrypoint,
          resources: [{ path: 'dogsled.yaml', content }],
        })
      ).toThrow(/dogsled\.yaml/u);
    }
  });

  it('accepts empty Markdown and legacy underscore names only in compatibility mode', () => {
    const emptyBody = `---\nname: skill-creator\ndescription: Create and validate agent skills.\n---\n`;
    expect(
      loadProjectSkillPackage({
        entrypointPath: 'skills/skill-creator/SKILL.md',
        entrypoint: emptyBody,
      }).content
    ).toBe('');

    const legacy = `---\nname: legacy_skill\ndescription: Existing Skill.\n---\n`;
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/legacy_skill/SKILL.md',
        entrypoint: legacy,
      })
    ).toThrow(/lower-case kebab-case/u);
    expect(
      loadProjectSkillPackage(
        {
          entrypointPath: 'skills/legacy_skill/SKILL.md',
          entrypoint: legacy,
        },
        { allowLegacyName: true }
      ).name
    ).toBe('legacy_skill');
  });

  it('accepts lowercase Unicode names and rejects repeated hyphens in new packages', () => {
    const unicode = `---\nname: 分析\ndescription: Analyze project data.\n---\n`;
    expect(
      loadProjectSkillPackage({
        entrypointPath: 'skills/分析/SKILL.md',
        entrypoint: unicode,
      }).name
    ).toBe('分析');

    const repeatedHyphen = `---\nname: bad--name\ndescription: Existing syntax is invalid for new packages.\n---\n`;
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/bad--name/SKILL.md',
        entrypoint: repeatedHyphen,
      })
    ).toThrow(/lower-case kebab-case/u);
  });

  it.each([
    '../outside.py',
    '/absolute.py',
    'C:/outside.py',
    'c:outside.py',
    'scripts\\escape.py',
    'scripts/./run.py',
  ])('rejects unsafe resource path %s', (resourcePath) => {
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/skill-creator/SKILL.md',
        entrypoint,
        resources: [{ path: resourcePath, content: 'print("unsafe")' }],
      })
    ).toThrow(/invalid relative package path/u);
  });

  it('rejects resource paths that collide after Unicode normalization', () => {
    expect(() =>
      loadProjectSkillPackage({
        entrypointPath: 'skills/skill-creator/SKILL.md',
        entrypoint,
        resources: [
          { path: 'references/cafe\u0301.md', content: 'one' },
          { path: 'references/café.md', content: 'two' },
        ],
      })
    ).toThrow(/duplicate package path/u);
  });

  it('rejects a resource that collides with a noncanonical entrypoint', () => {
    expect(() =>
      loadProjectSkillPackage(
        {
          entrypointPath: 'docs/README.md',
          entrypoint: entrypoint.replaceAll('skill-creator', 'docs'),
          resources: [{ path: 'README.md', content: 'duplicate entrypoint' }],
        },
        { allowNoncanonicalEntrypoint: true }
      )
    ).toThrow(/duplicate package path "README\.md"/u);
  });

  it('rejects duplicate Skill names in a package collection', () => {
    const input = {
      entrypointPath: 'skills/skill-creator/SKILL.md',
      entrypoint,
    };

    expect(() => loadProjectSkillPackages([input, input])).toThrow(/duplicate Skill name/u);
  });

  it('enforces file and total byte limits', () => {
    const input = {
      entrypointPath: 'skills/skill-creator/SKILL.md',
      entrypoint,
      resources: [{ path: 'scripts/run.py', content: '123456' }],
    };

    expect(() => loadProjectSkillPackage(input, { maxFileBytes: 5 })).toThrow(/exceeds 5 bytes/u);
    expect(() => loadProjectSkillPackage(input, { maxTotalBytes: entrypoint.length + 2 })).toThrow(
      /package exceeds/u
    );
  });
});
