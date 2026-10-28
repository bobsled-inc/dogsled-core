import { describe, expect, it } from 'vitest';

import { createModelGroup } from '../../../src/groups/model.js';

describe('createModelGroup', () => {
  it('registers the model command shells and global options', () => {
    const group = createModelGroup();

    expect(group.name()).toBe('model');
    expect(group.commands.map((command) => command.name())).toEqual([
      'compile',
      'dry-run',
      'generate',
      'run',
      'profile',
      'test',
      'expect',
      'lineage',
      'init',
      'validate',
      'seed',
      'models',
      'ossie',
    ]);
    expect(group.options.map((option) => option.long)).toEqual(['--verbose', '--quiet']);
  });

  it('renders model help with the delegated command list', () => {
    const help = createModelGroup().helpInformation();

    expect(help).toContain('Usage: model');
    expect(help).toContain('compile [args...]');
    expect(help).toContain('profile [args...]');
    expect(help).toContain('expect [args...]');
    expect(help).toContain('lineage [args...]');
    expect(help).toContain('models [args...]');
    expect(help).toContain('ossie [args...]');
  });
});
