import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProjectSkillsManifest,
  getProjectSkill,
  loadProjectSkills,
  validateProjectSkills,
  type ProjectSkillsOptions,
  type ProjectSkillReferenceCatalog,
} from '../../../src/project-skills/index.js';

const roots: string[] = [];

function createProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-project-skills-'));
  roots.push(root);
  const skillDirectory = path.join(root, 'skills', 'use-orders');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    path.join(skillDirectory, 'SKILL.md'),
    `---
name: use-orders
description: Explain how to use orders.
references:
  - kind: model
    name: orders
---

# Use orders
`,
    'utf8'
  );
  return root;
}

const catalog: ProjectSkillReferenceCatalog = {
  resolve: (_kind, name) => ({ status: 'found', canonicalName: name }),
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Project Skills public interface', () => {
  it('loads and validates Skills with an injected catalog', async () => {
    const result = await loadProjectSkills(createProject(), { referenceCatalog: catalog });
    expect(result.skills.map((skill) => skill.name)).toEqual(['use-orders']);
  });

  it('does not load project catalogs when no Skill declares references', async () => {
    const root = createProject();
    writeFileSync(
      path.join(root, 'skills', 'use-orders', 'SKILL.md'),
      `---\nname: use-orders\ndescription: Use orders.\n---\n\n# Use orders\n`,
      'utf8'
    );
    writeFileSync(path.join(root, 'bobsled.yml'), 'not: a valid Dogsled config\n', 'utf8');

    await expect(loadProjectSkills(root)).resolves.toMatchObject({
      skills: [{ name: 'use-orders' }],
    });
  });

  it('gets one Skill and returns undefined for an unknown name', async () => {
    const root = createProject();
    await expect(
      getProjectSkill(root, 'use-orders', { referenceCatalog: catalog })
    ).resolves.toMatchObject({
      name: 'use-orders',
      content: '# Use orders',
    });
    await expect(
      getProjectSkill(root, 'missing', { referenceCatalog: catalog })
    ).resolves.toBeUndefined();
  });

  it('validates and builds a self-contained manifest', async () => {
    const root = createProject();
    await expect(validateProjectSkills(root, { referenceCatalog: catalog })).resolves.toMatchObject(
      {
        skills: [{ name: 'use-orders' }],
      }
    );
    await expect(
      buildProjectSkillsManifest(root, { referenceCatalog: catalog })
    ).resolves.toMatchObject({
      schemaVersion: 1,
      skills: [{ name: 'use-orders', content: '# Use orders' }],
    });
  });

  it.each([
    [
      'loadProjectSkills',
      (root: string, options: ProjectSkillsOptions) => loadProjectSkills(root, options),
    ],
    [
      'getProjectSkill',
      (root: string, options: ProjectSkillsOptions) => getProjectSkill(root, 'use-orders', options),
    ],
    [
      'validateProjectSkills',
      (root: string, options: ProjectSkillsOptions) => validateProjectSkills(root, options),
    ],
  ])('honors guide options in %s', async (_name, invoke) => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), '# Guide\n', 'utf8');
    const baseOptions = { referenceCatalog: catalog };

    await expect(
      invoke(root, { ...baseOptions, guide: { maxFileBytes: 4 } })
    ).rejects.toMatchObject({ name: 'ProjectGuideValidationError' });
    await expect(invoke(root, { ...baseOptions, guide: false })).resolves.toBeDefined();
  });
});
