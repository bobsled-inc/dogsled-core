import path from 'node:path';

import { entriesOfKind, ProjectIndexError } from './project-index.js';

import type { ProjectFileKind } from './kinds.js';
import type { ProjectIndex, ProjectIndexEntry, ProjectIndexIssue } from './types.js';

/**
 * Location of an entry for messages and file-backed loaders: the absolute path
 * for a scanned project, the project-relative path for an in-memory index.
 */
export function entryFilePath(index: ProjectIndex, entry: ProjectIndexEntry): string {
  return index.root ? path.join(index.root, ...entry.path.split('/')) : entry.path;
}

/** The string `name` field of an entry's document, when it has one. */
export function documentName(entry: ProjectIndexEntry): string | undefined {
  const document = entry.document;
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const name = (document as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * The integration a resource belongs to: its declared `integration` (or the
 * three-block `extract.integration`), else — for a file at the conventional
 * `<resourcesFolder>/<integration>/` location — that folder's name.
 * `resourcesFolder` is the project-relative resources folder (`resources`
 * unless the extractor configuration moves it). `undefined` means a resource
 * outside that location that declares no owner.
 */
export function resourceIntegration(
  entry: ProjectIndexEntry,
  resourcesFolder = 'resources'
): string | undefined {
  const document = entry.document;
  if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
    const record = document as Record<string, unknown>;
    if (typeof record['integration'] === 'string') return record['integration'];
    const extract = record['extract'];
    if (typeof extract === 'object' && extract !== null && !Array.isArray(extract)) {
      const integration = (extract as Record<string, unknown>)['integration'];
      if (typeof integration === 'string') return integration;
    }
  }
  const prefix = resourcesFolder === '' ? '' : `${resourcesFolder}/`;
  if (!entry.path.startsWith(prefix)) return undefined;
  const [integration, ...rest] = entry.path.slice(prefix.length).split('/');
  return integration !== undefined && rest.length > 0 ? integration : undefined;
}

/**
 * Report every entry whose identity another entry shares, naming all the
 * paths involved. Loaders pass the identity their kind uses (a case-folded
 * name, `connection.name`, `integration/name`, …) after schema validation.
 */
export function duplicateIdentityIssues<T extends { readonly path: string }>(
  items: readonly T[],
  identityOf: (item: T) => string | undefined,
  label: string
): ProjectIndexIssue[] {
  const pathsByIdentity = new Map<string, string[]>();
  for (const item of items) {
    const identity = identityOf(item);
    if (identity === undefined) continue;
    pathsByIdentity.set(identity, [...(pathsByIdentity.get(identity) ?? []), item.path]);
  }
  const issues: ProjectIndexIssue[] = [];
  for (const [identity, paths] of pathsByIdentity) {
    if (paths.length < 2) continue;
    for (const itemPath of paths) {
      issues.push({
        path: itemPath,
        code: 'duplicate_identity',
        message: `Duplicate ${label} "${identity}" in ${paths.join(' and ')}.`,
      });
    }
  }
  return issues;
}

/**
 * The entry of `kind` whose document `name` is `name`, wherever it lives.
 * Two such entries are an error that names both files.
 */
export function findNamedEntry(
  index: ProjectIndex,
  kind: ProjectFileKind,
  name: string
): ProjectIndexEntry | undefined {
  const matches = entriesOfKind(index, kind).filter((entry) => documentName(entry) === name);
  const duplicates = duplicateIdentityIssues(matches, () => name, `${kind} name`);
  if (duplicates.length > 0) throw new ProjectIndexError(duplicates);
  return matches[0];
}
