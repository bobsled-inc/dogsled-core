import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/runner/commands/validation.js', () => ({
  validateCliProjectPipelines: vi.fn().mockResolvedValue({
    valid: true,
    errors: [],
    warnings: [],
    secrets: [],
    pipelines: [],
    modelPipelines: [],
    entityGraphPipelines: [],
    project: { config: {}, configPaths: [] },
  }),
}));

import { checkProjectGuide, registerDoctorCommand } from '../../../src/commands/doctor.js';
import { AGENT_GUIDE_PLACEHOLDER_SENTENCE } from '../../../src/setup/agent-guide.js';

const roots: string[] = [];
const PROJECT_SKILLS_MODULE = '../../../src/project-skills/index.js';
const canDropReadPermission = process.platform !== 'win32' && process.getuid?.() !== 0;

function project(guide?: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-doctor-guide-'));
  roots.push(root);
  if (guide !== undefined) writeFileSync(path.join(root, 'AGENTS.md'), guide, 'utf8');
  return root;
}

afterEach(async () => {
  vi.doUnmock(PROJECT_SKILLS_MODULE);
  vi.resetModules();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('checkProjectGuide', () => {
  it('accepts a missing guide as an empty state', async () => {
    await expect(checkProjectGuide(project())).resolves.toEqual([
      { name: 'project.guide', status: 'ok', message: 'No Project guide configured' },
    ]);
  });

  it('reports a valid guide with its size', async () => {
    await expect(checkProjectGuide(project('# Acme data\n'))).resolves.toEqual([
      { name: 'project.guide', status: 'ok', message: 'Project guide AGENTS.md valid (12 bytes)' },
    ]);
  });

  it('reports bounded issues for an invalid guide', async () => {
    const checks = await checkProjectGuide(project('---\ndescription: Only front matter.\n---\n'));

    expect(checks).toEqual([
      {
        name: 'project.guide',
        status: 'error',
        message: 'AGENTS.md: Markdown body must not be empty',
      },
    ]);
  });

  it('reports bounded issues for an invalid front-matter description', async () => {
    const checks = await checkProjectGuide(project('---\ndescription: ""\n---\n\n# Acme data\n'));

    expect(checks).toEqual([
      {
        name: 'project.guide',
        status: 'error',
        message: expect.stringContaining('AGENTS.md:description: '),
      },
    ]);
  });

  it('warns when the guide still contains the setup scaffold placeholder', async () => {
    const root = project(
      `# Acme — Agent Guide\n\n## About this data\n\nDescribe the business. ${AGENT_GUIDE_PLACEHOLDER_SENTENCE}\n`
    );

    await expect(checkProjectGuide(root)).resolves.toEqual([
      {
        name: 'project.guide',
        status: 'warn',
        message:
          'Project guide AGENTS.md still contains the setup scaffold placeholder; describe the data before agents rely on it',
      },
    ]);
  });

  it.skipIf(!canDropReadPermission)('reports an unreadable guide as an error check', async () => {
    const root = project('# Acme data\n');
    chmodSync(path.join(root, 'AGENTS.md'), 0o000);

    await expect(checkProjectGuide(root)).resolves.toEqual([
      {
        name: 'project.guide',
        status: 'error',
        message: expect.stringContaining('cannot read file'),
      },
    ]);
  });

  it('reports an unexpected loader failure as an error check', async () => {
    vi.resetModules();
    vi.doMock(PROJECT_SKILLS_MODULE, async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../src/project-skills/index.js')>()),
      loadProjectGuide: async () => {
        throw new Error('disk on fire');
      },
    }));
    const { checkProjectGuide: check } = await import('../../../src/commands/doctor.js');

    await expect(check(project('# Acme data\n'))).resolves.toEqual([
      { name: 'project.guide', status: 'error', message: 'disk on fire' },
    ]);
  });

  it('allows the command to explicitly skip guide validation', async () => {
    const root = project('x'.repeat(32 * 1024 + 1));
    const configPath = path.join(root, 'bobsled.yml');
    writeFileSync(configPath, 'pipelines: {}\n', 'utf8');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousExitCode = process.exitCode;
    const program = new Command();
    program
      .name('dogsled')
      .option('--json', 'Emit JSON', false)
      .option('--verbose', 'Verbose', false)
      .option('--quiet', 'Quiet', false)
      .option('--no-color', 'Disable ANSI colour codes');
    registerDoctorCommand(program);

    try {
      await program.parseAsync(['doctor', '--json', '--config', configPath, '--no-guide'], {
        from: 'user',
      });
      const payload = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join('')) as {
        checks: Array<{ name: string; status: string; message: string }>;
      };

      expect(payload.checks).toContainEqual({
        name: 'project.guide',
        status: 'ok',
        message: 'Project guide validation skipped by --no-guide',
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
