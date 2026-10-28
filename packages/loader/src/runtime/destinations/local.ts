import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeDestinationPath, type FileDestination } from './types.js';

interface FileSystemLike {
  copyFile(source: string, destination: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface LocalDestinationOptions {
  outputDir: string;
  fileSystem?: FileSystemLike;
}

export class LocalDestination implements FileDestination {
  private readonly outputDir: string;
  private readonly fs: FileSystemLike;

  constructor(options: LocalDestinationOptions) {
    this.outputDir = path.resolve(options.outputDir);
    this.fs = options.fileSystem ?? {
      copyFile: (source, destination) => fs.copyFile(source, destination),
      mkdir: (dirPath, mkdirOptions) => fs.mkdir(dirPath, mkdirOptions),
      rename: (source, destination) => fs.rename(source, destination),
      unlink: (filePath) => fs.unlink(filePath),
    };
  }

  async publish(localPath: string, destPath: string): Promise<string> {
    const normalizedPath = normalizeDestinationPath(destPath);
    const segments = normalizedPath.split('/');
    const absoluteDestination = path.resolve(this.outputDir, ...segments);
    const prefix = this.outputDir.endsWith(path.sep)
      ? this.outputDir
      : `${this.outputDir}${path.sep}`;

    if (absoluteDestination !== this.outputDir && !absoluteDestination.startsWith(prefix)) {
      throw new Error(`Invalid destination path "${destPath}"`);
    }

    await this.fs.mkdir(path.dirname(absoluteDestination), { recursive: true });

    try {
      await this.fs.rename(localPath, absoluteDestination);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'EXDEV'
      ) {
        await this.fs.copyFile(localPath, absoluteDestination);
        await this.fs.unlink(localPath);
      } else {
        throw error;
      }
    }

    return pathToFileURL(absoluteDestination).href;
  }
}
