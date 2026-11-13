import { z } from 'zod';
import { VqSpecSchema, extractVqSqlTokens, mapVqSqlReferences } from '../entities/vq.js';
import type { OssieSemanticModel } from '../ossie/profile-types.js';
import {
  assertBounded,
  diagnostic,
  extensions,
  file,
  OSSIE_VENDOR,
  type ConversionResult,
} from './common.js';
import { outputPath } from './import-helpers.js';
import type { ExportOssieDocumentRequest } from './export.js';
import type { OssieConnectionContext } from './import-types.js';

const queryExtension = z
  .object({
    extension_version: z.literal('2'),
    verified_queries: z.array(VqSpecSchema),
  })
  .strict();

export class VerifiedQueryFailure extends Error {
  readonly objectReference: { documentPath: string };
  readonly remedy = 'Correct the DOGSLED verified-query definitions and retry.';
  constructor(
    readonly code: string,
    readonly diagnosticPath: string,
    message: string
  ) {
    super(message);
    this.objectReference = { documentPath: diagnosticPath.split('#')[0]! };
  }
}

export function exportVerifiedQueries(
  request: ExportOssieDocumentRequest,
  selected: Set<string>,
  result: ConversionResult
): { custom_extensions?: Array<{ vendor_name: string; data: string }> } {
  const names = new Set<string>();
  const queries = (request.project.verifiedQueries ?? [])
    .map((value, index) => {
      const name =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.getOwnPropertyDescriptor(value, 'name')?.value
          : undefined;
      assertBounded(
        value,
        `project#verified_queries.${typeof name === 'string' && name ? name : `[${index}]`}`
      );
      const query = VqSpecSchema.parse(value);
      if (names.has(query.name)) {
        throw new VerifiedQueryFailure(
          'duplicate_identity',
          `project#verified_queries.${query.name}`,
          `Duplicate verified query ${query.name}.`
        );
      }
      names.add(query.name);
      return query;
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((query) => {
      const references = [
        ...new Set(extractVqSqlTokens(query.sql).map((token) => token.segments.join('.'))),
      ];
      if (!references.length) return 'all' in request.selection && request.selection.all === true;
      const count = references.filter((reference) => selected.has(reference)).length;
      if (count === references.length) return true;
      if (count || ('all' in request.selection && request.selection.all)) {
        result.diagnostics.push(
          diagnostic(
            'export_object_partially_selected',
            `project#verified_queries.${query.name}`,
            `Verified query ${query.name} was omitted because some referenced datasets were not selected.`,
            'warning',
            { documentPath: 'project' },
            'Select every referenced dataset to include this query.'
          )
        );
      }
      return false;
    });
  if (!queries.length) return {};
  if ((request.ossieVersion ?? '0.1.1') === '0.1.1') {
    result.diagnostics.push(
      diagnostic(
        'verified_queries_not_supported_by_profile',
        'project#verified_queries',
        'OSI 0.1.1 cannot store DOGSLED verified queries; they were omitted.',
        'warning',
        { documentPath: 'project' },
        'Use OSI 0.2.0.dev0 to preserve verified queries.'
      )
    );
    return {};
  }
  return {
    custom_extensions: [
      {
        vendor_name: OSSIE_VENDOR,
        data: JSON.stringify({ extension_version: '2', verified_queries: queries }),
      },
    ],
  };
}

export function importVerifiedQueries(
  model: OssieSemanticModel,
  documentPath: string,
  connections: OssieConnectionContext | undefined,
  references: ReadonlyMap<string, string>,
  identities: Set<string>,
  result: ConversionResult
): void {
  const path = `${documentPath}#verified_queries`;
  const owned = extensions(model).filter((entry) => entry.vendor_name === OSSIE_VENDOR);
  if (!owned.length) return;
  if (owned.length !== 1) {
    throw new VerifiedQueryFailure(
      'invalid_dogsled_extension',
      path,
      'Use only one semantic-model DOGSLED extension.'
    );
  }
  let payload: z.infer<typeof queryExtension>;
  try {
    const raw: unknown = JSON.parse(owned[0]!.data);
    assertBounded(raw);
    payload = queryExtension.parse(raw);
  } catch {
    throw new VerifiedQueryFailure(
      'invalid_dogsled_extension',
      path,
      'Expected DOGSLED extension_version "2" and valid verified_queries.'
    );
  }
  for (const query of payload.verified_queries) {
    const key = `vq:${query.name}`;
    if (identities.has(key)) {
      throw new VerifiedQueryFailure(
        'duplicate_identity',
        `${path}.${query.name}`,
        `Duplicate verified query ${query.name}.`
      );
    }
    identities.add(key);
    const sql = mapVqSqlReferences(query.sql, (reference) => {
      const mapped = references.get(reference);
      if (mapped) return mapped;
      const dot = reference.indexOf('.');
      const alias = dot > 0 ? connections?.connectionAliases?.[reference.slice(0, dot)] : undefined;
      return alias ? alias + reference.slice(dot) : reference;
    });
    const reboundConnections = new Set(
      extractVqSqlTokens(query.sql).flatMap((token) => {
        if (token.segments.length !== 2 || token.segments[0] !== query.connection) return [];
        const mapped = references.get(token.segments.join('.'));
        return mapped?.includes('.') ? [mapped.slice(0, mapped.indexOf('.'))] : [];
      })
    );
    const connection = query.connection
      ? reboundConnections.size === 1
        ? [...reboundConnections][0]
        : (connections?.connectionAliases?.[query.connection] ?? query.connection)
      : undefined;
    const known = new Set(references.values());
    const missing = extractVqSqlTokens(sql).filter((token) => !known.has(token.segments.join('.')));
    if (missing.length || reboundConnections.size > 1) {
      result.diagnostics.push(
        diagnostic(
          'native_incomplete',
          `${path}.${query.name}`,
          missing.length
            ? `Verified query ${query.name} refers to datasets outside this semantic model.`
            : `Verified query ${query.name} has more than one rebound connection.`,
          'error',
          { documentPath },
          'Review the query references and connection in the generated draft.'
        )
      );
    }
    const native = VqSpecSchema.parse({ ...query, sql, ...(connection ? { connection } : {}) });
    result.files.push(file(outputPath('vq', native.name), native));
  }
}
