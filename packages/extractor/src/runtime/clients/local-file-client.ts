import { realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommandError } from '@bobsled-inc/protocol';

import type {
  DownloadedFile,
  FileStorageClient,
  ListedFile,
  ListFilesOptions,
} from '../../framework/core/index.js';

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function globToRegExp(pattern: string): RegExp {
  if (pattern.length > 240) {
    throw new CommandError('Glob pattern exceeds 240 characters');
  }
  const wildcardRuns = pattern.match(/[*?]{4,}/g);
  if (wildcardRuns) {
    throw new CommandError('Glob pattern contains too many consecutive wildcards');
  }
  const wildcardCount = [...pattern].filter((char) => char === '*' || char === '?').length;
  if (wildcardCount > 40) {
    throw new CommandError('Glob pattern contains too many wildcards');
  }
  const normalized = pattern.split(path.sep).join('/');
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char ? char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') : '';
    }
  }
  out += '$';
  return new RegExp(out);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function assertInsideBase(baseDirectory: string, targetPath: string): void {
  const realBase = realpathSync(baseDirectory);
  let realTarget: string;
  try {
    realTarget = realpathSync(targetPath);
  } catch {
    // Path doesn't exist yet; fall back to lexical check
    const relative = path.relative(baseDirectory, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new CommandError(`File path escapes base_directory: ${targetPath}`);
    }
    return;
  }
  const relative = path.relative(realBase, realTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CommandError(`File path escapes base_directory: ${targetPath}`);
  }
}

export class LocalFileStorageClient implements FileStorageClient {
  private readonly baseDirectory: string;

  constructor(connection: { base_directory: string }) {
    this.baseDirectory = path.resolve(connection.base_directory);
  }

  async *list(options: ListFilesOptions): AsyncGenerator<ListedFile> {
    const pattern = options.path;
    const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
    let emitted = 0;

    if (!hasGlob(pattern)) {
      const target = path.resolve(this.baseDirectory, pattern);
      assertInsideBase(this.baseDirectory, target);
      const info = await stat(target);
      if (info.isFile()) {
        yield this.toListedFile(target, info);
      }
      return;
    }

    const matcher = globToRegExp(pattern);
    for await (const fullPath of walk(this.baseDirectory)) {
      if (emitted >= maxFiles) {
        return;
      }
      const relativePath = path.relative(this.baseDirectory, fullPath).split(path.sep).join('/');
      if (!matcher.test(relativePath)) {
        continue;
      }
      const info = await stat(fullPath);
      yield this.toListedFile(fullPath, info);
      emitted += 1;
    }
  }

  async download(file: ListedFile, targetPath: string): Promise<DownloadedFile> {
    const sourcePath = path.resolve(this.baseDirectory, file.path);
    assertInsideBase(this.baseDirectory, sourcePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    return { file, path: targetPath, bytes_downloaded: file.size ?? (await stat(targetPath)).size };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  private toListedFile(
    fullPath: string,
    info: { mtime: Date; mtimeMs?: number; size: number }
  ): ListedFile {
    const relativePath = path.relative(this.baseDirectory, fullPath).split(path.sep).join('/');
    return {
      path: relativePath,
      uri: pathToFileURL(fullPath).href,
      last_modified: info.mtime.toISOString(),
      etag: `${info.size}-${Math.trunc(info.mtimeMs ?? info.mtime.getTime())}`,
      size: info.size,
    };
  }
}
