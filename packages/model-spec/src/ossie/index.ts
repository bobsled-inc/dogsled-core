import { InterchangeDocumentSchema } from '../interchange/storage.js';
import {
  assertValidProjectIndex,
  entryFilePath,
  type ProjectIndex,
  type ProjectIndexEntry,
} from '@bobsled-inc/project-index';
import { CommandError } from '../errors.js';
import { translateOssieDocument, type OssieOrigin } from './translate.js';

export {
  translateOssieDocument,
  type OssieOrigin,
  type TranslatedOssieDocument,
} from './translate.js';
export { logicalTypeForSqlType } from './types.js';
export { validateOssieDocument, OSSIE_VERSION, OSSIE_SCHEMA_REVISION } from './schema.js';

const expanded = new WeakMap<ProjectIndex, ProjectIndex>();
const origins = new WeakMap<ProjectIndex, readonly OssieOrigin[]>();

/** Keep authored content and per-dataset origins beside the native execution view. */
export function getOssieOrigins(index: ProjectIndex): readonly OssieOrigin[] {
  return origins.get(index) ?? [];
}

export function expandOssieIndex(index: ProjectIndex): ProjectIndex {
  assertValidProjectIndex(index);
  const cached = expanded.get(index);
  if (cached) return cached;
  const entries: ProjectIndexEntry[] = [];
  const locations: OssieOrigin[] = [];
  for (const entry of index.entries) {
    if (entry.kind === 'interchange') {
      const parsed = InterchangeDocumentSchema.safeParse(entry.document);
      if (!parsed.success) {
        throw new CommandError(
          `${entry.path}: Invalid interchange metadata: ${parsed.error.message}`,
          2
        );
      }
    }
    if (entry.kind !== 'ossie') {
      entries.push(entry);
      continue;
    }
    const filePath = entryFilePath(index, entry);
    if (entry.document === undefined) {
      throw new CommandError(`${filePath}: Invalid Ossie YAML/JSON document`, 2);
    }
    const translated = translateOssieDocument(entry.document, filePath);
    locations.push(...translated.origins);
    for (const definition of translated.entries) {
      entries.push({
        ...entry,
        kind: definition.kind,
        declaredType: undefined,
        document: definition.document,
      });
    }
  }
  const result = { ...index, entries };
  expanded.set(index, result);
  expanded.set(result, result);
  origins.set(index, locations);
  origins.set(result, locations);
  return result;
}
