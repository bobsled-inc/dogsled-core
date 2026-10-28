import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import { renderSetupFiles, writeRenderedSetupFiles } from '../../../src/setup/render.js';
import { SetupAnswersSchema } from '../../../src/setup/types.js';

import type { RenderedSetupFile } from '../../../src/setup/types.js';

const AGENTS_PATH = 'AGENTS.md';
const STARTER_SKILL_PATH = 'skills/project-overview/SKILL.md';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-setup-preserve-'));
  roots.push(root);
  return root;
}

async function renderExample(): Promise<RenderedSetupFile[]> {
  const answers = SetupAnswersSchema.parse({
    project: { repo_name: 'example', repo_state: 'new' },
    goals: { summary: 'Sync data.' },
    sources: [],
    destination: { type: 'local', format: 'parquet' },
    credentials: { required_secret_refs: [] },
    status: { missing_items: [] },
  });
  return renderSetupFiles(answers);
}

function contentOf(files: RenderedSetupFile[], relativePath: string): string {
  const file = files.find((candidate) => candidate.path === relativePath);
  if (!file) throw new Error(`missing rendered file ${relativePath}`);
  return file.content;
}

describe('writeRenderedSetupFiles', () => {
  it('marks authored files so a re-render does not clobber them', async () => {
    const files = await renderExample();

    expect(files.find((file) => file.path === AGENTS_PATH)?.preserveExisting).toBe(true);
    expect(files.find((file) => file.path === STARTER_SKILL_PATH)?.preserveExisting).toBe(true);
    expect(files.find((file) => file.path === 'dogsled.yml')?.preserveExisting).toBeUndefined();
  });

  it('writes every file into a fresh directory and preserves nothing', async () => {
    const root = createRoot();
    const files = await renderExample();

    const result = writeRenderedSetupFiles(files, root);

    expect(result.written).toEqual(files.map((file) => file.path));
    expect(result.preserved).toEqual([]);
    for (const file of files) {
      expect(readFileSync(path.join(root, file.path), 'utf-8')).toBe(file.content);
    }
  });

  it('leaves a hand-authored AGENTS.md byte-identical', async () => {
    const root = createRoot();
    const files = await renderExample();
    const authored = '# example — Agent Guide\n\nOur data is the customer ledger.\n';
    writeFileSync(path.join(root, AGENTS_PATH), authored, 'utf-8');

    const result = writeRenderedSetupFiles(files, root);

    expect(readFileSync(path.join(root, AGENTS_PATH), 'utf-8')).toBe(authored);
    expect(result.preserved).toEqual([AGENTS_PATH]);
    expect(result.written).not.toContain(AGENTS_PATH);
    expect(result.written).toContain('dogsled.yml');
  });

  it('keeps AGENTS.md symlinked to CLAUDE.md intact and never writes through it', async () => {
    const root = createRoot();
    const files = await renderExample();
    const claude = '# Claude guide\n\nHand-written.\n';
    writeFileSync(path.join(root, 'CLAUDE.md'), claude, 'utf-8');
    symlinkSync('CLAUDE.md', path.join(root, AGENTS_PATH));

    const result = writeRenderedSetupFiles(files, root);

    expect(lstatSync(path.join(root, AGENTS_PATH)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(root, AGENTS_PATH))).toBe('CLAUDE.md');
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8')).toBe(claude);
    expect(result.preserved).toEqual([AGENTS_PATH]);
  });

  it('rejects a wrong-case guide collision instead of reporting it as preserved', () => {
    const root = createRoot();
    writeFileSync(path.join(root, 'agents.md'), '# Wrong case\n', 'utf-8');

    expect(() =>
      writeRenderedSetupFiles(
        [{ path: AGENTS_PATH, content: '# Scaffold\n', preserveExisting: true }],
        root
      )
    ).toThrow(/rename it to match exact casing/);
    expect(readdirSync(root)).toEqual(['agents.md']);
    expect(readFileSync(path.join(root, 'agents.md'), 'utf-8')).toBe('# Wrong case\n');
  });

  it('rejects wrong-case parent directories before writing generated files', async () => {
    const root = createRoot();
    const files = await renderExample();
    mkdirSync(path.join(root, 'Skills'));

    expect(() => writeRenderedSetupFiles(files, root)).toThrow(/existing path casing/);
    expect(existsSync(path.join(root, 'dogsled.yml'))).toBe(false);
  });

  it('preserves an edited starter Skill and still configures adapters', async () => {
    const root = createRoot();
    const files = await renderExample();
    const edited =
      '---\nname: project-overview\ndescription: Edited by hand.\n---\n\n# Edited overview\n\nHand-written guidance.\n';
    mkdirSync(path.join(root, 'skills', 'project-overview'), { recursive: true });
    writeFileSync(path.join(root, STARTER_SKILL_PATH), edited, 'utf-8');

    const result = writeRenderedSetupFiles(files, root);

    expect(readFileSync(path.join(root, STARTER_SKILL_PATH), 'utf-8')).toBe(edited);
    expect(result.preserved).toEqual([STARTER_SKILL_PATH]);
    expect(
      lstatSync(path.join(root, '.agents', 'skills', 'project-overview')).isSymbolicLink()
    ).toBe(true);
  });

  it('overwrites dogsled.yml on a second render and preserves authored files in order', async () => {
    const root = createRoot();
    const files = await renderExample();
    writeRenderedSetupFiles(files, root);
    writeFileSync(path.join(root, 'dogsled.yml'), 'stale: true\n', 'utf-8');

    const result = writeRenderedSetupFiles(files, root);

    expect(readFileSync(path.join(root, 'dogsled.yml'), 'utf-8')).toBe(
      contentOf(files, 'dogsled.yml')
    );
    expect(result.written).toContain('dogsled.yml');
    expect(result.preserved).toEqual([AGENTS_PATH, STARTER_SKILL_PATH]);
  });

  it('refuses to write dogsled.yml through a symbolic link', async () => {
    const root = createRoot();
    const files = await renderExample();
    const target = 'keep: me\n';
    writeFileSync(path.join(root, 'other.yml'), target, 'utf-8');
    symlinkSync('other.yml', path.join(root, 'dogsled.yml'));

    let caught: unknown;
    try {
      writeRenderedSetupFiles(files, root);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).exitCode).toBe(EXIT_VALIDATION);
    expect((caught as CommandError).message).toBe(
      'Refusing to write through symbolic link "dogsled.yml"'
    );
    expect(lstatSync(path.join(root, 'dogsled.yml')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(root, 'other.yml'), 'utf-8')).toBe(target);
    expect(existsSync(path.join(root, 'README.md'))).toBe(false);
  });

  it('rejects non-file generated targets before overwriting earlier files', async () => {
    const root = createRoot();
    const files = await renderExample();
    writeFileSync(path.join(root, 'dogsled.yml'), 'keep: me\n', 'utf-8');
    mkdirSync(path.join(root, 'README.md'));

    expect(() => writeRenderedSetupFiles(files, root)).toThrow(/must be a regular file/);
    expect(readFileSync(path.join(root, 'dogsled.yml'), 'utf-8')).toBe('keep: me\n');
  });

  it('rejects hard-linked generated targets without changing the other link', async () => {
    const root = createRoot();
    const outside = createRoot();
    const files = await renderExample();
    const otherLink = path.join(outside, 'authored.yml');
    writeFileSync(otherLink, 'keep: me\n', 'utf-8');
    linkSync(otherLink, path.join(root, 'dogsled.yml'));

    expect(() => writeRenderedSetupFiles(files, root)).toThrow(/must not be a hard link/);
    expect(readFileSync(otherLink, 'utf-8')).toBe('keep: me\n');
  });

  it('refuses to render through a symbolic-link parent directory', async () => {
    const root = createRoot();
    const outside = createRoot();
    const files = await renderExample();
    symlinkSync(outside, path.join(root, 'docs'), 'dir');

    expect(() => writeRenderedSetupFiles(files, root)).toThrow(CommandError);
    expect(existsSync(path.join(outside, 'cowork-start-here.md'))).toBe(false);
  });

  it('rejects a rendered path that escapes the output directory', () => {
    const root = createRoot();
    const outside = createRoot();
    const escapingPath = path.relative(root, path.join(outside, 'escaped.txt'));

    expect(() =>
      writeRenderedSetupFiles([{ path: escapingPath, content: 'do not write\n' }], root)
    ).toThrow(CommandError);
    expect(existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
  });
});
