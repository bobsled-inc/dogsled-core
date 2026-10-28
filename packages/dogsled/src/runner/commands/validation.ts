import type { ValidationIssue } from '../config/loader.js';
import type { ValidationResult } from '../config/loader.js';
import {
  validateProjectPipelines,
  type ResolveProjectPipelinesOptions,
} from '../config/project-resolver.js';

export interface StructuredValidationIssue extends ValidationIssue {
  filePath: string;
  fieldPath?: string;
  relatedFilePaths?: string[];
}

type ResolvedProject = Extract<
  Awaited<ReturnType<typeof validateProjectPipelines>>,
  { status: 'valid' }
>['project'];

export interface CliProjectValidation extends Omit<ValidationResult, 'errors'> {
  errors: StructuredValidationIssue[];
  project?: ResolvedProject;
}

export async function validateCliProjectPipelines(
  options: ResolveProjectPipelinesOptions
): Promise<CliProjectValidation> {
  const result = await validateProjectPipelines(options);
  if (result.status === 'invalid') {
    return {
      valid: false,
      errors: result.issues,
      warnings: result.warnings,
      secrets: [],
      pipelines: [],
      modelPipelines: [],
      entityGraphPipelines: [],
    };
  }
  return {
    valid: true,
    errors: [],
    warnings: result.warnings,
    secrets: result.project.secrets,
    pipelines: result.project.extractPipelines,
    modelPipelines: result.project.modelPipelines,
    entityGraphPipelines: result.project.entityGraphPipelines,
    project: result.project,
  };
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}
