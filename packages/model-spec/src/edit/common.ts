import YAML from 'yaml';
import { z } from 'zod';

import { readYamlDocument, serializeDocument, writeYamlDocument } from './yaml-document.js';

import type { EditFileResult, EditOptions, EditResult } from './types.js';
import type { Document } from 'yaml';

export function validateContent(
  content: string,
  schema: z.ZodType<unknown>,
  filePath: string
): EditResult {
  let parsedYaml: unknown;
  try {
    parsedYaml = YAML.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `${filePath}: Invalid YAML after edit: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = schema.safeParse(parsedYaml);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `${filePath}: Validation failed: ${messages}` };
  }
  return { ok: true, data: undefined };
}

export function finishEdit(
  opts: EditOptions,
  filePath: string,
  doc: Document.Parsed,
  schema: z.ZodType<unknown>
): EditResult<EditFileResult> {
  const content = serializeDocument(doc);
  if (!opts.skipValidation) {
    const validated = validateContent(content, schema, filePath);
    if (!validated.ok) return validated;
  }
  if (!opts.dryRun) {
    const written = writeYamlDocument(filePath, content);
    if (!written.ok) return written;
  }
  return { ok: true, data: { filePath, content } };
}

export function loadEditableDocument(filePath: string): EditResult<Document.Parsed> {
  const read = readYamlDocument(filePath);
  if (!read.ok) return read;
  if (read.data.doc.errors.length > 0) {
    return {
      ok: false,
      error: `Invalid YAML in ${filePath}: ${read.data.doc.errors.map((e) => e.message).join('; ')}`,
    };
  }
  return { ok: true, data: read.data.doc };
}
