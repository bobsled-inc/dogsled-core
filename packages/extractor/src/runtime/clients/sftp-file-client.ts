import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type {
  DownloadedFile,
  FileStorageClient,
  ListedFile,
  ListFilesOptions,
} from '../../framework/core/index.js';
import { connectToValidatedHost } from '../../framework/core/index.js';
import { ExtractorConfigError } from '../errors.js';

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  // The caller supplies only the literal optional dependency name below.
  // Function-based import keeps that dependency optional during bundling; never
  // pass a specifier derived from project config, environment, or record data.
  return (await new Function('s', 'return import(s)')(specifier)) as Record<string, unknown>;
}

function readRequiredEnv(name: string | undefined, field: string): string {
  if (!name) {
    throw new ExtractorConfigError(`SFTP auth ${field} is required`);
  }
  const value = process.env[name];
  if (!value) {
    throw new ExtractorConfigError(`SFTP auth ${field} references missing env var ${name}`);
  }
  return value;
}

type SftpEntry = {
  filename: string;
  longname?: string;
  attrs: { isDirectory?: () => boolean; isFile?: () => boolean; mtime?: number; size?: number };
};
type SftpConnection = {
  readdir(pathname: string, callback: (err: Error | undefined, list: SftpEntry[]) => void): void;
  createReadStream(pathname: string): NodeJS.ReadableStream;
  end(): void;
};

function normalizeFingerprint(value: string): string {
  return value.trim().replace(/^SHA256:/i, '');
}

async function loadAllowedFingerprints(auth: {
  host_fingerprint?: string;
  known_hosts_path?: string;
}): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (auth.host_fingerprint) {
    allowed.add(normalizeFingerprint(auth.host_fingerprint));
  }
  if (auth.known_hosts_path) {
    const contents = await readFile(auth.known_hosts_path, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const sha256 = trimmed.match(/SHA256:([A-Za-z0-9+/=]+)/i);
      if (sha256?.[1]) {
        allowed.add(normalizeFingerprint(sha256[1]));
      }
    }
  }
  return allowed;
}

function remoteJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

function assertSafeProviderPath(filePath: string): void {
  if (
    filePath.includes('\0') ||
    filePath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.split(/[/\\]/).some((segment) => segment === '..' || segment === '')
  ) {
    throw new ExtractorConfigError(`Unsafe SFTP file path: ${filePath}`);
  }
}

export class SftpFileStorageClient implements FileStorageClient {
  private constructor(
    private readonly connection: {
      host: string;
      port?: number;
      username: string;
      base_directory: string;
    },
    private readonly sftp: SftpConnection
  ) {}

  static async create(
    connection: { host: string; port?: number; username: string; base_directory: string },
    auth: {
      type: string;
      password_env?: string;
      private_key_path_env?: string;
      passphrase_env?: string;
      host_fingerprint?: string;
      known_hosts_path?: string;
    },
    injected?: { sftp?: SftpConnection },
    authEnvVars: readonly string[] = []
  ): Promise<SftpFileStorageClient> {
    assertDeclaredEnvironmentReferences(auth, authEnvVars);
    if (injected?.sftp) {
      return new SftpFileStorageClient(connection, injected.sftp);
    }
    const mod = await importModule('ssh2');
    const Client = mod['Client'] as new () => {
      on(event: string, callback: (...args: unknown[]) => void): unknown;
      connect(options: Record<string, unknown>): void;
      sftp(callback: (err: Error | undefined, sftp: SftpConnection) => void): void;
    };
    const client = new Client();
    const privateKeyPath =
      auth.type === 'private_key'
        ? readRequiredEnv(auth.private_key_path_env, 'private_key_path_env')
        : undefined;
    const privateKey = privateKeyPath ? await readFile(privateKeyPath, 'utf8') : undefined;
    const allowedFingerprints = await loadAllowedFingerprints(auth);
    if (allowedFingerprints.size === 0) {
      throw new ExtractorConfigError(
        'SFTP auth requires host_fingerprint or known_hosts_path with valid SHA256 entries'
      );
    }
    const socket = await connectToValidatedHost(connection.host, connection.port ?? 22);
    const sftp = await new Promise<SftpConnection>((resolve, reject) => {
      client.on('ready', () => {
        client.sftp((err, handle) => (err ? reject(err) : resolve(handle)));
      });
      client.on('error', (error) => {
        socket.destroy();
        reject(error);
      });
      client.connect({
        sock: socket,
        username: connection.username,
        password:
          auth.type === 'password' ? readRequiredEnv(auth.password_env, 'password_env') : undefined,
        privateKey,
        passphrase: auth.passphrase_env
          ? readRequiredEnv(auth.passphrase_env, 'passphrase_env')
          : undefined,
        hostHash: 'sha256',
        // ssh2 provides the SHA256 hash as a hex digest; convert to base64 to match SSH fingerprint format (SHA256:<base64>)
        hostVerifier: (hash: string) =>
          allowedFingerprints.has(Buffer.from(hash, 'hex').toString('base64')),
      });
    });
    return new SftpFileStorageClient(connection, sftp);
  }

  async *list(options: ListFilesOptions): AsyncGenerator<ListedFile> {
    const prefix = options.path.replace(/[*?].*$/, '');
    const root = remoteJoin(this.connection.base_directory, prefix);
    let emitted = 0;
    for await (const file of this.walk(root)) {
      if (options.maxFiles && emitted >= options.maxFiles) {
        return;
      }
      yield file;
      emitted += 1;
    }
  }

  async download(file: ListedFile, targetPath: string): Promise<DownloadedFile> {
    assertSafeProviderPath(file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await pipeline(
      this.sftp.createReadStream(remoteJoin(this.connection.base_directory, file.path)),
      createWriteStream(targetPath)
    );
    return { file, path: targetPath, bytes_downloaded: file.size ?? 0 };
  }

  async close(): Promise<void> {
    this.sftp.end();
  }

  private async *walk(remotePath: string): AsyncGenerator<ListedFile> {
    const entries = await new Promise<SftpEntry[]>((resolve, reject) => {
      this.sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)));
    });
    for (const entry of entries) {
      const fullPath = remoteJoin(remotePath, entry.filename);
      if (entry.attrs.isDirectory?.()) {
        yield* this.walk(fullPath);
      } else {
        const base = this.connection.base_directory.replace(/\/+$/, '') + '/';
        const relative = fullPath.startsWith(base) ? fullPath.slice(base.length) : fullPath;
        yield {
          path: relative,
          uri:
            this.connection.port && this.connection.port !== 22
              ? `sftp://${this.connection.host}:${this.connection.port}/${relative}`
              : `sftp://${this.connection.host}/${relative}`,
          last_modified: entry.attrs.mtime
            ? new Date(entry.attrs.mtime * 1000).toISOString()
            : undefined,
          etag:
            entry.attrs.mtime !== undefined
              ? `${entry.attrs.mtime}-${entry.attrs.size ?? 0}`
              : undefined,
          size: entry.attrs.size,
        };
      }
    }
  }
}
