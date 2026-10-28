export interface ProjectDocumentIssue {
  path: string;
  message: string;
}

export type ProjectSkillIssue = ProjectDocumentIssue;
export type ProjectGuideIssue = ProjectDocumentIssue;

export class ProjectDocumentValidationError extends Error {
  readonly issues: ProjectDocumentIssue[];

  constructor(issues: ProjectDocumentIssue[], subject: string) {
    super(
      issues.length === 1
        ? `${issues[0]?.path}: ${issues[0]?.message}`
        : `${subject} validation failed with ${issues.length} issues`
    );
    this.name = 'ProjectDocumentValidationError';
    this.issues = issues;
  }
}

export class ProjectSkillValidationError extends ProjectDocumentValidationError {
  constructor(issues: ProjectSkillIssue[], subject = 'Project Skills') {
    super(issues, subject);
    this.name = 'ProjectSkillValidationError';
  }
}

export function projectSkillError(path: string, message: string): ProjectSkillValidationError {
  return new ProjectSkillValidationError([{ path, message }]);
}

export class ProjectGuideValidationError extends ProjectSkillValidationError {
  constructor(issues: ProjectGuideIssue[]) {
    super(issues, 'Project guide');
    this.name = 'ProjectGuideValidationError';
  }
}

export function projectGuideError(path: string, message: string): ProjectGuideValidationError {
  return new ProjectGuideValidationError([{ path, message }]);
}
