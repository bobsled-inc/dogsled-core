import { describe, expect, it } from 'vitest';

import {
  ProjectSkillValidationError,
  parseProjectGuide,
  toProjectGuideSummary,
  toProjectSkillSummary,
  validateProjectSkillReferences,
  type ProjectGuideSummary,
  type ProjectSkill,
  type ProjectSkillReferenceCatalog,
} from '../../src/project/index.js';

const skill: ProjectSkill = {
  name: 'use-orders',
  description: 'Use orders',
  triggers: [],
  references: [
    { kind: 'model', name: 'orders' },
    { kind: 'resource', name: 'product/users' },
  ],
  content: '# Use orders',
  filePath: 'skills/use-orders/SKILL.md',
  contentHash: 'a'.repeat(64),
};

describe('validateProjectSkillReferences', () => {
  it('accepts references that resolve exactly once', async () => {
    const catalog: ProjectSkillReferenceCatalog = {
      resolve: async (_kind, name) => ({ status: 'found', canonicalName: name }),
    };

    await expect(validateProjectSkillReferences({ skills: [skill] }, catalog)).resolves.toEqual({
      skills: [skill],
    });
  });

  it('reports unknown and ambiguous references', async () => {
    const catalog: ProjectSkillReferenceCatalog = {
      resolve: async (kind) =>
        kind === 'model'
          ? { status: 'not_found' }
          : { status: 'ambiguous', candidates: ['a/users', 'b/users'] },
    };

    await expect(
      validateProjectSkillReferences({ skills: [skill] }, catalog)
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ message: expect.stringContaining('unknown model') }),
        expect.objectContaining({ message: expect.stringContaining('ambiguous resource') }),
      ],
    });
    await expect(
      validateProjectSkillReferences({ skills: [skill] }, catalog)
    ).rejects.toBeInstanceOf(ProjectSkillValidationError);
  });
});

describe('summaries', () => {
  it('drops only the content from a Skill', () => {
    const { content: _content, ...expected } = skill;

    expect(toProjectSkillSummary(skill)).toEqual(expected);
  });

  it('drops only the content from a guide', () => {
    const guide = parseProjectGuide('---\ndescription: Acme guide.\n---\n\n# Guide\n');
    const summary: ProjectGuideSummary = toProjectGuideSummary(guide);

    expect(summary).toEqual({
      path: 'AGENTS.md',
      description: 'Acme guide.',
      contentHash: guide.contentHash,
      byteLength: guide.byteLength,
    });
    expect(summary).not.toHaveProperty('content');
  });
});
