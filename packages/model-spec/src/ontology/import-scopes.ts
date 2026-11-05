import { stringify } from 'yaml';
import { canonicalize } from 'json-canonicalize';
import { importOssieDocuments } from '../interchange/import.js';
import type { ImportOssieDocumentsRequest } from '../interchange/import-types.js';
import { record, type ConversionResult } from '../interchange/common.js';
import type { OntologyConversionInput } from './conversion.js';

/** Bind only to native files produced by the semantic importer, never guessed connections. */
export function importOntologyScopes(
  inputs: readonly OntologyConversionInput[],
  context?: ImportOssieDocumentsRequest['context']
) {
  const result: ConversionResult = { ok: true, ready: true, files: [], diagnostics: [] };
  const scopes = new Map<string, Record<string, string>>();
  for (const input of inputs) {
    const raw = record(input.document);
    const name = String(raw['name']);
    if (scopes.has(name)) throw new Error(`Duplicate semantic model scope ${name}.`);
    const converted = importOssieDocuments({
      documents: [{ path: input.path, content: stringify(input.document) }],
      context,
    });
    const bindings: Record<string, string> = {};
    for (const output of converted.files) {
      const doc = output.document;
      if (doc['type'] === 'model') bindings[String(doc['name'])] = String(doc['name']);
      if (doc['type'] === 'source' && typeof doc['connection'] === 'string') {
        bindings[String(doc['name'])] = `${doc['connection']}.${String(doc['name'])}`;
      }
      const existing = result.files.find((f) => f.path === output.path);
      if (existing && canonicalize(existing.document) !== canonicalize(doc)) {
        throw new Error(`Semantic scopes produce conflicting native files: ${output.path}`);
      }
      if (!existing) result.files.push(output);
    }
    scopes.set(name, bindings);
    result.ok &&= converted.ok;
    result.ready &&= converted.ready;
    result.diagnostics.push(...converted.diagnostics);
  }
  return { result, scopes };
}
