export type { EditFileResult, EditOptions, EditResult, FieldMetadataPatch } from './types.js';

export {
  applyPatch,
  findNamedItemIndex,
  readYamlDocument,
  serializeDocument,
  writeYamlDocument,
} from './yaml-document.js';
export { findMetadataFile, findModelFile, findSourceFile } from './find-spec-file.js';
export {
  addSourceColumn,
  removeSourceColumn,
  updateSource,
  updateSourceColumn,
  type AddSourceColumnOptions,
  type RemoveSourceColumnOptions,
  type SourceEditBaseOptions,
  type UpdateSourceColumnOptions,
  type UpdateSourceOptions,
} from './source-editor.js';
export {
  addModelColumn,
  removeModelColumn,
  updateModel,
  updateModelColumn,
  type AddModelColumnOptions,
  type ModelEditBaseOptions,
  type ModelColumnPatch,
  type RemoveModelColumnOptions,
  type UpdateModelColumnOptions,
  type UpdateModelOptions,
} from './model-editor.js';
export {
  updateMetric,
  updateRelationship,
  updateVq,
  type MetricPatch,
  type RelationshipPatch,
  type UpdateMetricOptions,
  type UpdateRelationshipOptions,
  type UpdateVqOptions,
  type VqPatch,
} from './metadata-editor.js';
