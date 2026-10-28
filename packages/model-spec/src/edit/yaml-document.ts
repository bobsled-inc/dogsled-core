import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML, { isMap, isScalar, isSeq } from 'yaml';

import type { EditResult } from './types.js';
import type { Document, Scalar, YAMLMap, YAMLSeq } from 'yaml';

export interface YamlDocumentData {
  doc: Document.Parsed;
  raw: string;
}

export function readYamlDocument(filePath: string): EditResult<YamlDocumentData> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    return { ok: true, data: { doc: YAML.parseDocument(raw), raw } };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function serializeDocument(doc: Document.Parsed): string {
  return doc.toString();
}

export function writeYamlDocument(filePath: string, content: string): EditResult {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);

  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return { ok: true, data: undefined };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    return {
      ok: false,
      error: `Cannot write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function findNamedItemIndex(
  doc: Document.Parsed,
  arrayPath: Array<string | number>,
  name: string
): number {
  const node = doc.getIn(arrayPath, true);
  if (!isSeq(node)) return -1;

  const target = name.toLowerCase();
  for (const [index, item] of node.items.entries()) {
    if (!isMap(item)) continue;
    const value = item.get('name', true);
    const scalarValue = isScalar(value) ? (value as Scalar).value : value;
    if (String(scalarValue).toLowerCase() === target) return index;
  }
  return -1;
}

export function applyPatch(
  doc: Document.Parsed,
  basePath: Array<string | number>,
  patch: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(patch)) {
    const pathParts = [...basePath, key];
    if (value === undefined) {
      doc.deleteIn(pathParts);
    } else {
      doc.setIn(pathParts, value);
    }
  }
}

export function appendItem(
  doc: Document.Parsed,
  arrayPath: Array<string | number>,
  item: Record<string, unknown>
): EditResult {
  const node = doc.getIn(arrayPath, true);
  if (!isSeq(node)) {
    return { ok: false, error: `Expected YAML sequence at ${arrayPath.join('.')}` };
  }
  (node as YAMLSeq).add(item);
  return { ok: true, data: undefined };
}

export function deleteItem(
  doc: Document.Parsed,
  arrayPath: Array<string | number>,
  index: number
): EditResult {
  const node = doc.getIn(arrayPath, true);
  if (!isSeq(node)) {
    return { ok: false, error: `Expected YAML sequence at ${arrayPath.join('.')}` };
  }
  (node as YAMLSeq).delete(index);
  return { ok: true, data: undefined };
}

export function getSequenceLength(doc: Document.Parsed, arrayPath: Array<string | number>): number {
  const node = doc.getIn(arrayPath, true);
  return isSeq(node) ? node.items.length : 0;
}

export function getMapAt(
  doc: Document.Parsed,
  pathParts: Array<string | number>
): YAMLMap | undefined {
  const node = doc.getIn(pathParts, true);
  return isMap(node) ? node : undefined;
}
