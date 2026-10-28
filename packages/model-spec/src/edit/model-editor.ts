import type { TransformSpec } from '../compiler/schemas.js';
import { TransformSpecSchema } from '../compiler/schemas.js';

import { finishEdit, loadEditableDocument } from './common.js';
import { editOssieDataset, isOssieDocument } from './ossie.js';
import { findEditTarget } from './find-spec-file.js';
import {
  appendItem,
  applyPatch,
  deleteItem,
  findNamedItemIndex,
  getSequenceLength,
} from './yaml-document.js';

import type { EditFileResult, EditOptions, EditResult, FieldMetadataPatch } from './types.js';

const MODEL_COLUMNS_PATH = ['columns'] as const;

export interface ModelColumnFields {
  expr?: string;
  type?: string;
  primary_key?: boolean;
  not_null?: boolean;
}

export type ModelColumnPatch = FieldMetadataPatch & ModelColumnFields;

export interface NewModelColumn extends FieldMetadataPatch, ModelColumnFields {
  name: string;
  expr: string;
}

export interface ModelPatch {
  source?: TransformSpec['source'];
  materialization?: TransformSpec['materialization'];
  description?: string;
  grain?: string | string[];
  tags?: string[];
  owner?: string;
  trust_tier?: string;
}

export interface ModelEditBaseOptions extends EditOptions {
  modelName: string;
}

export interface UpdateModelColumnOptions extends ModelEditBaseOptions {
  columnName: string;
  patch: ModelColumnPatch;
}

export interface AddModelColumnOptions extends ModelEditBaseOptions {
  column: NewModelColumn;
}

export interface RemoveModelColumnOptions extends ModelEditBaseOptions {
  columnName: string;
}

export interface UpdateModelOptions extends ModelEditBaseOptions {
  patch: ModelPatch;
}

export function updateModelColumn(opts: UpdateModelColumnOptions): EditResult<EditFileResult> {
  const prepared = prepareModelEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'model',
      name: opts.modelName,
      action: 'updateField',
      patch: { ...opts.patch },
      columnName: opts.columnName,
    });
  }
  const { filePath, doc } = prepared.data;
  const index = findNamedItemIndex(doc, [...MODEL_COLUMNS_PATH], opts.columnName);
  if (index === -1) {
    return {
      ok: false,
      error: `Column "${opts.columnName}" not found in model "${opts.modelName}"`,
    };
  }
  applyPatch(doc, [...MODEL_COLUMNS_PATH, index], { ...opts.patch });
  return finishEdit(opts, filePath, doc, TransformSpecSchema);
}

export function addModelColumn(opts: AddModelColumnOptions): EditResult<EditFileResult> {
  const prepared = prepareModelEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'model',
      name: opts.modelName,
      action: 'addField',
      column: { ...opts.column },
    });
  }
  const { filePath, doc } = prepared.data;
  if (findNamedItemIndex(doc, [...MODEL_COLUMNS_PATH], opts.column.name) !== -1) {
    return {
      ok: false,
      error: `Column "${opts.column.name}" already exists in model "${opts.modelName}"`,
    };
  }
  const appended = appendItem(doc, [...MODEL_COLUMNS_PATH], { ...opts.column });
  if (!appended.ok) return appended;
  return finishEdit(opts, filePath, doc, TransformSpecSchema);
}

export function removeModelColumn(opts: RemoveModelColumnOptions): EditResult<EditFileResult> {
  const prepared = prepareModelEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'model',
      name: opts.modelName,
      action: 'removeField',
      columnName: opts.columnName,
    });
  }
  const { filePath, doc } = prepared.data;
  const index = findNamedItemIndex(doc, [...MODEL_COLUMNS_PATH], opts.columnName);
  if (index === -1) {
    return {
      ok: false,
      error: `Column "${opts.columnName}" not found in model "${opts.modelName}"`,
    };
  }
  const includeAllColumns = doc.getIn(['include_all_columns']);
  if (includeAllColumns !== true && getSequenceLength(doc, [...MODEL_COLUMNS_PATH]) <= 1) {
    return { ok: false, error: `Cannot remove the last column from model "${opts.modelName}"` };
  }
  const deleted = deleteItem(doc, [...MODEL_COLUMNS_PATH], index);
  if (!deleted.ok) return deleted;
  return finishEdit(opts, filePath, doc, TransformSpecSchema);
}

export function updateModel(opts: UpdateModelOptions): EditResult<EditFileResult> {
  const prepared = prepareModelEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'model',
      name: opts.modelName,
      action: 'updateDataset',
      patch: { ...opts.patch },
    });
  }
  applyPatch(prepared.data.doc, [], { ...opts.patch });
  return finishEdit(opts, prepared.data.filePath, prepared.data.doc, TransformSpecSchema);
}

function prepareModelEdit(opts: ModelEditBaseOptions): EditResult<{
  filePath: string;
  doc: ReturnType<typeof loadEditableDocument> extends EditResult<infer T> ? T : never;
}> {
  const found = findEditTarget(opts, 'model', opts.modelName);
  if (!found.ok) return found;
  const doc = loadEditableDocument(found.data);
  if (!doc.ok) return doc;
  return { ok: true, data: { filePath: found.data, doc: doc.data } };
}
