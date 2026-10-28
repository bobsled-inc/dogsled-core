import { describe, expect, it } from 'vitest';

import { createLoadGroup } from '../../../src/groups/load.js';

describe('createLoadGroup', () => {
  it('registers the loader command shell', () => {
    const group = createLoadGroup();

    expect(group.name()).toBe('load');
    expect(group.commands.map((command) => command.name())).toEqual([
      'run',
      'assert',
      'check',
      'query',
    ]);
  });

  it('renders loader help', () => {
    const help = createLoadGroup().helpInformation();

    expect(help).toContain('Usage: load');
    expect(help).toContain('run [args...]');
  });
});
