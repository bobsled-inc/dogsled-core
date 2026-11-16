import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
const output = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/output/formatter.js', () => ({
  toOutputOptions: () => ({ json: true }),
  output,
  error: vi.fn(),
}));
import { registerOnboardingCommand } from '../../../src/commands/onboarding.js';
it('exposes the bundled agent guide without needing a project or plugin', async () => {
  const program = new Command();
  registerOnboardingCommand(program);
  await program.parseAsync(['node', 'dogsled', 'onboarding', 'guide']);
  expect(output.mock.calls[0]?.[0]).toMatchObject({
    name: 'bobsled-tutorials',
    content: expect.stringContaining('Teaching contract'),
  });
  expect(output.mock.calls[0]?.[0].content).toContain('end the turn and wait');
  expect(output.mock.calls[0]?.[0].content).toContain('data/tv-night/question.json');
  expect(existsSync(join(output.mock.calls[0]?.[0].templatesPath, 'executor.mjs.txt'))).toBe(true);
});

it('does not expose a tutorial SQL UI launcher', () => {
  const program = new Command();
  registerOnboardingCommand(program);
  const group = program.commands.find((command) => command.name() === 'onboarding');
  expect(group?.commands.map((command) => command.name())).not.toContain('explore');
});

it('offers a checkpoint guard only on the review command', () => {
  const program = new Command();
  registerOnboardingCommand(program);
  const group = program.commands.find((command) => command.name() === 'onboarding')!;
  expect(
    group.commands
      .find((command) => command.name() === 'review')
      ?.options.some((option) => option.long === '--checkpoint')
  ).toBe(true);
  expect(
    group.commands
      .find((command) => command.name() === 'verify')
      ?.options.some((option) => option.long === '--checkpoint')
  ).toBe(false);
});

it('returns equivalent JSON and YAML progress and rejects a mismatched selection', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const YAML = await import('yaml');
  const root = await mkdtemp(join(tmpdir(), 'tutorial-command-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await writeFile(
      join(root, 'data/tv-night/manifest.json'),
      '{"tutorial":"tv-night","version":"1","sources":[]}'
    );
    const run = async (...args: string[]) => {
      output.mockClear();
      const program = new Command().option('--project-root <path>');
      registerOnboardingCommand(program);
      await program.parseAsync(['node', 'dogsled', '--project-root', root, 'onboarding', ...args]);
      return output.mock.calls[0]?.[0];
    };
    const json = await run('status', '--tutorial', 'tv-night');
    expect(json.tutorial).toBe('tv-night');
    expect(YAML.parse(await run('status', '--yaml'))).toEqual(json);
    expect(YAML.parse(await run('status', '--tutorial', 'other', '--yaml'))).toMatchObject({
      ok: false,
      exit_code: 2,
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  } finally {
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  }
});

it('offers a ticket pilot separately from the existing show pilot', () => {
  const program = new Command();
  registerOnboardingCommand(program);
  const verify = program.commands
    .find((command) => command.name() === 'onboarding')!
    .commands.find((command) => command.name() === 'verify')!;
  expect(verify.options.some((option) => option.long === '--ticket-id')).toBe(true);
  expect(verify.options.some((option) => option.long === '--show-id')).toBe(true);
});

it('returns the retail guide and its own read-only templates', async () => {
  output.mockClear();
  const program = new Command();
  registerOnboardingCommand(program);
  await program.parseAsync(['node', 'dogsled', 'onboarding', 'guide', '--tutorial', 'retail']);
  const guide = output.mock.calls[0]?.[0];
  expect(guide.name).toBe('bobsled-retail');
  expect(guide.content).toContain('one pilot');
  expect(guide.templatesPath).toContain('examples/retail/reference');
  expect(existsSync(join(guide.templatesPath, 'model-backed-executor.mjs.txt'))).toBe(true);
});
