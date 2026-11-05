import type { ListedFile, ListFilesOptions } from '../../framework/core/index.js';
import { globToRegExp, hasGlobWildcard } from './path-glob.js';

export type SftpAttributes = { mode?: number; size?: number; mtime?: number };
export type SftpEntry = { filename: string; longname?: string; attrs: SftpAttributes };

type Callback<T> = (error: Error | undefined, value: T) => void;

export type SftpChannel = {
  readdir(path: string, callback: Callback<SftpEntry[]>): void;
  stat(path: string, callback: Callback<SftpAttributes>): void;
  lstat(path: string, callback: Callback<SftpAttributes>): void;
  realpath(path: string, callback: Callback<string>): void;
  createReadStream(path: string): NodeJS.ReadableStream;
  fastGet(
    remotePath: string,
    localPath: string,
    options: { concurrency: number },
    callback: (error: Error | undefined) => void
  ): void;
  end(): void;
};

export type SftpListTarget = {
  host: string;
  port?: number;
  base_directory: string;
  min_file_age_seconds?: number;
};

type Kind = 'directory' | 'file' | 'link' | 'other' | 'unknown';
type Classified = { kind: Kind; attrs: SftpAttributes; viaLink: boolean };
type PendingLink = { remote: string; relative: string; lexical: string; depth: number };

const S_IFMT = 0o170000;
const KIND_BY_MODE = new Map<number, Kind>([
  [0o040000, 'directory'],
  [0o100000, 'file'],
  [0o120000, 'link'],
]);
const MAX_FOLDER_DEPTH = 64;

export function remoteJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

function kindOf(attrs: SftpAttributes | undefined): Kind {
  if (typeof attrs?.mode !== 'number') return 'unknown';
  return KIND_BY_MODE.get(attrs.mode & S_IFMT) ?? 'other';
}

function call<T>(run: (callback: Callback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value)));
  });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides which folders can hold glob matches. Segments before the first
 * `**` must match one for one, and without `**` a match is exactly as deep
 * as the glob, so deeper folders are never read.
 */
class FolderFilter {
  private readonly segments: RegExp[];
  private readonly depth: number | undefined;

  constructor(pattern: string) {
    const parts = pattern.split('/');
    const deep = parts.findIndex((part) => part.includes('**'));
    this.segments = (deep === -1 ? parts : parts.slice(0, deep)).map((part) =>
      globToRegExp(part, 'SFTP')
    );
    this.depth = deep === -1 ? parts.length : undefined;
  }

  mayContainMatches(relativeFolder: string): boolean {
    const parts = relativeFolder.split('/');
    if (this.depth !== undefined && parts.length >= this.depth) return false;
    return parts.every((part, index) => this.segments[index]?.test(part) ?? true);
  }
}

/**
 * Walks the real folder tree first and follows folder links afterwards, so a
 * folder inside the listing is always listed at its own path. Each folder is
 * read once, which also stops link loops.
 */
class SftpWalk {
  private readonly visited = new Set<string>();
  private readonly links: PendingLink[] = [];
  private readonly newestAllowed: number | undefined;
  private emitted = 0;
  private skippedRecent = 0;

  constructor(
    private readonly sftp: SftpChannel,
    private readonly target: SftpListTarget,
    private readonly options: ListFilesOptions,
    private readonly glob?: { file: RegExp; folders: FolderFilter }
  ) {
    const minAge = target.min_file_age_seconds ?? 0;
    this.newestAllowed = minAge > 0 ? Date.now() / 1000 - minAge : undefined;
  }

  async *fromFolder(remote: string, relative: string): AsyncGenerator<ListedFile> {
    yield* this.folder(remote, relative, await this.canonical(remote), 0);
    while (this.links.length > 0 && !this.full) {
      yield* this.followLink(this.links.shift()!);
    }
    await this.finish();
  }

  async *fromFile(relative: string, attrs: SftpAttributes): AsyncGenerator<ListedFile> {
    yield* this.file(relative, attrs);
    await this.finish();
  }

  private get full(): boolean {
    return Boolean(this.options.maxFiles) && this.emitted >= this.options.maxFiles!;
  }

  private async warn(message: string): Promise<void> {
    await this.options.onWarning?.(message);
  }

  private async finish(): Promise<void> {
    if (this.skippedRecent > 0) {
      await this.warn(
        `Skipped ${this.skippedRecent} SFTP file(s) modified in the last ${this.target.min_file_age_seconds} seconds; a later run reads them.`
      );
    }
  }

  private async canonical(remote: string): Promise<string> {
    try {
      return await call<string>((done) => this.sftp.realpath(remote, done));
    } catch {
      return remote;
    }
  }

  private async *file(relative: string, attrs: SftpAttributes): AsyncGenerator<ListedFile> {
    if (this.full || (this.glob && !this.glob.file.test(relative))) return;
    if (this.newestAllowed !== undefined && (attrs.mtime ?? 0) > this.newestAllowed) {
      this.skippedRecent += 1;
      return;
    }
    this.emitted += 1;
    const { host, port } = this.target;
    yield {
      path: relative,
      uri: port && port !== 22 ? `sftp://${host}:${port}/${relative}` : `sftp://${host}/${relative}`,
      last_modified: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : undefined,
      etag: attrs.mtime !== undefined ? `${attrs.mtime}-${attrs.size ?? 0}` : undefined,
      size: attrs.size,
    };
  }

  private async classify(remote: string, relative: string, attrs: SftpAttributes) {
    let kind = kindOf(attrs);
    if (kind === 'unknown') {
      try {
        attrs = await call<SftpAttributes>((done) => this.sftp.lstat(remote, done));
        kind = kindOf(attrs);
      } catch {
        kind = 'unknown';
      }
      if (kind === 'unknown') return { kind: 'file', attrs, viaLink: false } satisfies Classified;
    }
    if (kind !== 'link') return { kind, attrs, viaLink: false } satisfies Classified;
    try {
      const target = await call<SftpAttributes>((done) => this.sftp.stat(remote, done));
      const targetKind = kindOf(target);
      return {
        kind: targetKind === 'unknown' ? 'file' : targetKind,
        attrs: target,
        viaLink: true,
      } satisfies Classified;
    } catch (error) {
      await this.warn(`Skipping SFTP link ${relative}: ${reason(error)}`);
      return undefined;
    }
  }

  private async *folder(
    remote: string,
    relative: string,
    canonical: string,
    depth: number
  ): AsyncGenerator<ListedFile> {
    this.visited.add(canonical);
    let entries: SftpEntry[];
    try {
      entries = await call<SftpEntry[]>((done) => this.sftp.readdir(remote, done));
    } catch (error) {
      if (depth === 0) {
        throw new Error(`SFTP folder "${relative || '.'}" could not be read: ${reason(error)}`, {
          cause: error,
        });
      }
      await this.warn(`Skipping SFTP folder ${relative}: ${reason(error)}`);
      return;
    }
    entries.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    for (const entry of entries) {
      if (this.full) return;
      if (entry.filename === '.' || entry.filename === '..') continue;
      const childRemote = remoteJoin(remote, entry.filename);
      const childRelative = relative ? `${relative}/${entry.filename}` : entry.filename;
      const child = await this.classify(childRemote, childRelative, entry.attrs);
      if (!child) continue;
      if (child.kind === 'file') {
        yield* this.file(childRelative, child.attrs);
        continue;
      }
      if (child.kind !== 'directory') {
        await this.warn(`Skipping SFTP entry ${childRelative}: it is not a file or folder`);
        continue;
      }
      if (this.glob && !this.glob.folders.mayContainMatches(childRelative)) continue;
      if (depth + 1 > MAX_FOLDER_DEPTH) {
        await this.warn(
          `Skipping SFTP folder ${childRelative}: it is more than ${MAX_FOLDER_DEPTH} folders deep`
        );
        continue;
      }
      const lexical = remoteJoin(canonical, entry.filename);
      if (child.viaLink) {
        this.links.push({ remote: childRemote, relative: childRelative, lexical, depth });
      } else if (!this.visited.has(lexical)) {
        yield* this.folder(childRemote, childRelative, lexical, depth + 1);
      }
    }
  }

  private async *followLink(link: PendingLink): AsyncGenerator<ListedFile> {
    const canonical = await this.canonical(link.remote);
    if (canonical === link.lexical || canonical === link.remote) {
      await this.warn(
        `Skipping SFTP link ${link.relative}: the server does not report the folder it points to`
      );
      return;
    }
    if (this.visited.has(canonical)) {
      await this.warn(
        `Skipping SFTP link ${link.relative}: this listing already reads the folder it points to`
      );
      return;
    }
    yield* this.folder(link.remote, link.relative, canonical, link.depth + 1);
  }
}

/**
 * List SFTP files with the same glob rules as S3. A path without wildcards
 * names one file, or a folder whose files are all listed. Links are followed;
 * subfolders that cannot be read are skipped with a warning.
 */
export async function* listSftpFiles(
  sftp: SftpChannel,
  target: SftpListTarget,
  options: ListFilesOptions
): AsyncGenerator<ListedFile> {
  const pattern = options.path.replace(/\/+/g, '/');
  if (!hasGlobWildcard(pattern)) {
    const relative = pattern.replace(/\/$/, '');
    const remote = remoteJoin(target.base_directory, relative);
    let attrs: SftpAttributes;
    try {
      attrs = await call<SftpAttributes>((done) => sftp.stat(remote, done));
    } catch (error) {
      throw new Error(`SFTP path "${relative}" could not be read: ${reason(error)}`, {
        cause: error,
      });
    }
    const walk = new SftpWalk(sftp, target, options);
    if (kindOf(attrs) === 'directory') {
      yield* walk.fromFolder(remote, relative);
    } else {
      yield* walk.fromFile(relative, attrs);
    }
    return;
  }
  const staticPrefix = pattern.replace(/[*?].*$/, '');
  const rootRelative = staticPrefix.slice(0, staticPrefix.lastIndexOf('/') + 1).replace(/\/$/, '');
  const walk = new SftpWalk(sftp, target, options, {
    file: globToRegExp(pattern, 'SFTP'),
    folders: new FolderFilter(pattern),
  });
  yield* walk.fromFolder(remoteJoin(target.base_directory, rootRelative), rootRelative);
}
