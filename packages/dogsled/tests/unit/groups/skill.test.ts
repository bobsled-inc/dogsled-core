import { describe, expect, it } from 'vitest';

import { createSkillGroup } from '../../../src/groups/skill.js';

describe('createSkillGroup', () => {
  it('registers the Project Skill commands without a run command', () => {
    const group = createSkillGroup();

    expect(group.name()).toBe('skill');
    expect(group.commands.map((command) => command.name())).toEqual([
      'list',
      'show',
      'validate',
      'configure',
      'sync',
    ]);
  });

  it('shows Project Skill command help', () => {
    const help = createSkillGroup().helpInformation();
    expect(help).toContain('Project Skills');
    expect(help).toContain('configure');
    expect(help).not.toContain(' run ');
  });
});
