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
    name: 'dogsled-get-started',
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
