import { describe, expect, it } from 'vitest';

import { createEmbedGroup } from '../../../src/groups/embed.js';

describe('createEmbedGroup', () => {
  it('registers the embed command shell', () => {
    const group = createEmbedGroup();

    expect(group.name()).toBe('embed');
    expect(group.commands.map((command) => command.name())).toEqual(['run']);
  });

  it('renders embed help', () => {
    const help = createEmbedGroup().helpInformation();

    expect(help).toContain('Usage: embed');
    expect(help).toContain('run [args...]');
  });
});
