import { SourceSpecSchema } from '../compiler/schemas.js';

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

const SOURCE_COLUMNS_PATH = ['schema', 'columns'] as const;

export interface SourceEditBaseOptions extends EditOptions {
  sourceName: string;
  connection: string;
}

export interface UpdateSourceColumnOptions extends SourceEditBaseOptions {
  columnName: string;
  patch: FieldMetadataPatch;
}

export interface AddSourceColumnOptions extends SourceEditBaseOptions {
  column: { name: string; type: string } & FieldMetadataPatch;
}

export interface RemoveSourceColumnOptions extends SourceEditBaseOptions {
  columnName: string;
}

export interface UpdateSourceOptions extends SourceEditBaseOptions {
  patch: Partial<{ description: string; trust_tier: string }>;
}

export function updateSourceColumn(opts: UpdateSourceColumnOptions): EditResult<EditFileResult> {
  const prepared = prepareSourceEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'source',
      name: opts.sourceName,
      action: 'updateField',
      patch: { ...opts.patch },
      columnName: opts.columnName,
    });
  }
  const { filePath, doc } = prepared.data;
  const index = findNamedItemIndex(doc, [...SOURCE_COLUMNS_PATH], opts.columnName);
  if (index === -1) {
    return {
      ok: false,
      error: `Column "${opts.columnName}" not found in source "${opts.sourceName}"`,
    };
  }
  applyPatch(doc, [...SOURCE_COLUMNS_PATH, index], opts.patch);
  return finishEdit(opts, filePath, doc, SourceSpecSchema);
}

export function addSourceColumn(opts: AddSourceColumnOptions): EditResult<EditFileResult> {
  const prepared = prepareSourceEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'source',
      name: opts.sourceName,
      action: 'addField',
      column: { ...opts.column },
    });
  }
  const { filePath, doc } = prepared.data;
  if (findNamedItemIndex(doc, [...SOURCE_COLUMNS_PATH], opts.column.name) !== -1) {
    return {
      ok: false,
      error: `Column "${opts.column.name}" already exists in source "${opts.sourceName}"`,
    };
  }
  const appended = appendItem(doc, [...SOURCE_COLUMNS_PATH], opts.column);
  if (!appended.ok) return appended;
  return finishEdit(opts, filePath, doc, SourceSpecSchema);
}

export function removeSourceColumn(opts: RemoveSourceColumnOptions): EditResult<EditFileResult> {
  const prepared = prepareSourceEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'source',
      name: opts.sourceName,
      action: 'removeField',
      columnName: opts.columnName,
    });
  }
  const { filePath, doc } = prepared.data;
  const index = findNamedItemIndex(doc, [...SOURCE_COLUMNS_PATH], opts.columnName);
  if (index === -1) {
    return {
      ok: false,
      error: `Column "${opts.columnName}" not found in source "${opts.sourceName}"`,
    };
  }
  if (getSequenceLength(doc, [...SOURCE_COLUMNS_PATH]) <= 1) {
    return { ok: false, error: `Cannot remove the last column from source "${opts.sourceName}"` };
  }
  const deleted = deleteItem(doc, [...SOURCE_COLUMNS_PATH], index);
  if (!deleted.ok) return deleted;
  return finishEdit(opts, filePath, doc, SourceSpecSchema);
}

export function updateSource(opts: UpdateSourceOptions): EditResult<EditFileResult> {
  const prepared = prepareSourceEdit(opts);
  if (!prepared.ok) return prepared;
  if (isOssieDocument(prepared.data.doc)) {
    return editOssieDataset(opts, prepared.data.filePath, prepared.data.doc, {
      kind: 'source',
      name: opts.sourceName,
      action: 'updateDataset',
      patch: { ...opts.patch },
    });
  }
  applyPatch(prepared.data.doc, [], opts.patch);
  return finishEdit(opts, prepared.data.filePath, prepared.data.doc, SourceSpecSchema);
}

function prepareSourceEdit(opts: SourceEditBaseOptions): EditResult<{
  filePath: string;
  doc: ReturnType<typeof loadEditableDocument> extends EditResult<infer T> ? T : never;
}> {
  const found = findEditTarget(
    opts,
    'source',
    opts.sourceName,
    (record) => opts.connection === undefined || record.connection === opts.connection
  );
  if (!found.ok) return found;
  const doc = loadEditableDocument(found.data);
  if (!doc.ok) return doc;
  return { ok: true, data: { filePath: found.data, doc: doc.data } };
}
