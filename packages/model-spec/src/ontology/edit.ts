import {
  constants,
  closeSync,
  openSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  assertCompleteProjectIndex,
  indexProjectFiles,
  projectPathProblem,
  scanProject,
} from '@bobsled-inc/project-index';
import { CommandError } from '../errors.js';
import { applyPatch, writeYamlDocument } from '../edit/yaml-document.js';
import { assertBounded, parseOssieYaml } from '../interchange/common.js';
import { readConversionText } from '../interchange/files.js';
import { parseOntologyDocument } from './schema.js';
import { loadOntologyCatalog } from './catalog.js';

export interface OntologyEditRequest {
  path: string;
  content?: string;
  patch?: Record<string, unknown>;
  delete?: boolean;
  apply?: boolean;
}
/** Only existing, real parent directories are accepted. File creation is exclusive. */
function checkedPath(root: string, relative: string): string {
  if (projectPathProblem(relative) || !/\.ya?ml$/u.test(relative)) {
    throw new CommandError('Invalid ontology YAML path.', 2);
  }
  let current = realpathSync(root);
  const segments = relative.split('/');
  for (const part of segments.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CommandError('Ontology parents must be real directories.', 2);
    }
  }
  const target = join(current, segments.at(-1)!);
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new CommandError('Ontology file cannot be a symbolic link.', 2);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}
export function editOntologyFile(root: string, request: OntologyEditRequest) {
  const target = checkedPath(root, request.path);
  if (
    [request.content !== undefined, request.patch !== undefined, request.delete === true].filter(
      Boolean
    ).length !== 1
  ) {
    throw new CommandError('Supply exactly one of content (create), patch, or delete.', 2);
  }
  const index = scanProject(root);
  assertCompleteProjectIndex(index);
  const existing = index.entries.find((e) => e.path === request.path);
  if (request.content !== undefined && existing) {
    throw new CommandError('Ontology creation never overwrites a file.', 2);
  }
  const previous =
    request.content === undefined
      ? parseOntologyDocument(parseOssieYaml(readConversionText(target), request.path))
      : undefined;
  let content: string | undefined;
  if (!request.delete) {
    if (request.content !== undefined) content = request.content;
    else {
      assertBounded(request.patch);
      const doc = parseDocument(readConversionText(target));
      if (doc.errors.length) throw new CommandError('Invalid YAML document.', 2);
      applyPatch(doc, [], request.patch!);
      content = doc.toString();
    }
    parseOntologyDocument(parseOssieYaml(content, request.path));
  }
  const affectedPaths = index.entries
    .filter((e) => {
      const d = e.document as Record<string, unknown> | undefined;
      return (
        previous?.type === 'ontology' &&
        d?.['type'] === 'ontology_mapping' &&
        (d['ontology_ref'] as { name?: string } | undefined)?.name === previous.name
      );
    })
    .map((e) => e.path);
  const next = indexProjectFiles([
    ...index.entries
      .filter((e) => e.path !== request.path)
      .map((e) => ({ path: e.path, content: e.content })),
    ...(content === undefined ? [] : [{ path: request.path, content }]),
  ]);
  const validation = loadOntologyCatalog(next);
  if (request.apply) {
    checkedPath(root, request.path);
    if (request.delete) unlinkSync(target);
    else if (request.content !== undefined) {
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        writeFileSync(fd, content!);
      } finally {
        closeSync(fd);
      }
    } else {
      const result = writeYamlDocument(target, content!);
      if (!result.ok) throw new CommandError(result.error, 1);
    }
  }
  return {
    path: request.path,
    content,
    deleted: request.delete === true,
    applied: request.apply === true,
    affectedPaths,
    diagnostics: validation.diagnostics,
  };
}
