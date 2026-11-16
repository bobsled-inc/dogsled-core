import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import { resolveSkillProjectRoot } from '../../../src/commands/skill.js';
import { runCli } from '../../../src/index.js';

const roots: string[] = [];
const originalCwd = process.cwd();

const VALID_SKILL = `---\nname: example-skill\ndescription: Example guidance.\n---\n\n# Example guidance\n`;
const INVALID_GUIDE = '---\ndescription: Only front matter.\n---\n';
const DESCRIBED_GUIDE =
  '---\ndescription: What the Acme data means.\n---\n\n# Acme data\n\nRevenue is USD.\n';
const EMPTY_BODY_ISSUE = { path: 'AGENTS.md', message: 'Markdown body must not be empty' };

function createRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-skill-command-'));
  roots.push(root);
  return root;
}

function createProject(skillDocument = VALID_SKILL): string {
  const root = createRoot();
  const directory = path.join(root, 'skills', 'example-skill');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'SKILL.md'), skillDocument, 'utf8');
  return root;
}

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('');
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('dogsled skill commands', () => {
  it('lists summaries without Markdown bodies', async () => {
    process.chdir(createProject());
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'list']);

    const payload = JSON.parse(stdoutText(stdout)) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ name: 'example-skill', description: 'Example guidance.' });
    expect(payload[0]).not.toHaveProperty('content');
  });

  it('shows the full Markdown body', async () => {
    process.chdir(createProject());
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'show', 'example-skill']);

    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      name: 'example-skill',
      content: '# Example guidance',
    });
  });

  it('keeps list and show scoped to Skills when the Project guide is invalid', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), INVALID_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'list']);
    expect(JSON.parse(stdoutText(stdout))).toEqual([
      expect.objectContaining({ name: 'example-skill' }),
    ]);

    stdout.mockClear();
    await runCli(['--json', 'skill', 'show', 'example-skill']);
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({ name: 'example-skill' });
  });

  it('emits equivalent YAML validation data', async () => {
    process.chdir(createProject());
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['skill', 'validate', '--yaml']);

    expect(YAML.parse(stdoutText(stdout))).toMatchObject({
      ok: true,
      count: 1,
      skills: [{ name: 'example-skill' }],
    });
  });

  it('validates the Project guide beside the Skills', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), '# Acme data\n\nRevenue is USD.\n', 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate']);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      ok: true,
      count: 1,
      guide: { path: 'AGENTS.md', byteLength: 29 },
    });
  });

  it('uses exit code 2 and structured issues for an invalid Project guide', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), INVALID_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate']);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      ok: false,
      issues: [EMPTY_BODY_ISSUE],
    });
  });

  it('validates the Project guide when a Skill name is given', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), INVALID_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate', 'example-skill']);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(stdout))).toEqual({ ok: false, issues: [EMPTY_BODY_ISSUE] });
  });

  it('allows guide validation to be explicitly skipped', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), INVALID_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate', '--no-guide']);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({ ok: true, guide: null });
  });

  it('reports Skill and Project guide issues together', async () => {
    const root = createProject(VALID_SKILL.replace('description:', 'extra: nope\ndescription:'));
    writeFileSync(path.join(root, 'AGENTS.md'), INVALID_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate']);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(stdout))).toEqual({
      ok: false,
      issues: [
        {
          path: expect.stringContaining('skills/example-skill/SKILL.md'),
          message: expect.stringContaining('extra'),
        },
        EMPTY_BODY_ISSUE,
      ],
    });
  });

  it('reports the guide description without its Markdown body', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), DESCRIBED_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate']);

    expect(process.exitCode).toBeUndefined();
    const payload = JSON.parse(stdoutText(stdout)) as { guide: Record<string, unknown> };
    expect(payload.guide).toEqual({
      path: 'AGENTS.md',
      description: 'What the Acme data means.',
      contentHash: expect.any(String),
      byteLength: Buffer.byteLength(DESCRIBED_GUIDE, 'utf8'),
    });
    expect(payload.guide).not.toHaveProperty('content');
  });

  it('reports a null guide when the project has no AGENTS.md', async () => {
    process.chdir(createProject());
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate']);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(stdoutText(stdout))).toEqual({
      ok: true,
      count: 1,
      skills: [{ name: 'example-skill', contentHash: expect.any(String) }],
      guide: null,
    });
  });

  it('emits equivalent YAML and JSON guide data', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), DESCRIBED_GUIDE, 'utf8');
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate']);
    const fromJson = JSON.parse(stdoutText(stdout)) as Record<string, unknown>;
    stdout.mockClear();
    await runCli(['skill', 'validate', '--yaml']);
    const fromYaml = YAML.parse(stdoutText(stdout)) as Record<string, unknown>;

    expect(fromYaml).toEqual(fromJson);
    expect(fromYaml).toMatchObject({ guide: { description: 'What the Acme data means.' } });
  });

  it('uses an explicit project root for guide-only validation', async () => {
    const root = createRoot();
    writeFileSync(path.join(root, 'AGENTS.md'), INVALID_GUIDE, 'utf8');
    const nested = path.join(root, 'notes', 'deeper');
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'validate', '--project-root', root]);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(stdout))).toEqual({ ok: false, issues: [EMPTY_BODY_ISSUE] });
  });

  it('prints the guide status in text mode', async () => {
    const root = createProject();
    writeFileSync(path.join(root, 'AGENTS.md'), DESCRIBED_GUIDE, 'utf8');
    process.chdir(root);
    vi.stubEnv('BOBSLED_CORE_OUTPUT_FORMAT', 'text');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['skill', 'validate']);

    expect(process.exitCode).toBeUndefined();
    expect(stdoutText(stdout)).toContain('1 Project Skill valid.');
    expect(stdoutText(stdout)).toContain('Project guide AGENTS.md valid.');
  });

  it('prints an info line in text mode when no Project guide exists', async () => {
    process.chdir(createProject());
    vi.stubEnv('BOBSLED_CORE_OUTPUT_FORMAT', 'text');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['skill', 'validate']);

    expect(process.exitCode).toBeUndefined();
    expect(stdoutText(stdout)).toContain('1 Project Skill valid.');
    expect(stdoutText(stdout)).toContain('No Project guide found.');
  });

  it('uses exit code 2 and structured issues for an unknown Skill', async () => {
    process.chdir(createProject());
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'show', 'missing']);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(stdout))).toMatchObject({
      ok: false,
      issues: [{ path: 'skills', message: expect.stringContaining('missing') }],
    });
  });

  it('configures and syncs both agent adapters', async () => {
    const root = createProject();
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(['--json', 'skill', 'configure']);
    const configured = JSON.parse(stdoutText(stdout)) as { ok: boolean; statuses: unknown[] };
    expect(configured.ok).toBe(true);
    expect(configured.statuses).toHaveLength(2);

    stdout.mockClear();
    await runCli(['--json', 'skill', 'sync']);
    const synced = JSON.parse(stdoutText(stdout)) as { ok: boolean; statuses: unknown[] };
    expect(synced.ok).toBe(true);
    expect(synced.statuses).toHaveLength(2);
  });
});

describe('resolveSkillProjectRoot', () => {
  it('uses the supplied working directory even when an ancestor has a Dogsled config', () => {
    const root = createRoot();
    writeFileSync(path.join(root, 'bobsled.yml'), 'pipelines: {}\n', 'utf8');
    const nested = path.join(root, 'notes', 'skills');
    mkdirSync(nested, { recursive: true });

    expect(resolveSkillProjectRoot(undefined, nested)).toBe(nested);
  });

  it('does not search ancestor directories for a legacy config by default', () => {
    const root = createRoot();
    const nested = path.join(root, 'notes', 'skills');
    mkdirSync(nested, { recursive: true });

    expect(resolveSkillProjectRoot(undefined, nested)).toBe(nested);
  });

  it('uses an explicit project root', () => {
    const root = createRoot();
    const nestedProject = path.join(root, 'nested');
    const startDir = path.join(nestedProject, 'deeper');
    mkdirSync(startDir, { recursive: true });

    expect(resolveSkillProjectRoot(undefined, startDir, nestedProject)).toBe(nestedProject);
  });
});
