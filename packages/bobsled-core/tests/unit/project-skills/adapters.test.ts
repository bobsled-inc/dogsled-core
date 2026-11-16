import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureProjectSkillAdapters,
  inspectProjectSkillAdapters,
  syncProjectSkillAdapters,
} from '../../../src/project-skills/adapters.js';

const roots: string[] = [];

function createProject(suffix = ''): string {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'bobsled-adapters-'));
  roots.push(parent);
  const root = path.join(parent, `project with spaces${suffix}`);
  const skillDirectory = path.join(root, 'skills', 'example-skill');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    path.join(skillDirectory, 'SKILL.md'),
    `---\nname: example-skill\ndescription: Example guidance.\n---\n\n# Example\n`,
    'utf8'
  );
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Project Skill adapters', () => {
  it('creates one relative link for Codex and Claude and is idempotent', () => {
    const root = createProject();

    const created = configureProjectSkillAdapters(root);
    expect(created.ok).toBe(true);
    expect(created.statuses.map((entry) => entry.state)).toEqual(['created', 'created']);

    for (const parent of ['.agents', '.claude']) {
      const link = path.join(root, parent, 'skills', 'example-skill');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe('../../skills/example-skill');
    }

    expect(configureProjectSkillAdapters(root).statuses.map((entry) => entry.state)).toEqual([
      'unchanged',
      'unchanged',
    ]);
  });

  it('preserves unrelated entries and reports unmanaged conflicts', () => {
    const root = createProject();
    const codexDirectory = path.join(root, '.agents', 'skills');
    const claudeDirectory = path.join(root, '.claude', 'skills');
    mkdirSync(path.join(codexDirectory, 'unrelated'), { recursive: true });
    mkdirSync(claudeDirectory, { recursive: true });
    writeFileSync(path.join(claudeDirectory, 'example-skill'), 'mine');

    const report = configureProjectSkillAdapters(root);

    expect(report.ok).toBe(false);
    expect(existsSync(path.join(codexDirectory, 'unrelated'))).toBe(true);
    expect(readFileSync(path.join(claudeDirectory, 'example-skill'), 'utf8')).toBe('mine');
    expect(report.statuses).toContainEqual(
      expect.objectContaining({ agent: 'claude', state: 'conflict' })
    );
  });

  it('creates managed copies only in copy mode and detects local edits', () => {
    const root = createProject();
    const created = configureProjectSkillAdapters(root, { copy: true });
    expect(created.ok).toBe(true);

    const copy = path.join(root, '.agents', 'skills', 'example-skill');
    expect(lstatSync(copy).isDirectory()).toBe(true);
    expect(existsSync(path.join(copy, '.bobsled-project-skill.json'))).toBe(true);

    writeFileSync(path.join(copy, 'SKILL.md'), '# locally edited');
    writeFileSync(
      path.join(root, 'skills', 'example-skill', 'SKILL.md'),
      `---\nname: example-skill\ndescription: Changed guidance.\n---\n\n# Changed\n`,
      'utf8'
    );
    const report = syncProjectSkillAdapters(root);
    expect(report.ok).toBe(false);
    expect(report.statuses).toContainEqual(
      expect.objectContaining({ agent: 'codex', skill: 'example-skill', state: 'conflict' })
    );
    expect(readFileSync(path.join(copy, 'SKILL.md'), 'utf8')).toBe('# locally edited');
    expect(
      readFileSync(path.join(root, '.claude', 'skills', 'example-skill', 'SKILL.md'), 'utf8')
    ).not.toContain('# Changed');
  });

  it('updates stale managed copies', () => {
    const root = createProject();
    configureProjectSkillAdapters(root, { copy: true });
    writeFileSync(
      path.join(root, 'skills', 'example-skill', 'SKILL.md'),
      `---\nname: example-skill\ndescription: Updated guidance.\n---\n\n# Updated\n`,
      'utf8'
    );

    expect(inspectProjectSkillAdapters(root).statuses.map((entry) => entry.state)).toEqual([
      'stale',
      'stale',
    ]);
    const report = syncProjectSkillAdapters(root);
    expect(report.statuses.map((entry) => entry.state)).toEqual(['updated', 'updated']);
    expect(
      readFileSync(path.join(root, '.agents', 'skills', 'example-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Updated');
  });

  it('removes only owned stale adapters after a source Skill is removed', () => {
    const root = createProject();
    configureProjectSkillAdapters(root);
    mkdirSync(path.join(root, '.agents', 'skills', 'unrelated'));
    unlinkSync(path.join(root, '.agents', 'skills', 'example-skill'));
    configureProjectSkillAdapters(root, { copy: true });
    rmSync(path.join(root, 'skills', 'example-skill'), { recursive: true });

    const report = syncProjectSkillAdapters(root);

    expect(report.statuses).toContainEqual(
      expect.objectContaining({ agent: 'codex', state: 'removed' })
    );
    expect(report.statuses).toContainEqual(
      expect.objectContaining({ agent: 'claude', state: 'removed' })
    );
    expect(existsSync(path.join(root, '.agents', 'skills', 'unrelated'))).toBe(true);
  });

  it('copies a Skill authored in any Markdown file and links a data-first SKILL.md folder', () => {
    const root = createProject();
    rmSync(path.join(root, 'skills'), { recursive: true });
    mkdirSync(path.join(root, 'guides'), { recursive: true });
    writeFileSync(
      path.join(root, 'guides', 'review.md'),
      `---\ntype: skill\nname: review\ndescription: Review guidance.\n---\n\n# Review\n`,
      'utf8'
    );
    mkdirSync(path.join(root, 'crm', 'enrich'), { recursive: true });
    writeFileSync(
      path.join(root, 'crm', 'enrich', 'SKILL.md'),
      `---\ntype: skill\nname: enrich\ndescription: Enrich guidance.\n---\n\n# Enrich\n`,
      'utf8'
    );

    const created = configureProjectSkillAdapters(root);

    expect(created.ok).toBe(true);
    expect(
      created.statuses.map(({ agent, skill, mode, state }) => [agent, skill, mode, state])
    ).toEqual([
      ['codex', 'enrich', 'link', 'created'],
      ['codex', 'review', 'copy', 'created'],
      ['claude', 'enrich', 'link', 'created'],
      ['claude', 'review', 'copy', 'created'],
    ]);
    const codex = path.join(root, '.agents', 'skills');
    expect(readlinkSync(path.join(codex, 'enrich'))).toBe('../../crm/enrich');
    expect(lstatSync(path.join(codex, 'review')).isDirectory()).toBe(true);
    expect(readFileSync(path.join(codex, 'review', 'SKILL.md'), 'utf8')).toContain('# Review');
    expect(inspectProjectSkillAdapters(root).statuses.map((entry) => entry.state)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  it('replaces a link with a managed copy when a Skill moves out of a SKILL.md file', () => {
    const root = createProject();
    configureProjectSkillAdapters(root);
    rmSync(path.join(root, 'skills'), { recursive: true });
    mkdirSync(path.join(root, 'guides'), { recursive: true });
    writeFileSync(
      path.join(root, 'guides', 'example.md'),
      `---\ntype: skill\nname: example-skill\ndescription: Example guidance.\n---\n\n# Moved\n`,
      'utf8'
    );

    expect(inspectProjectSkillAdapters(root).statuses.map((entry) => entry.state)).toEqual([
      'stale',
      'stale',
    ]);
    const report = syncProjectSkillAdapters(root);

    expect(report.statuses.map(({ mode, state }) => [mode, state])).toEqual([
      ['copy', 'updated'],
      ['copy', 'updated'],
    ]);
    const copy = path.join(root, '.agents', 'skills', 'example-skill');
    expect(lstatSync(copy).isDirectory()).toBe(true);
    expect(readFileSync(path.join(copy, 'SKILL.md'), 'utf8')).toContain('# Moved');
  });

  it('relinks a Skill folder that moves and refreshes a managed copy after a move', () => {
    const typedSkill = `---\ntype: skill\nname: example-skill\ndescription: Example guidance.\n---\n\n# Example\n`;
    const linked = createProject();
    configureProjectSkillAdapters(linked);
    mkdirSync(path.join(linked, 'crm'), { recursive: true });
    renameSync(path.join(linked, 'skills', 'example-skill'), path.join(linked, 'crm', 'example'));
    writeFileSync(path.join(linked, 'crm', 'example', 'SKILL.md'), typedSkill);

    const relinked = syncProjectSkillAdapters(linked);

    expect(relinked.statuses.map(({ mode, state }) => [mode, state])).toEqual([
      ['link', 'updated'],
      ['link', 'updated'],
    ]);
    expect(readlinkSync(path.join(linked, '.agents', 'skills', 'example-skill'))).toBe(
      '../../crm/example'
    );

    const copied = createProject('-copy');
    configureProjectSkillAdapters(copied, { copy: true });
    mkdirSync(path.join(copied, 'crm'), { recursive: true });
    renameSync(path.join(copied, 'skills', 'example-skill'), path.join(copied, 'crm', 'example'));
    writeFileSync(path.join(copied, 'crm', 'example', 'SKILL.md'), typedSkill);

    expect(inspectProjectSkillAdapters(copied).statuses.map((entry) => entry.state)).toEqual([
      'stale',
      'stale',
    ]);
    expect(
      syncProjectSkillAdapters(copied).statuses.map(({ mode, state }) => [mode, state])
    ).toEqual([
      ['copy', 'updated'],
      ['copy', 'updated'],
    ]);
    expect(inspectProjectSkillAdapters(copied).ok).toBe(true);
  });

  it('keeps an edited managed copy in conflict after its Skill moves', () => {
    const root = createProject();
    configureProjectSkillAdapters(root, { copy: true });
    const copy = path.join(root, '.agents', 'skills', 'example-skill', 'SKILL.md');
    writeFileSync(copy, '# locally edited');
    mkdirSync(path.join(root, 'crm'), { recursive: true });
    renameSync(path.join(root, 'skills', 'example-skill'), path.join(root, 'crm', 'example'));
    writeFileSync(
      path.join(root, 'crm', 'example', 'SKILL.md'),
      `---\ntype: skill\nname: example-skill\ndescription: Example guidance.\n---\n\n# Moved\n`
    );

    const report = syncProjectSkillAdapters(root);

    expect(report.ok).toBe(false);
    expect(report.statuses).toContainEqual(
      expect.objectContaining({ agent: 'codex', skill: 'example-skill', state: 'conflict' })
    );
    expect(readFileSync(copy, 'utf8')).toBe('# locally edited');
  });

  it('removes a link left under an old name when its Skill is renamed', () => {
    const root = createProject();
    configureProjectSkillAdapters(root);
    writeFileSync(
      path.join(root, 'skills', 'example-skill', 'SKILL.md'),
      `---\nname: renamed-skill\ndescription: Example guidance.\n---\n\n# Example\n`,
      'utf8'
    );

    expect(inspectProjectSkillAdapters(root).statuses).toContainEqual(
      expect.objectContaining({ agent: 'codex', skill: 'example-skill', state: 'stale' })
    );
    const report = syncProjectSkillAdapters(root);

    expect(report.statuses).toContainEqual(
      expect.objectContaining({ agent: 'codex', skill: 'example-skill', state: 'removed' })
    );
    expect(existsSync(path.join(root, '.agents', 'skills', 'example-skill'))).toBe(false);
    expect(readlinkSync(path.join(root, '.agents', 'skills', 'renamed-skill'))).toBe(
      '../../skills/example-skill'
    );
  });

  it('refuses to traverse a linked adapter parent', () => {
    const root = createProject();
    const outside = path.join(path.dirname(root), 'outside');
    mkdirSync(outside);
    mkdirSync(path.join(root, '.agents'));
    symlinkSync(outside, path.join(root, '.agents', 'skills'));

    expect(() => configureProjectSkillAdapters(root)).toThrow(/regular directory/);
  });
});
