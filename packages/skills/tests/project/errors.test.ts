import { describe, expect, it } from 'vitest';

import {
  ProjectDocumentValidationError,
  ProjectGuideValidationError,
  ProjectSkillValidationError,
  type ProjectDocumentIssue,
} from '../../src/project/index.js';

const issue: ProjectDocumentIssue = { path: 'AGENTS.md', message: 'bad' };
const other: ProjectDocumentIssue = { path: 'skills/a/SKILL.md', message: 'worse' };

describe('ProjectDocumentValidationError', () => {
  it('formats a single issue as path: message and many issues with the subject', () => {
    const single = new ProjectDocumentValidationError([issue], 'Anything');
    const many = new ProjectDocumentValidationError([issue, other], 'Anything');

    expect(single).toBeInstanceOf(Error);
    expect(single.name).toBe('ProjectDocumentValidationError');
    expect(single.message).toBe('AGENTS.md: bad');
    expect(single.issues).toEqual([issue]);
    expect(many.message).toBe('Anything validation failed with 2 issues');
    expect(many.issues).toEqual([issue, other]);
  });

  it('keeps guide errors compatible with existing Project Skill error handlers', () => {
    const skill = new ProjectSkillValidationError([issue, other]);
    const guide = new ProjectGuideValidationError([issue, other]);

    expect(skill).toBeInstanceOf(ProjectDocumentValidationError);
    expect(guide).toBeInstanceOf(ProjectDocumentValidationError);
    expect(skill).not.toBeInstanceOf(ProjectGuideValidationError);
    expect(guide).toBeInstanceOf(ProjectSkillValidationError);
    expect(skill.name).toBe('ProjectSkillValidationError');
    expect(guide.name).toBe('ProjectGuideValidationError');
    expect(skill.message).toBe('Project Skills validation failed with 2 issues');
    expect(guide.message).toBe('Project guide validation failed with 2 issues');
    expect(new ProjectSkillValidationError([issue]).message).toBe('AGENTS.md: bad');
    expect(new ProjectGuideValidationError([other]).message).toBe('skills/a/SKILL.md: worse');
  });
});
