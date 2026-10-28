import { describe, expect, it } from 'vitest';

import { createMcpGroup } from '../../../src/groups/mcp.js';

describe('createMcpGroup', () => {
  it('registers the mcp command alias shells and global options', () => {
    const group = createMcpGroup();

    expect(group.name()).toBe('mcp');
    expect(group.commands.map((command) => command.name())).toContain('discover');
    expect(group.commands.map((command) => command.name())).toContain('list-builders');
    expect(group.commands.map((command) => command.name())).toContain('serve');
    expect(group.options.map((option) => option.long)).toEqual([
      '--verbose',
      '--quiet',
      '--log-format',
    ]);
  });
});
