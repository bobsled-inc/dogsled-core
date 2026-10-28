import { describe, expect, it } from 'vitest';

import { createEntityGraphGroup } from '../../../src/groups/entity-graph.js';

describe('createEntityGraphGroup', () => {
  it('registers the entity-graph command shells and global options', () => {
    const group = createEntityGraphGroup();

    expect(group.name()).toBe('entity-graph');
    expect(group.commands.map((command) => command.name())).toEqual([
      'activate',
      'audit',
      'build',
      'relate',
      'object',
      'explain',
      'forget',
      'get',
      'lineage',
      'match',
      'mentions',
      'pii',
      'policy',
      'relationships',
      'resolve',
      'review',
      'serve',
      'status',
      'survivorship',
      'truthset',
      'agent',
      'quickstart',
      'fixtures',
      'scaffold',
      'diff',
      'suggest',
    ]);
    expect(group.options.map((option) => option.long)).toEqual(['--verbose', '--quiet']);
  });

  it('renders entity-graph help with the delegated command list', () => {
    const help = createEntityGraphGroup().helpInformation();

    expect(help).toContain('Usage: entity-graph');
    expect(help).toContain('build [args...]');
    expect(help).toContain('lineage [args...]');
    expect(help).toContain('mentions [args...]');
    expect(help).toContain('relationships [args...]');
    expect(help).toContain('resolve [args...]');
  });
});
