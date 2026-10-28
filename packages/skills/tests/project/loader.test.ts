import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectSkillValidationError, loadProjectSkillDocuments } from '../../src/project/index.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-skills-'));
  roots.push(root);
  return root;
}

function addSkill(root: string, name: string, body = '# Guidance'): void {
  const directory = path.join(root, 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} guidance\n---\n\n${body}\n`,
    'utf8'
  );
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('loadProjectSkillDocuments', () => {
  it('returns an empty registry when skills is missing', () => {
    expect(loadProjectSkillDocuments(project())).toEqual({ skills: [] });
  });

  it('loads Skills in stable name order with POSIX relative paths', () => {
    const root = project();
    addSkill(root, 'zebra');
    addSkill(root, 'alpha');

    const result = loadProjectSkillDocuments(root);

    expect(result.skills.map((skill) => skill.name)).toEqual(['alpha', 'zebra']);
    expect(result.skills[0]?.filePath).toBe('skills/alpha/SKILL.md');
  });

  it('loads nested package resources without classifying typed YAML resources as models', () => {
    const root = project();
    const directory = path.join(root, 'skills', 'skill-creator');
    mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    mkdirSync(path.join(directory, 'references'), { recursive: true });
    mkdirSync(path.join(directory, '.config'), { recursive: true });
    mkdirSync(path.join(directory, 'node_modules', 'local-package'), { recursive: true });
    writeFileSync(
      path.join(directory, 'SKILL.md'),
      '---\nname: skill-creator\ndescription: Create Skills.\n---\n\nRead references as needed.\n',
      'utf8'
    );
    writeFileSync(path.join(directory, 'scripts', 'aggregate.py'), 'print("ok")\n', 'utf8');
    writeFileSync(
      path.join(directory, 'references', 'example.yaml'),
      'type: model\nname: skill-resource\n',
      'utf8'
    );
    writeFileSync(path.join(directory, 'assets.bin'), Buffer.from([0, 1, 2, 255]));
    writeFileSync(path.join(directory, '.config', 'settings.json'), '{"mode":"safe"}\n', 'utf8');
    writeFileSync(
      path.join(directory, 'node_modules', 'local-package', 'index.js'),
      'export const value = 1;\n',
      'utf8'
    );

    const result = loadProjectSkillDocuments(root);
    const [skill] = result.skills;

    expect(skill?.resources?.map(({ path }) => path)).toEqual([
      '.config/settings.json',
      'assets.bin',
      'node_modules/local-package/index.js',
      'references/example.yaml',
      'scripts/aggregate.py',
    ]);
    expect(skill?.resources?.find(({ path }) => path === 'assets.bin')).toMatchObject({
      byteLength: 4,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(skill?.packageHash).toMatch(/^[0-9a-f]{64}$/u);

    const originalPackageHash = skill?.packageHash;
    writeFileSync(
      path.join(directory, 'references', 'example.yaml'),
      'type: model\nname: changed-resource\n',
      'utf8'
    );
    expect(loadProjectSkillDocuments(root).skills[0]?.packageHash).not.toBe(originalPackageHash);
  });

  it('keeps the package hash and empty resource inventory for Skills with standard metadata', () => {
    const root = project();
    const directory = path.join(root, 'skills', 'licensed');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'SKILL.md'),
      '---\nname: licensed\ndescription: Licensed guidance.\nlicense: Apache-2.0\n---\n',
      'utf8'
    );

    const [skill] = loadProjectSkillDocuments(root).skills;

    expect(skill?.packageHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(skill?.resources).toEqual([]);
  });

  it('ignores untyped Markdown beside a Skill', () => {
    const root = project();
    addSkill(root, 'alpha');
    writeFileSync(path.join(root, 'skills', 'alpha', 'notes.md'), 'nope');

    expect(loadProjectSkillDocuments(root).skills.map((skill) => skill.name)).toEqual(['alpha']);
  });

  it('loads a typed Skill from any folder and identifies it by its front matter name', () => {
    const root = project();
    mkdirSync(path.join(root, 'datagolf', 'guides'), { recursive: true });
    writeFileSync(
      path.join(root, 'datagolf', 'guides', 'lookup.md'),
      '---\ntype: skill\nname: player-lookup\ndescription: Find players\n---\n\n# Lookup\n',
      'utf8'
    );
    addSkill(root, 'alpha');

    const result = loadProjectSkillDocuments(root);

    expect(result.skills.map((skill) => [skill.name, skill.filePath])).toEqual([
      ['alpha', 'skills/alpha/SKILL.md'],
      ['player-lookup', 'datagolf/guides/lookup.md'],
    ]);
  });

  it('names both files when two Skills share a name', () => {
    const root = project();
    addSkill(root, 'alpha');
    mkdirSync(path.join(root, 'shared'), { recursive: true });
    writeFileSync(
      path.join(root, 'shared', 'alpha.md'),
      '---\ntype: skill\nname: alpha\ndescription: Again\n---\n\nBody\n',
      'utf8'
    );

    expect(() => loadProjectSkillDocuments(root)).toThrow(ProjectSkillValidationError);
    try {
      loadProjectSkillDocuments(root);
    } catch (error) {
      expect((error as ProjectSkillValidationError).issues.map((issue) => issue.message)).toContain(
        'Duplicate Skill name "alpha" in shared/alpha.md and skills/alpha/SKILL.md.'
      );
    }
  });

  it('rejects symbolic links in the authored tree', () => {
    const root = project();
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    mkdirSync(path.join(root, 'outside'));
    writeFileSync(path.join(root, 'outside', 'SKILL.md'), 'outside');
    symlinkSync(path.join(root, 'outside'), path.join(root, 'skills', 'linked'));

    expect(() => loadProjectSkillDocuments(root)).toThrow(/symbolic links/);
  });

  it('skips linked Markdown outside skills/ instead of following it', () => {
    const root = project();
    const outside = project();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(outside, 'guide.md'), '---\ntype: skill\nname: outside\n---\n');
    symlinkSync(path.join(outside, 'guide.md'), path.join(root, 'docs', 'guide.md'));

    expect(loadProjectSkillDocuments(root).skills).toEqual([]);
  });

  it('enforces count, file, and total byte limits', () => {
    const countRoot = project();
    addSkill(countRoot, 'one');
    addSkill(countRoot, 'two');
    expect(() => loadProjectSkillDocuments(countRoot, { maxSkills: 1 })).toThrow(/maximum is 1/);

    const fileRoot = project();
    addSkill(fileRoot, 'large', 'large content');
    expect(() => loadProjectSkillDocuments(fileRoot, { maxFileBytes: 1 })).toThrow(/maximum is 1/);

    const totalRoot = project();
    addSkill(totalRoot, 'large', 'large content');
    expect(() => loadProjectSkillDocuments(totalRoot, { maxTotalBytes: 1 })).toThrow(/exceeds 1/);
  });

  it('reports the total size limit together with the other Skill issues', () => {
    const root = project();
    addSkill(root, 'alpha', 'x'.repeat(200));
    addSkill(root, 'beta');
    addSkill(root, 'gamma');

    let thrown: unknown;
    try {
      loadProjectSkillDocuments(root, { maxFileBytes: 150, maxTotalBytes: 100 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectSkillValidationError);
    expect((thrown as ProjectSkillValidationError).issues).toEqual([
      { path: 'skills/alpha/SKILL.md', message: expect.stringMatching(/maximum is 150$/) },
      { path: 'skills', message: 'total file size exceeds 100 bytes' },
    ]);
  });

  it('rejects invalid UTF-8', () => {
    const root = project();
    const directory = path.join(root, 'skills', 'broken');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'SKILL.md'), Buffer.from([0xff, 0xfe]));

    expect(() => loadProjectSkillDocuments(root)).toThrow(/valid UTF-8/);
  });
});
