import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProjectSkillsManifest, loadProjectGuide } from '../../../src/project-skills/index.js';

const roots: string[] = [];

function createProject(guide?: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-project-guide-'));
  roots.push(root);
  const skillDirectory = path.join(root, 'skills', 'use-orders');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    path.join(skillDirectory, 'SKILL.md'),
    `---\nname: use-orders\ndescription: Explain how to use orders.\n---\n\n# Use orders\n`,
    'utf8'
  );
  if (guide !== undefined) writeFileSync(path.join(root, 'AGENTS.md'), guide, 'utf8');
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Project guide public interface', () => {
  it('resolves to undefined when the project has no AGENTS.md', async () => {
    await expect(loadProjectGuide(createProject())).resolves.toBeUndefined();
  });

  it('loads the guide and folds it into the Skills manifest', async () => {
    const root = createProject('# Acme data\n\nRevenue is USD.\n');

    const guide = await loadProjectGuide(root);
    const manifest = await buildProjectSkillsManifest(root, { validateReferences: false });

    expect(guide?.content).toBe('# Acme data\n\nRevenue is USD.');
    expect(manifest.guide).toEqual(guide);
    expect(manifest.skills.map((skill) => skill.name)).toEqual(['use-orders']);
  });

  it('keeps the manifest hash stable for a project without a guide', async () => {
    const root = createProject();

    const first = await buildProjectSkillsManifest(root, { validateReferences: false });
    const second = await buildProjectSkillsManifest(root, { validateReferences: false });

    expect(first).not.toHaveProperty('guide');
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('passes the guide byte limit through manifest options', async () => {
    const root = createProject('# Acme data\n\nRevenue is USD.\n');

    await expect(
      buildProjectSkillsManifest(root, { guide: { maxFileBytes: 4 }, validateReferences: false })
    ).rejects.toMatchObject({ name: 'ProjectGuideValidationError' });
  });

  it('skips the guide when guide is false even if AGENTS.md is invalid', async () => {
    const root = createProject('---\ndescription: Only front matter.\n---\n');

    const manifest = await buildProjectSkillsManifest(root, {
      guide: false,
      validateReferences: false,
    });

    expect(manifest).not.toHaveProperty('guide');
    expect(manifest.skills.map((skill) => skill.name)).toEqual(['use-orders']);
  });
});
