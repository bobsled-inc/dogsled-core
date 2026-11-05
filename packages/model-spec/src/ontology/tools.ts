import { exportOssieDocuments } from '../interchange/export.js';
import { boundOntologyItems } from './bounds.js';
import { z } from 'zod';
import { scanProject } from '@bobsled-inc/project-index';
import { CommandError } from '../errors.js';
import { assertBounded } from '../interchange/common.js';
import { loadOntologyCatalog } from './catalog.js';
import { getOntologyContext } from './context.js';
import { editOntologyFile } from './edit.js';
import { importOntologyDocuments } from './conversion.js';

const describeInput = z
  .object({
    ontology: z.string().optional(),
    concept: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const validationInput = z.object({ strict: z.boolean().optional() }).strict();
const editInput = z
  .object({
    path: z.string(),
    content: z.string().optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    delete: z.boolean().optional(),
    apply: z.boolean().optional(),
  })
  .strict();
const exportInput = z.object({ ossieVersion: z.string(), strict: z.boolean().optional() }).strict();
const importInput = z
  .object({
    defaultConnection: z.string().optional(),
    documents: z.array(z.object({ path: z.string(), document: z.unknown() }).strict()).max(100),
  })
  .strict();
const operations = {
  ontology_list: {
    schema: z.object({}).strict(),
    description: 'List customer ontologies and mappings in the project without querying data.',
  },
  ontology_describe: {
    schema: describeInput,
    description:
      'Read exact concepts and mappings. Results include source hashes, validation diagnostics, and omitted identities. Limit: 1–200 concepts.',
  },
  ontology_validate: {
    schema: validationInput,
    description:
      'Check definition structure and references. Strict mode fails on unverified expressions. No rule or data execution.',
  },
  ontology_edit: {
    schema: editInput,
    description:
      'Preview a create, patch, or delete. Apply only when apply is true and write access is granted. Renames report affected references.',
  },
  ontology_export: {
    schema: exportInput,
    description:
      'Preview Ossie ontology and mapping documents. Supports only 0.2.0.dev0; never writes files.',
  },
  ontology_import: {
    schema: importInput,
    description:
      'Convert supplied Ossie ontology and mapping documents to native files for review. Never fetches references or overwrites files; use ontology_edit to apply reviewed native files.',
  },
};
export function createOntologyTools(options: {
  projectRoot: string;
  authorize: (mode: 'read' | 'write') => boolean | Promise<boolean>;
}) {
  return {
    tools: Object.entries(operations).map(([name, operation]) => ({
      name,
      description: operation.description,
      inputSchema: z.toJSONSchema(operation.schema),
    })),
    async call(name: string, input: unknown): Promise<unknown> {
      const operation = Object.hasOwn(operations, name)
        ? operations[name as keyof typeof operations]
        : undefined;
      if (!operation) throw new CommandError(`Unknown ontology tool: ${name}`, 2);
      assertBounded(input);
      const validation = operation.schema.safeParse(input);
      if (!validation.success) throw new CommandError(validation.error.message, 2);
      const parsed = validation.data;
      const mode = name === 'ontology_edit' && 'apply' in parsed && parsed.apply ? 'write' : 'read';
      if (!(await options.authorize(mode))) {
        throw new CommandError('Ontology permission denied.', 2);
      }
      if (name === 'ontology_import') {
        const request = importInput.parse(parsed);
        return importOntologyDocuments(
          request.documents,
          request.defaultConnection
            ? { connections: { defaultConnection: request.defaultConnection } }
            : undefined
        );
      }
      if (name === 'ontology_edit') {
        return editOntologyFile(options.projectRoot, editInput.parse(parsed));
      }
      const index = scanProject(options.projectRoot);
      const catalog = loadOntologyCatalog(index);
      if (name === 'ontology_export') {
        if (catalog.diagnostics.some((d) => d.severity === 'error')) {
          return { ok: false, ready: false, files: [], diagnostics: catalog.diagnostics };
        }
        return exportOssieDocuments(
          index.entries
            .filter((e) =>
              [
                'ontology',
                'ontology_mapping',
                'source',
                'model',
                'metric',
                'relationship',
                'vq',
              ].includes(e.kind)
            )
            .map((e) => ({ path: e.path, document: e.document })),
          exportInput.parse(parsed) as { ossieVersion: '0.1.1' | '0.2.0.dev0'; strict?: boolean }
        );
      }
      if (name === 'ontology_validate') {
        const strict = validationInput.parse(parsed).strict;
        return {
          ok: !catalog.diagnostics.some((d) => d.severity === 'error' || strict),
          version: catalog.version,
          diagnostics: boundOntologyItems(catalog.diagnostics, 200, 100_000).items,
          diagnosticCount: catalog.diagnostics.length,
        };
      }
      if (name === 'ontology_list') {
        const summaries = boundOntologyItems(
          catalog.entries.map((e) => ({
            name: e.document.name,
            type: e.document.type,
            path: e.path,
            sourceHash: e.sourceHash,
          })),
          200
        );
        return {
          truncated: summaries.truncated,
          total: catalog.entries.length,
          version: catalog.version,
          entries: summaries.items,
          diagnostics: boundOntologyItems(catalog.diagnostics, 200, 100_000).items,
          diagnosticCount: catalog.diagnostics.length,
        };
      }
      return getOntologyContext(catalog, describeInput.parse(parsed));
    },
  };
}
