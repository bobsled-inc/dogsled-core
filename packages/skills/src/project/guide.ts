import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import {
  assertWithinRoot,
  decodeUtf8,
  normalizeDocumentText,
  parseYamlFrontMatter,
  splitFrontMatter,
  toDocumentIssues,
} from './document.js';
import { ProjectGuideValidationError, projectGuideError } from './errors.js';
import {
  PROJECT_GUIDE_FILE_NAME,
  PROJECT_GUIDE_MAX_FILE_BYTES,
  ProjectGuideFrontMatterSchema,
  type ProjectGuide,
} from './schema.js';

export interface LoadProjectGuideDocumentOptions {
  maxFileBytes?: number;
}

interface GuideDocumentParts {
  description?: string;
  body: string;
}

interface GuideFile {
  filePath: string;
  realRoot: string;
  symbolicLink: boolean;
}

const MISSING_ROOT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const UNREADABLE_LINK_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function hashProjectGuide(guide: Pick<ProjectGuide, 'path' | 'description' | 'content'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        path: guide.path,
        description: guide.description ?? null,
        content: guide.content,
      })
    )
    .digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseYaml(frontMatter: string, guidePath: string): unknown {
  try {
    return parseYamlFrontMatter(frontMatter, guidePath, projectGuideError);
  } catch (error) {
    if (error instanceof ProjectGuideValidationError) return undefined;
    throw error;
  }
}

function splitGuideDocument(normalized: string, guidePath: string): GuideDocumentParts {
  if (!normalized.startsWith('---\n')) return { body: normalized };
  const split = splitFrontMatter(normalized);
  if (!split) return { body: normalized };

  const rawFrontMatter = tryParseYaml(split.frontMatter, guidePath);
  if (!isPlainObject(rawFrontMatter)) return { body: normalized };
  if (!Object.hasOwn(rawFrontMatter, 'description') && rawFrontMatter['type'] !== 'guide') {
    return { body: normalized };
  }

  const parsed = ProjectGuideFrontMatterSchema.safeParse(rawFrontMatter);
  if (!parsed.success) {
    throw new ProjectGuideValidationError(toDocumentIssues(parsed.error.issues, guidePath));
  }
  return {
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    body: split.body,
  };
}

export function parseProjectGuide(
  rawDocument: string,
  guidePath: string = PROJECT_GUIDE_FILE_NAME
): ProjectGuide {
  const byteLength = Buffer.byteLength(rawDocument, 'utf8');
  const { description, body } = splitGuideDocument(normalizeDocumentText(rawDocument), guidePath);
  const content = body.trim();
  if (content.length === 0) {
    throw projectGuideError(guidePath, 'Markdown body must not be empty');
  }

  const guide = {
    path: guidePath,
    ...(description === undefined ? {} : { description }),
    content,
  };
  return {
    ...guide,
    contentHash: hashProjectGuide(guide),
    byteLength,
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function guideReadError(error: unknown): ProjectGuideValidationError {
  const reason = errorCode(error) ?? (error instanceof Error ? error.message : String(error));
  return projectGuideError(PROJECT_GUIDE_FILE_NAME, `cannot read file (${reason})`);
}

function hasGuideEntry(projectRoot: string): boolean {
  try {
    return readdirSync(projectRoot).includes(PROJECT_GUIDE_FILE_NAME);
  } catch (error) {
    if (MISSING_ROOT_CODES.has(errorCode(error) ?? '')) return false;
    throw guideReadError(error);
  }
}

function resolveLinkTarget(guidePath: string): string {
  try {
    return realpathSync(guidePath);
  } catch (error) {
    if (UNREADABLE_LINK_CODES.has(errorCode(error) ?? '')) {
      throw projectGuideError(PROJECT_GUIDE_FILE_NAME, 'symbolic link target cannot be read');
    }
    throw error;
  }
}

function statGuideFile(projectRoot: string, guidePath: string): GuideFile {
  const linkStat = lstatSync(guidePath);
  const realRoot = realpathSync(projectRoot);
  if (!linkStat.isSymbolicLink()) {
    if (!linkStat.isFile()) {
      throw projectGuideError(PROJECT_GUIDE_FILE_NAME, 'expected a regular file');
    }
    const filePath = realpathSync(guidePath);
    assertWithinRoot(realRoot, filePath, PROJECT_GUIDE_FILE_NAME, projectGuideError);
    return { filePath, realRoot, symbolicLink: false };
  }

  const realTarget = resolveLinkTarget(guidePath);
  const targetStat = statSync(realTarget);
  if (!targetStat.isFile()) {
    throw projectGuideError(PROJECT_GUIDE_FILE_NAME, 'symbolic link must point to a regular file');
  }
  assertWithinRoot(realRoot, realTarget, PROJECT_GUIDE_FILE_NAME, projectGuideError);
  return { filePath: realTarget, realRoot, symbolicLink: true };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedGuide(descriptor: number, maxFileBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxFileBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxFileBytes - totalBytes + 1));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxFileBytes) {
    throw projectGuideError(
      PROJECT_GUIDE_FILE_NAME,
      `file exceeds maximum of ${maxFileBytes} bytes`
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

function validateOpenedGuide(
  descriptor: number,
  guide: GuideFile,
  projectRoot: string,
  guidePath: string,
  maxFileBytes: number
): void {
  const openedStat = fstatSync(descriptor);
  if (!openedStat.isFile()) {
    throw projectGuideError(
      PROJECT_GUIDE_FILE_NAME,
      guide.symbolicLink ? 'symbolic link must point to a regular file' : 'expected a regular file'
    );
  }
  if (openedStat.size > maxFileBytes) {
    throw projectGuideError(
      PROJECT_GUIDE_FILE_NAME,
      `file is ${openedStat.size} bytes; maximum is ${maxFileBytes}`
    );
  }

  const currentRoot = realpathSync(projectRoot);
  const currentTarget = realpathSync(guidePath);
  if (currentRoot !== guide.realRoot) {
    throw projectGuideError(PROJECT_GUIDE_FILE_NAME, 'project root changed while reading file');
  }
  if (!hasGuideEntry(projectRoot)) {
    throw projectGuideError(PROJECT_GUIDE_FILE_NAME, 'file changed while being read');
  }
  assertWithinRoot(currentRoot, currentTarget, PROJECT_GUIDE_FILE_NAME, projectGuideError);
  if (!sameFile(openedStat, statSync(currentTarget))) {
    throw projectGuideError(PROJECT_GUIDE_FILE_NAME, 'file changed while being read');
  }
}

function readGuideFile(projectRoot: string, maxFileBytes: number): Buffer {
  const guidePath = path.resolve(projectRoot, PROJECT_GUIDE_FILE_NAME);
  let descriptor: number | undefined;
  try {
    const guide = statGuideFile(projectRoot, guidePath);
    descriptor = openSync(
      guide.filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
    );
    validateOpenedGuide(descriptor, guide, projectRoot, guidePath, maxFileBytes);
    return readBoundedGuide(descriptor, maxFileBytes);
  } catch (error) {
    if (error instanceof ProjectGuideValidationError) throw error;
    throw guideReadError(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadProjectGuideDocument(
  projectRoot: string,
  options: LoadProjectGuideDocumentOptions = {}
): ProjectGuide | undefined {
  if (!hasGuideEntry(projectRoot)) return undefined;

  const buffer = readGuideFile(projectRoot, options.maxFileBytes ?? PROJECT_GUIDE_MAX_FILE_BYTES);
  return parseProjectGuide(decodeUtf8(buffer, PROJECT_GUIDE_FILE_NAME, projectGuideError));
}
