import { describe, expect, it } from 'vitest';

import { createSetupGroup } from '../../../src/groups/setup.js';

describe('createSetupGroup', () => {
  it('registers the Cowork setup subcommands', () => {
    const group = createSetupGroup();

    expect(group.name()).toBe('setup');
    expect(group.commands.map((command) => command.name())).toEqual([
      'describe',
      'recommend',
      'render',
      'doctor',
      'install',
      'export',
    ]);
  });

  it('renders group help with setup-specific subcommands', () => {
    const help = createSetupGroup().helpInformation();

    expect(help).toContain('Usage: setup');
    expect(help).toContain('recommend');
    expect(help).toContain('doctor');
  });
});
