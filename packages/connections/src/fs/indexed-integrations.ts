/**
 * Warehouse integrations read from a project index.
 *
 * Integrations may live anywhere in a project; each is identified by its
 * `name`, never by its filename or folder. The index `integration` kind also
 * holds API extraction integrations (`spec_version: '2'`) and extraction-only
 * warehouse and file-storage specs, which the extractor owns. This loader
 * keeps the warehouse integrations `IntegrationFileSchema` describes.
 */

import {
  assertValidProjectIndex,
  documentName,
  duplicateIdentityIssues,
  entriesOfKind,
  entryFilePath,
  findNamedEntry,
  ProjectIndexError,
  type ProjectIndex,
  type ProjectIndexEntry,
} from '@bobsled-inc/project-index';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';

import { IntegrationFileSchema, type IntegrationFile } from '../schemas/integration.js';

/** `source_type` values only the extractor reads; warehouse loaders skip them. */
const EXTRACTION_ONLY_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'api',
  'delta',
  'gcs',
  'iceberg',
  'local',
  'mysql',
  'redshift',
  's3',
  'sftp',
]);

export interface IndexedIntegration {
  readonly handle: string;
  /** Project-relative path of the defining file. */
  readonly path: string;
  readonly integration: IntegrationFile;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicateNames(entries: readonly ProjectIndexEntry[]): void {
  const duplicates = duplicateIdentityIssues(entries, documentName, 'integration name');
  if (duplicates.length > 0) throw new ProjectIndexError(duplicates);
}

/** True for an integration entry the warehouse schema governs. */
function isWarehouseIntegrationEntry(entry: ProjectIndexEntry): boolean {
  if (entry.kind !== 'integration' || !isRecord(entry.document)) return false;
  const version = entry.document['spec_version'];
  if (version === '2' || version === 2) return false;
  const sourceType = entry.document['source_type'];
  const transport = entry.document['transport'];
  if (
    sourceType === undefined &&
    isRecord(transport) &&
    ['http', 'mcp_http', 'mcp_stdio'].includes(String(transport['type']))
  ) {
    return false;
  }
  return !(typeof sourceType === 'string' && EXTRACTION_ONLY_SOURCE_TYPES.has(sourceType));
}

function parseEntry(index: ProjectIndex, entry: ProjectIndexEntry): IntegrationFile {
  const parsed = IntegrationFileSchema.safeParse(entry.document);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('integration', entryFilePath(index, entry), parsed.error, {
        schema: IntegrationFileSchema,
      }),
      2
    );
  }
  return parsed.data;
}

/**
 * Parse every warehouse integration in the index, keyed and sorted by name.
 * Two integration files of any kind that share a name are an error naming
 * both paths. An index with blocking issues, such as a scan that stopped at a
 * limit, is refused as `resolveProjectIndex` refuses it.
 */
export function loadIndexedIntegrations(index: ProjectIndex): Map<string, IndexedIntegration> {
  assertValidProjectIndex(index);
  const integrationEntries = entriesOfKind(index, 'integration');
  duplicateNames(integrationEntries);

  const loaded = integrationEntries
    .filter(isWarehouseIntegrationEntry)
    .map((entry) => {
      const integration = parseEntry(index, entry);
      return { handle: integration.name, path: entry.path, integration };
    })
    .sort((left, right) => (left.handle < right.handle ? -1 : left.handle > right.handle ? 1 : 0));
  return new Map(loaded.map((entry) => [entry.handle, entry]));
}

/**
 * The integration file whose `name` is `handle`, parsed with the warehouse
 * schema whatever its shape, so a same-named API integration reports why it
 * cannot serve as a warehouse. `undefined` when no file declares the name.
 * An index with blocking issues is refused.
 */
export function findIndexedIntegration(
  index: ProjectIndex,
  handle: string
): IndexedIntegration | undefined {
  assertValidProjectIndex(index);
  const entry = findNamedEntry(index, 'integration', handle);
  return entry ? { handle, path: entry.path, integration: parseEntry(index, entry) } : undefined;
}
