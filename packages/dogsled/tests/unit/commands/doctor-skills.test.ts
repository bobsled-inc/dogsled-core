import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkProjectSkills } from '../../../src/commands/doctor.js';
import { configureProjectSkillAdapters } from '../../../src/project-skills/adapters.js';

const roots: string[] = [];
const canDropReadPermission = process.platform !== 'win32' && process.getuid?.() !== 0;

function projectWithSkill(document?: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-doctor-skills-'));
  roots.push(root);
  if (document) {
    const directory = path.join(root, 'skills', 'example-skill');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'SKILL.md'), document, 'utf8');
  }
  return root;
}

const validSkill = `---
name: example-skill
description: Example guidance.
---

# Example
`;

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('checkProjectSkills', () => {
  it('accepts the missing skills directory as an empty state', async () => {
    await expect(checkProjectSkills(projectWithSkill())).resolves.toEqual([
      expect.objectContaining({ name: 'project.skills', status: 'ok' }),
    ]);
  });

  it('reports invalid Project Skills as errors', async () => {
    const root = projectWithSkill(validSkill.replace('description:', 'extra: nope\ndescription:'));
    await expect(checkProjectSkills(root)).resolves.toEqual([
      expect.objectContaining({ name: 'project.skills', status: 'error' }),
    ]);
  });

  it('leaves Project guide validation to the dedicated doctor check', async () => {
    const root = projectWithSkill(validSkill);
    writeFileSync(path.join(root, 'AGENTS.md'), '---\ndescription: Only front matter.\n---\n');

    const checks = await checkProjectSkills(root);

    expect(checks[0]).toEqual({
      name: 'project.skills',
      status: 'ok',
      message: '1 Project Skill valid',
    });
    expect(checks).not.toContainEqual(expect.objectContaining({ name: 'project.guide' }));
  });

  it.skipIf(!canDropReadPermission)(
    'reports an unreadable skills directory as an error check',
    async () => {
      const root = projectWithSkill(validSkill);
      const skillsDirectory = path.join(root, 'skills');
      chmodSync(skillsDirectory, 0o000);
      try {
        await expect(checkProjectSkills(root)).resolves.toEqual([
          {
            name: 'project.skills',
            status: 'error',
            message: expect.stringContaining('EACCES'),
          },
        ]);
      } finally {
        chmodSync(skillsDirectory, 0o755);
      }
    }
  );

  it('reports missing adapters and accepts configured adapters', async () => {
    const root = projectWithSkill(validSkill);
    const missing = await checkProjectSkills(root);
    expect(missing).toContainEqual(
      expect.objectContaining({
        name: 'project.skills.adapters.codex.example-skill',
        status: 'error',
      })
    );
    expect(missing).toContainEqual(
      expect.objectContaining({
        name: 'project.skills.adapters.claude.example-skill',
        status: 'error',
      })
    );

    configureProjectSkillAdapters(root);
    const configured = await checkProjectSkills(root);
    expect(configured.every((check) => check.status === 'ok')).toBe(true);
  });
});
