import * as path from 'node:path';

export interface FileDestination {
  publish(localPath: string, destPath: string): Promise<string>;
}

export function normalizeDestinationPath(destPath: string): string {
  const normalized = path.posix.normalize(destPath.replaceAll('\\', '/')).replace(/^\/+/, '');

  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`Invalid destination path "${destPath}"`);
  }

  return normalized;
}
