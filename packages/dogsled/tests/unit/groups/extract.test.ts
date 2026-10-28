import { describe, expect, it } from 'vitest';

import { createExtractGroup } from '../../../src/groups/extract.js';

describe('createExtractGroup', () => {
  it('registers the extractor command shells and global options', () => {
    const group = createExtractGroup();

    expect(group.name()).toBe('extract');
    expect(group.commands.map((command) => command.name())).toEqual([
      'run',
      'estimate',
      'health-check',
      'discover',
      'validate',
      'init',
      'lookup',
      'topup',
      'generate',
      'check',
      'commit-state',
      'activate',
      'mcp',
      'verify',
      'scaffold-test',
      'smoke-test',
      'test-auth',
    ]);
    expect(group.options.map((option) => option.long)).toEqual([
      '--verbose',
      '--quiet',
      '--log-format',
    ]);
  });

  it('renders group help with the delegated command list', () => {
    const help = createExtractGroup().helpInformation();

    expect(help).toContain('Usage: extract');
    expect(help).toContain('run [args...]');
    expect(help).toContain('health-check [args...]');
    expect(help).toContain('discover [args...]');
    expect(help).toContain('--log-format <format>');
  });
});
