import { importOntologyScopes } from './import-scopes.js';
import type { ImportOssieDocumentsRequest } from '../interchange/import-types.js';
import { z } from 'zod';
import {
  isOwnOssieVendor,
  assertBounded,
  diagnostic,
  file,
  identity,
  omit,
  record,
  type ConversionResult,
} from '../interchange/common.js';
import {
  ONTOLOGY_OSSIE_VERSION,
  OntologyBindingsSchema,
  parseOntologyDocument,
  validateStandardOntology,
} from './schema.js';

export interface OntologyConversionInput {
  path: string;
  document: unknown;
}
const extension = z
  .object({
    version: z.literal(1),
    ontology_mapping: z.object({ bindings: OntologyBindingsSchema }).strict(),
  })
  .strict();
const vendor = 'DOGSLED';
function failure(error: unknown): ConversionResult {
  return {
    ok: false,
    ready: false,
    files: [],
    diagnostics: [
      diagnostic(
        'ontology_conversion',
        'input',
        error instanceof Error ? error.message : 'Conversion failed'
      ),
    ],
  };
}

export function exportOntologyDocuments(
  inputs: readonly OntologyConversionInput[],
  options: { ossieVersion?: string; strict?: boolean } = {}
): ConversionResult {
  try {
    if (options.ossieVersion !== ONTOLOGY_OSSIE_VERSION) {
      throw new Error(
        `Unsupported ontology target ${options.ossieVersion ?? '0.1.1'}; supported: ${ONTOLOGY_OSSIE_VERSION}`
      );
    }
    const files = inputs.map((input) => {
      const native = parseOntologyDocument(input.document);
      const document: Record<string, unknown> = {
        version: ONTOLOGY_OSSIE_VERSION,
        ...omit(native, ['spec_version', 'type']),
      };
      if (native.type === 'ontology_mapping') {
        document['semantic_model_ref'] = omit(native.semantic_model_ref, ['bindings']);
        if (native.semantic_model_ref.bindings) {
          const extensions = z
            .array(z.object({ vendor_name: z.string(), data: z.string() }).strict())
            .parse(native['custom_extensions'] ?? []);
          if (extensions.some((e) => isOwnOssieVendor(e.vendor_name))) {
            throw new Error('Conflicting DOGSLED mapping extension.');
          }
          document['custom_extensions'] = [
            ...extensions,
            {
              vendor_name: vendor,
              data: JSON.stringify({
                version: 1,
                ontology_mapping: { bindings: native.semantic_model_ref.bindings },
              }),
            },
          ];
        }
      }
      validateStandardOntology(document, native.type === 'ontology_mapping');
      return file(`${native.type}-${identity(native.name)}.yml`, document);
    });
    if (new Set(files.map((f) => f.path)).size !== files.length) {
      throw new Error('Duplicate ontology or mapping identity.');
    }
    return { ok: true, ready: true, files, diagnostics: [] };
  } catch (error) {
    return failure(error);
  }
}

export function importOntologyDocuments(
  inputs: readonly OntologyConversionInput[],
  context?: ImportOssieDocumentsRequest['context']
): ConversionResult {
  try {
    const normalized: OntologyConversionInput[] = [];
    const semanticInputs: OntologyConversionInput[] = [];
    for (const input of inputs) {
      assertBounded(input.document);
      const raw = record(input.document);
      if (raw['datasets'] || raw['semantic_model']) {
        semanticInputs.push(input);
        continue;
      }
      validateStandardOntology(raw, Object.hasOwn(raw, 'concept_mappings'));
      const embedded = raw['ontology_mappings'] as Record<string, unknown>[] | undefined;
      normalized.push({ path: input.path, document: omit(raw, ['ontology_mappings']) });
      embedded?.forEach((mapping, i) => {
        const semantic = record(mapping['semantic_model']);
        semanticInputs.push({ path: `${identity(input.path)}-${i}.yml`, document: semantic });
        normalized.push({
          path: `${input.path}#mapping-${i}`,
          document: {
            version: ONTOLOGY_OSSIE_VERSION,
            name: mapping['name'] ?? `${String(raw['name'])}-mapping-${i}`,
            ...(mapping['description'] === undefined
              ? {}
              : { description: mapping['description'] }),
            ontology_ref: { name: raw['name'] },
            semantic_model_ref: { name: semantic['name'] },
            concept_mappings: mapping['concept_mappings'],
          },
        });
      });
    }
    const { result: semantic, scopes } = importOntologyScopes(semanticInputs, context);
    const files = normalized.map((input) => {
      assertBounded(input.document);
      const raw = record(input.document);
      const mapping = Object.hasOwn(raw, 'concept_mappings');
      validateStandardOntology(raw, mapping);
      const document: Record<string, unknown> = {
        spec_version: '0.2',
        type: mapping ? 'ontology_mapping' : 'ontology',
        ...omit(raw, ['version']),
      };
      if (mapping) {
        const extensions = z
          .array(z.object({ vendor_name: z.string(), data: z.string() }).strict())
          .parse(raw['custom_extensions'] ?? []);
        const own = extensions.filter((e) => isOwnOssieVendor(e.vendor_name));
        if (own.length > 1) throw new Error('Duplicate DOGSLED mapping extensions.');
        if (own[0]) {
          const value: unknown = JSON.parse(own[0].data);
          assertBounded(value);
          const payload = extension.parse(value);
          document['semantic_model_ref'] = {
            ...record(raw['semantic_model_ref']),
            bindings: payload.ontology_mapping.bindings,
          };
          const foreign = extensions.filter((e) => !isOwnOssieVendor(e.vendor_name));
          if (foreign.length) document['custom_extensions'] = foreign;
          else delete document['custom_extensions'];
        }
      }
      if (mapping) {
        const ref = record(document['semantic_model_ref']);
        const scope = scopes.get(String(ref['name']));
        if (scope) {
          const previous = ref['bindings'] ? record(ref['bindings']) : {};
          const oldDatasets = previous['datasets'] ? record(previous['datasets']) : scope;
          const datasets = Object.fromEntries(
            Object.keys(oldDatasets)
              .filter((alias) => scope[alias])
              .map((alias) => [alias, scope[alias]])
          );
          // Missing connections stay explicit and cannot produce ready mappings.
          ref['bindings'] = { ...previous, datasets };
          if (Object.keys(datasets).length !== Object.keys(oldDatasets).length) {
            semantic.ready = false;
          }
          document['semantic_model_ref'] = ref;
        }
      }
      const native = parseOntologyDocument(document);
      return file(`${native.type}-${identity(native.name)}.yml`, document);
    });
    if (new Set(files.map((f) => f.path)).size !== files.length) {
      throw new Error('Duplicate ontology or mapping identity.');
    }
    files.push(...semantic.files);
    return {
      ok: semantic.ok,
      ready:
        semantic.ready &&
        !files.some(
          (f) =>
            f.document['type'] === 'ontology_mapping' &&
            !record(f.document['semantic_model_ref'])['bindings']
        ),
      files,
      diagnostics: semantic.diagnostics,
    };
  } catch (error) {
    return failure(error);
  }
}
