import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { isSeq } from 'yaml';
import { scanProject, entriesOfKind, entryFilePath } from '@bobsled-inc/project-index';
import { buildDagFromDocuments } from '../compiler/dag.js';
import { registerOssieBindings } from '../api/ossie-bindings.js';
import { buildIndexedSourceRegistry, resolveRef } from '../compiler/parser.js';

import { expandOssieIndex, logicalTypeForSqlType, translateOssieDocument } from '../ossie/index.js';

import { applyPatch, findNamedItemIndex, writeYamlDocument } from './yaml-document.js';

import type { EditFileResult, EditOptions, EditResult } from './types.js';
import type { Document } from 'yaml';

type RecordValue = Record<string, unknown>;
type YamlPath = Array<string | number>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

export function isOssieDocument(doc: Document.Parsed): boolean {
  return doc.has('version') && doc.has('datasets');
}

/** Find editable identities without reducing the authored document to runtime objects. */
export function ossieEditRecords(document: RecordValue): RecordValue[] {
  if (!document.version || !Array.isArray(document.datasets)) return [];
  return document.datasets.flatMap((value: unknown) => {
    const dataset = record(value);
    if (!dataset || !Array.isArray(dataset.custom_extensions)) return [];
    return dataset.custom_extensions.flatMap((item: unknown) => {
      const extension = record(item);
      if (extension?.vendor_name !== 'BOBSLED' || typeof extension.data !== 'string') return [];
      try {
        const data = record(JSON.parse(extension.data));
        if (!data || !['source', 'derived'].includes(String(data.kind))) return [];
        return [
          { ...data, name: dataset.name, type: data.kind === 'derived' ? 'model' : 'source' },
        ];
      } catch {
        return [];
      }
    });
  });
}

function extensionAt(doc: Document.Parsed, base: YamlPath): { path: YamlPath; data: RecordValue } {
  const extensions = doc.getIn([...base, 'custom_extensions'], true);
  if (isSeq(extensions)) {
    const indices = extensions.items.flatMap((_, index) =>
      doc.getIn([...base, 'custom_extensions', index, 'vendor_name']) === 'BOBSLED' ? [index] : []
    );
    if (indices.length > 1) throw new Error('Multiple BOBSLED extensions on the same object');
    if (indices.length === 1) {
      const path = [...base, 'custom_extensions', indices[0]!, 'data'];
      const raw = doc.getIn(path);
      if (typeof raw !== 'string') throw new Error('BOBSLED extension data must be a JSON string');
      const data = record(JSON.parse(raw));
      if (!data) throw new Error('BOBSLED extension data must contain a JSON object');
      return { path, data };
    }
  } else {
    doc.setIn([...base, 'custom_extensions'], doc.createNode([]));
  }
  const sequence = doc.getIn([...base, 'custom_extensions'], true);
  if (!isSeq(sequence)) throw new Error('Expected custom_extensions sequence');
  const index = sequence.items.length;
  sequence.add(doc.createNode({ vendor_name: 'BOBSLED', data: '{}' }));
  return { path: [...base, 'custom_extensions', index, 'data'], data: {} };
}

function saveExtension(
  doc: Document.Parsed,
  extension: { path: YamlPath; data: RecordValue }
): void {
  const current = doc.getIn(extension.path);
  if (typeof current === 'string' && isDeepStrictEqual(JSON.parse(current), extension.data)) return;
  doc.setIn(extension.path, JSON.stringify(extension.data));
}

function patchObject(target: RecordValue, patch: RecordValue): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

function patchField(
  doc: Document.Parsed,
  dataset: YamlPath,
  field: YamlPath,
  patch: RecordValue
): void {
  const extension = extensionAt(doc, field);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'description') applyPatch(doc, field, { description: value });
    else if (key === 'primary_key') {
      const names = doc.getIn([...dataset, 'primary_key']);
      const current = isSeq(names) ? (names.toJSON() as string[]) : [];
      const name = String(doc.getIn([...field, 'name']));
      const updated = current.filter((item) => item !== name);
      if (value === true) updated.push(name);
      if (updated.length) doc.setIn([...dataset, 'primary_key'], updated);
      else doc.deleteIn([...dataset, 'primary_key']);
    } else if (key === 'type') {
      patchObject(extension.data, { sql_type: value });
      if (typeof value === 'string') {
        doc.setIn([...field, 'datatype'], logicalTypeForSqlType(value));
      }
    } else {
      patchObject(extension.data, { [key === 'expr' ? 'build_expression' : key]: value });
    }
  }
  saveExtension(doc, extension);
}

/** Reuse the project graph and reference resolver before saving a changed parent. */
function validateReferences(opts: EditOptions, filePath: string, document: unknown): void {
  const rawIndex = scanProject(opts.projectDir);
  const index = expandOssieIndex({
    ...rawIndex,
    entries: rawIndex.entries.map((entry) =>
      entryFilePath(rawIndex, entry) === filePath ? { ...entry, document } : entry
    ),
  });
  const sources = buildIndexedSourceRegistry(index);
  if (!sources.ok) throw new Error(sources.error);
  const dag = buildDagFromDocuments(
    entriesOfKind(index, 'model').map((entry) => ({
      filePath: entryFilePath(index, entry),
      data: entry.document,
    }))
  );
  if (!dag.ok) throw new Error(dag.error);
  registerOssieBindings(index, dag.order, sources.entryRegistry);
  const modelNames = new Map(dag.order.map((node) => [node.name, node.name]));
  for (const node of dag.order) {
    for (const ref of node.sourceRefs) {
      const result = resolveRef(ref, sources.registry, modelNames);
      if (!result.ok) throw new Error(`${node.name}: ${result.error}`);
    }
  }
}

type EditAction = {
  kind: 'source' | 'model';
  name: string;
} & (
  | { action: 'updateDataset'; patch: RecordValue }
  | { action: 'updateField'; columnName: string; patch: RecordValue }
  | { action: 'addField'; column: RecordValue }
  | { action: 'removeField'; columnName: string }
);

export function editOssieDataset(
  opts: EditOptions,
  filePath: string,
  doc: Document.Parsed,
  edit: EditAction
): EditResult<EditFileResult> {
  try {
    // Never repair invalid or ambiguous input as a side effect of an unrelated edit.
    const before: unknown = doc.toJSON();
    translateOssieDocument(before, filePath);
    const index = findNamedItemIndex(doc, ['datasets'], edit.name);
    if (index < 0) throw new Error(`Dataset "${edit.name}" not found`);
    const base: YamlPath = ['datasets', index];
    const fields = [...base, 'fields'];
    if (edit.action === 'updateDataset') {
      const extension = extensionAt(doc, base);
      for (const [key, value] of Object.entries(edit.patch)) {
        if (key === 'description') applyPatch(doc, base, { description: value });
        else if (edit.kind === 'source' || key === 'grain') {
          patchObject(extension.data, { [key]: value });
        } else {
          const build = record(extension.data.build) ?? {};
          patchObject(build, { [key]: value });
          extension.data.build = build;
        }
      }
      saveExtension(doc, extension);
    } else if (edit.action === 'addField') {
      if (findNamedItemIndex(doc, fields, String(edit.column.name)) >= 0) {
        throw new Error(
          `Column "${String(edit.column.name)}" already exists in ${edit.kind} "${edit.name}"`
        );
      }
      const seq = doc.getIn(fields, true);
      if (!isSeq(seq)) throw new Error('Expected explicit Ossie fields');
      const fieldPath = [...fields, seq.items.length];
      seq.add(
        doc.createNode({
          name: edit.column.name,
          expression: { dialects: [{ dialect: 'ANSI_SQL', expression: edit.column.name }] },
        })
      );
      const { name: _name, ...patch } = edit.column;
      patchField(doc, base, fieldPath, patch);
    } else {
      const fieldIndex = findNamedItemIndex(doc, fields, edit.columnName);
      if (fieldIndex < 0) {
        throw new Error(`Column "${edit.columnName}" not found in ${edit.kind} "${edit.name}"`);
      }
      if (edit.action === 'updateField') patchField(doc, base, [...fields, fieldIndex], edit.patch);
      else {
        const seq = doc.getIn(fields, true);
        if (!isSeq(seq) || seq.items.length <= 1) {
          throw new Error(`Cannot remove the last column from ${edit.kind} "${edit.name}"`);
        }
        seq.delete(fieldIndex);
      }
    }
    const after: unknown = doc.toJSON();
    // Ossie profile validation is mandatory: skipValidation cannot bypass format ownership.
    translateOssieDocument(after, filePath);
    if (
      edit.action === 'updateDataset' &&
      ['source', 'materialization'].some((key) => Object.hasOwn(edit.patch, key))
    ) {
      validateReferences(opts, filePath, after);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (isDeepStrictEqual(before, after)) return { ok: true, data: { filePath, content: raw } };
    // JSON is also an authoring format; YAML AST serialization would make it invalid JSON.
    const content = raw.trimStart().startsWith('{')
      ? `${JSON.stringify(after, null, 2)}\n`
      : doc.toString();
    if (!opts.dryRun) {
      const result = writeYamlDocument(filePath, content);
      if (!result.ok) return result;
    }
    return { ok: true, data: { filePath, content } };
  } catch (err) {
    return { ok: false, error: `${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
