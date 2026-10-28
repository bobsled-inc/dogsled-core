import type { PipelineConfig } from './pipelineExport';
import type { PipelineValidationResult } from './pipeline-validation';

export const PIPELINE_DRAFT_STORAGE_KEY = 'dogsled-explorer-pipeline-config';

export function encodePipelineConfig(config: PipelineConfig): string {
  return encodeURIComponent(btoa(JSON.stringify(config)));
}

export function encodePipelineValidation(validation: PipelineValidationResult): string {
  return encodeURIComponent(btoa(JSON.stringify(validation)));
}
