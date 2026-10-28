import { lstatSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';

import type { ProjectDocumentIssue, ProjectDocumentValidationError } from './errors.js';

export type ProjectDocumentErrorFactory = (
  path: string,
  message: string
) => ProjectDocumentValidationError;

export {
  FRONT_MATTER_PATTERN,
  normalizeDocumentText,
  splitFrontMatter,
  stripByteOrderMark,
  type FrontMatterSplit,
} from '@bobsled-inc/project-index';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function parseYamlFrontMatter(
  raw: string,
  filePath: string,
  error: ProjectDocumentErrorFactory
): unknown {
  try {
    return parseYaml(raw, { uniqueKeys: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw error(filePath, `invalid YAML front matter: ${message}`);
  }
}

export function toDocumentIssues(
  zodIssues: ZodError['issues'],
  filePath: string
): ProjectDocumentIssue[] {
  return zodIssues.map((issue) => ({
    path: [filePath, ...issue.path.map(String)].join(':'),
    message: issue.message,
  }));
}

export function decodeUtf8(
  buffer: Buffer,
  filePath: string,
  error: ProjectDocumentErrorFactory
): string {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw error(filePath, 'file must contain valid UTF-8');
  }
}

export function assertWithinRoot(
  realRoot: string,
  realTarget: string,
  relativePath: string,
  error: ProjectDocumentErrorFactory
): void {
  const relative = path.relative(realRoot, realTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw error(relativePath, 'resolved path escapes the project root');
  }
}

export function assertRegularUnlinkedPath(
  absolutePath: string,
  relativePath: string,
  kind: 'file' | 'directory',
  error: ProjectDocumentErrorFactory,
  symlinkMessage: string
): void {
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw error(relativePath, symlinkMessage);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw error(relativePath, `expected a regular ${kind}`);
  }
}
