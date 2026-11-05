import { rebaseNativeExtensions } from './export-references.js';
import { canonicalize } from 'json-canonicalize';
import {
  diagnostic,
  file,
  identity,
  record,
  type ConversionResult,
} from '../interchange/common.js';
import type {
  ExportOssieDocumentRequest,
  ExportOssieOptions,
  NativeInterchangeInput,
} from '../interchange/export.js';
import { parseOntologyDocument } from './schema.js';

/** Reuse the semantic converter, with an explicit scope and selection for each mapping. */
export function exportOntologyScopes(
  mappings: readonly NativeInterchangeInput[],
  inputs: readonly NativeInterchangeInput[],
  options: ExportOssieOptions,
  convert: (request: ExportOssieDocumentRequest) => ConversionResult
): ConversionResult {
  const result: ConversionResult = { ok: true, ready: true, files: [], diagnostics: [] };
  try {
    const scopes = new Map<string, string>();
    const documents = inputs.map((i) => record(i.document));
    for (const input of mappings) {
      const mapping = parseOntologyDocument(input.document);
      if (mapping.type !== 'ontology_mapping') continue;
      const { name, bindings } = mapping.semantic_model_ref;
      if (!bindings) throw new Error(`Scope ${name} needs explicit dataset bindings.`);
      const signature = canonicalize(bindings);
      if (scopes.has(name)) {
        if (scopes.get(name) !== signature) {
          throw new Error(`Conflicting bindings for scope ${name}.`);
        }
        continue;
      }
      scopes.set(name, signature);
      const selectors: Array<
        { kind: 'model'; name: string } | { kind: 'source'; connection: string; name: string }
      > = [];
      const aliases = new Map<string, string>();
      const references = new Map<string, string>();
      for (const [alias, reference] of Object.entries(bindings.datasets)) {
        const matches = documents.filter(
          (d) =>
            (d['type'] === 'source'
              ? `${String(d['connection'])}.${String(d['name'])}`
              : d['type'] === 'model'
                ? d['name']
                : undefined) === reference
        );
        if (matches.length !== 1) {
          throw new Error(`Scope ${name}: unresolved or ambiguous model ${reference}.`);
        }
        const d = matches[0]!;
        const nativeName = String(d['name']);
        if (aliases.has(nativeName)) {
          throw new Error(`Scope ${name}: a dataset has more than one alias.`);
        }
        aliases.set(nativeName, alias);
        references.set(
          reference,
          d['type'] === 'source' ? `${String(d['connection'])}.${alias}` : alias
        );
        selectors.push(
          d['type'] === 'source'
            ? { kind: 'source', name: nativeName, connection: String(d['connection']) }
            : { kind: 'model', name: nativeName }
        );
      }
      for (const [field, kind] of [
        ['relationships', 'relationship'],
        ['metrics', 'metric'],
        ['verified_queries', 'vq'],
      ] as const) {
        for (const selected of bindings[field] ?? []) {
          if (documents.filter((d) => d['type'] === kind && d['name'] === selected).length !== 1) {
            throw new Error(`Scope ${name}: unresolved or ambiguous ${kind} ${selected}.`);
          }
        }
      }
      const converted = convert({
        project: {
          sources: documents.filter((d) => d['type'] === 'source'),
          models: documents.filter((d) => d['type'] === 'model'),
          metrics: documents.filter(
            (d) => d['type'] === 'metric' && bindings.metrics?.includes(String(d['name']))
          ),
          relationships: documents.filter(
            (d) =>
              d['type'] === 'relationship' && bindings.relationships?.includes(String(d['name']))
          ),
          verifiedQueries: documents.filter(
            (d) => d['type'] === 'vq' && bindings.verified_queries?.includes(String(d['name']))
          ),
          addresses: options.addresses ?? {},
        },
        semanticModelName: name,
        selection: { selectors },
        ossieVersion: options.ossieVersion,
        strict: options.strict,
      });
      if (!converted.ok) return { ...converted, files: [] };
      for (const output of converted.files) {
        const document = structuredClone(output.document);
        const datasets = document['datasets'] as Record<string, unknown>[];
        // Native SQL and vendor payloads are opaque. Never rewrite them with a text replacement.
        const checkExpressions = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(checkExpressions);
            return;
          }
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if ((key === 'expression' || key === 'sql') && typeof child === 'string') {
              for (const [native, alias] of aliases) {
                if (native !== alias && child.includes(`${native}.`)) {
                  throw new Error(
                    `Scope ${name}: expression references ${native}; supply a matching dataset alias or a reviewed semantic expression.`
                  );
                }
              }
            } else if (key !== 'custom_extensions') checkExpressions(child);
          }
        };
        checkExpressions(document);
        rebaseNativeExtensions(document, references);
        datasets.forEach((d) => {
          d['name'] = aliases.get(String(d['name'])) ?? d['name'];
        });
        if (new Set(datasets.map((d) => d['name'])).size !== datasets.length) {
          throw new Error(`Scope ${name}: dataset aliases collide with dependencies.`);
        }
        for (const r of (document['relationships'] ?? []) as Record<string, unknown>[]) {
          r['from'] = aliases.get(String(r['from'])) ?? r['from'];
          r['to'] = aliases.get(String(r['to'])) ?? r['to'];
        }
        result.files.push(file(`semantic-model-${identity(name)}.yml`, document));
      }
      result.ready &&= converted.ready;
      result.diagnostics.push(...converted.diagnostics);
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      ready: false,
      files: [],
      diagnostics: [
        diagnostic(
          'ontology_scope_export',
          'input',
          error instanceof Error ? error.message : 'Scope export failed'
        ),
      ],
    };
  }
}
