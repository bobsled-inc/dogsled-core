import type { Socket } from 'node:net';
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

import { assertDeclaredEnvironmentReferences, DogsledRuntimeError } from '@bobsled-inc/protocol';
import type {
  Client,
  ConnectConfig,
  FileEntryWithStats,
  ServerHostKeyAlgorithm,
  SFTPWrapper,
  Stats,
} from 'ssh2';

import type {
  DownloadedFile,
  DownloadFileOptions,
  FileStorageClient,
  ListedFile,
  ListFilesOptions,
  SftpFileStorageAuth,
  SftpFileStorageConnection,
} from '../../framework/core/index.js';
import {
  connectToValidatedHost,
  sftpHostKeyPinFingerprint,
  sshKeyBlobType,
  sshKeyFingerprint,
} from '../../framework/core/index.js';
import { ExtractorConfigError, ExtractorDataError } from '../errors.js';
import { globToRegExp } from './path-glob.js';
import { sftpError, type SftpErrorCode } from './sftp-errors.js';

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 4;
const IDLE_TIMEOUT_MS = 60_000;
const READ_CHUNK_BYTES = 65_536;
const SFTP_STATUS_EOF = 1;
const SFTP_STATUS_NO_SUCH_FILE = 2;
const SFTP_STATUS_PERMISSION_DENIED = 3;

type SftpTimeouts = { idleMs: number; readyMs: number; keepaliveIntervalMs: number };

function readRequiredEnv(name: string | undefined, field: string): string {
  // The schema guarantees the field; this guards callers that bypass it.
  if (!name) throw new ExtractorConfigError(`SFTP auth ${field} is required`);
  const value = process.env[name];
  if (!value) {
    throw new ExtractorConfigError(`SFTP auth ${field} references missing env var ${name}`);
  }
  return value;
}

function remoteJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

function isInside(base: string, target: string): boolean {
  return target.startsWith(base.endsWith('/') ? base : `${base}/`);
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

/** ssh2 algorithm names to offer for the pinned key types, in pin order. */
function serverHostKeyAlgorithms(
  pins: SftpFileStorageConnection['host_keys']
): ServerHostKeyAlgorithm[] {
  const names = pins.flatMap((pin): ServerHostKeyAlgorithm[] =>
    pin.algorithm === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [pin.algorithm]
  );
  return [...new Set(names)];
}

function hostKeyMatches(pins: SftpFileStorageConnection['host_keys'], blob: Buffer): boolean {
  const type = sshKeyBlobType(blob);
  const fingerprint = sshKeyFingerprint(blob);
  return pins.some(
    (pin) =>
      pin.algorithm === type &&
      (pin.public_key
        ? Buffer.from(pin.public_key, 'base64').equals(blob)
        : sftpHostKeyPinFingerprint(pin) === fingerprint)
  );
}

type HandshakeFacts = {
  hostKeyRejected: boolean;
  subsystemRefused: boolean;
  bytesSeen: number;
  sawBanner: boolean;
};

// ssh2 handshake failures that mean the peer's host key is not the pinned key it claims.
const HOST_KEY_FAILURE =
  /signature verification failed|Malformed signature|malformed host public key|Host key does not match negotiated type/;

function classifyConnectFailure(error: Error | undefined, facts: HandshakeFacts): SftpErrorCode {
  const message = error?.message ?? '';
  const level = (error as { level?: string } | undefined)?.level;
  if (facts.hostKeyRejected || HOST_KEY_FAILURE.test(message)) return 'SFTP_HOST_KEY_MISMATCH';
  if (message.includes('no matching host key format')) return 'SFTP_HOST_KEY_TYPE_UNAVAILABLE';
  if (message.startsWith('Handshake failed: no matching')) return 'SFTP_NO_MATCHING_ALGORITHM';
  if (level === 'client-authentication') return 'SFTP_AUTH_FAILED';
  if (level === 'client-timeout') return 'SFTP_TIMEOUT';
  if (/identification|greeting|Header line|Invalid header/.test(message)) return 'SFTP_NOT_SSH';
  if (!facts.sawBanner) return facts.bytesSeen > 0 ? 'SFTP_NOT_SSH' : 'SFTP_CONNECT_FAILED';
  if (facts.subsystemRefused) return 'SFTP_SUBSYSTEM_UNAVAILABLE';
  return 'SFTP_CONNECTION_LOST';
}

function lostConnectionError(error: Error | undefined, op: string): DogsledRuntimeError {
  const level = (error as { level?: string } | undefined)?.level;
  return sftpError(level === 'client-timeout' ? 'SFTP_TIMEOUT' : 'SFTP_CONNECTION_LOST', op, error);
}

function sftpStatus(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** Node system error code (ENOSPC, EACCES, ...) of a local file operation. */
function localErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** FileHandle.write may write fewer bytes than asked; finish the chunk or fail. */
async function writeAll(out: FileHandle, chunk: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < chunk.length) {
    const { bytesWritten } = await out.write(
      chunk,
      written,
      chunk.length - written,
      position + written
    );
    if (bytesWritten === 0) {
      throw Object.assign(new Error('Local write made no progress'), { code: 'EIO' });
    }
    written += bytesWritten;
  }
}

export class SftpFileStorageClient implements FileStorageClient {
  private failure?: DogsledRuntimeError;
  private closed = false;
  private realBase?: Promise<string>;
  private readonly pending = new Set<(error: DogsledRuntimeError) => void>();

  private constructor(
    private readonly connection: SftpFileStorageConnection,
    private readonly sftp: SFTPWrapper,
    private readonly ssh: Client | undefined,
    private readonly timeouts: SftpTimeouts
  ) {}

  static async create(
    connection: SftpFileStorageConnection,
    auth: SftpFileStorageAuth,
    injected?: { sftp?: SFTPWrapper; timeouts?: Partial<SftpTimeouts> },
    authEnvVars: readonly string[] = []
  ): Promise<SftpFileStorageClient> {
    assertDeclaredEnvironmentReferences(auth, authEnvVars);
    const timeouts: SftpTimeouts = {
      idleMs: IDLE_TIMEOUT_MS,
      readyMs: READY_TIMEOUT_MS,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      ...injected?.timeouts,
    };
    if (injected?.sftp) {
      return new SftpFileStorageClient(connection, injected.sftp, undefined, timeouts);
    }
    const credentials: Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'> =
      auth.type === 'password'
        ? { password: readRequiredEnv(auth.password_env, 'password_env') }
        : {
            privateKey: auth.private_key_env
              ? readRequiredEnv(auth.private_key_env, 'private_key_env')
              : await readFile(
                  readRequiredEnv(auth.private_key_path_env, 'private_key_path_env'),
                  'utf8'
                ),
            passphrase: auth.passphrase_env
              ? readRequiredEnv(auth.passphrase_env, 'passphrase_env')
              : undefined,
          };
    // Optional peer dependency, kept external by tsup and loaded only for SFTP sources.
    const ssh2 = await import('ssh2').catch((error: unknown) => {
      throw new ExtractorConfigError(
        'SFTP sources need the optional "ssh2" package (npm install ssh2@^1.17.0)',
        error instanceof Error ? error : undefined
      );
    });
    const { Client: SshClient } = ssh2.default;

    let socket: Socket;
    try {
      socket = await connectToValidatedHost(
        connection.host,
        connection.port ?? 22,
        timeouts.readyMs
      );
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === 'string') {
        throw sftpError('SFTP_CONNECT_FAILED', 'connect', error);
      }
      if (error instanceof Error && error.message.includes('timed out')) {
        throw sftpError('SFTP_TIMEOUT', 'connect', error);
      }
      throw error; // SSRF policy refusals stay explicit.
    }

    const ssh = new SshClient();
    const facts: HandshakeFacts = {
      hostKeyRejected: false,
      subsystemRefused: false,
      bytesSeen: 0,
      sawBanner: false,
    };
    // After the handshake, connection-level events go to the client instead.
    const session: { client?: SftpFileStorageClient; lost?: DogsledRuntimeError } = {};
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error | undefined) => {
        if (settled) {
          session.lost ??= lostConnectionError(error, 'session');
          if (session.client && !session.client.closed) session.client.fail(session.lost);
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(sftpError(classifyConnectFailure(error, facts), 'connect', error));
      };
      const timer = setTimeout(() => {
        const error = new Error('Timed out while opening the SFTP session') as Error & {
          level: string;
        };
        error.level = 'client-timeout';
        fail(error);
      }, timeouts.readyMs);
      ssh.on('error', fail);
      ssh.on('close', () => fail(undefined));
      ssh.on('ready', () => {
        ssh.sftp((error, handle) => {
          if (error) {
            // The session is up but the server will not start SFTP for this account.
            facts.subsystemRefused = socket.writable;
            return fail(error);
          }
          settled = true;
          clearTimeout(timer);
          handle.on('close', () => fail(undefined));
          resolve(handle);
        });
      });
      try {
        ssh.connect({
          sock: socket,
          username: connection.username,
          ...credentials,
          readyTimeout: timeouts.readyMs,
          keepaliveInterval: timeouts.keepaliveIntervalMs,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          algorithms: {
            serverHostKey: serverHostKeyAlgorithms(connection.host_keys),
          },
          hostVerifier: (key: Buffer) => {
            const accepted = hostKeyMatches(connection.host_keys, key);
            facts.hostKeyRejected = !accepted;
            return accepted;
          },
        });
      } catch (error) {
        // ssh2 throws synchronously for an unusable private key or passphrase.
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(
          new ExtractorConfigError(
            `SFTP auth is invalid: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return;
      }
      // ssh2 attached its own reader inside connect(); this tap only watches for the banner.
      // Buffered, because TCP may split the banner across chunks.
      let head = '';
      const tap = (chunk: Buffer) => {
        facts.bytesSeen += chunk.length;
        head += chunk.toString('latin1');
        facts.sawBanner ||= /(^|\n)SSH-/.test(head);
        if (facts.sawBanner || facts.bytesSeen > 65_536) socket.off('data', tap);
      };
      socket.on('data', tap);
    });

    session.client = new SftpFileStorageClient(connection, sftp, ssh, timeouts);
    if (session.lost) session.client.fail(session.lost);
    return session.client;
  }

  async *list(options: ListFilesOptions): AsyncGenerator<ListedFile> {
    const literal = options.path.replace(/[*?].*$/, '');
    // A glob walks from the folder before its first wildcard and keeps only matching paths.
    const matcher = literal === options.path ? undefined : globToRegExp(options.path, 'SFTP');
    const prefix = matcher ? literal.slice(0, literal.lastIndexOf('/') + 1) : literal;
    const root = remoteJoin(this.connection.base_directory, prefix);
    if (!matcher && prefix !== '' && !prefix.endsWith('/')) {
      // A path without a glob may name one file; a folder is walked as before.
      const attrs = await this.statNamedFile(root, prefix, options.signal);
      if (attrs) {
        if (options.maxFiles !== 0) yield this.toListed(root, attrs);
        return;
      }
    }
    let emitted = 0;
    for await (const file of this.walk(root, true, options.signal)) {
      if (options.maxFiles && emitted >= options.maxFiles) {
        return;
      }
      if (matcher && !matcher.test(file.path)) continue;
      yield file;
      emitted += 1;
    }
  }

  async download(
    file: ListedFile,
    targetPath: string,
    options?: DownloadFileOptions
  ): Promise<DownloadedFile> {
    assertSafeProviderPath(file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const signal = options?.signal;
    const realBase = await this.resolveRealBase(signal);
    const remotePath = remoteJoin(this.connection.base_directory, file.path);
    let realPath: string;
    try {
      realPath = await this.run<string>(
        'realpath',
        (done) => this.sftp.realpath(remotePath, done),
        signal
      );
    } catch (error) {
      throw this.fileError(error, file.path);
    }
    if (!isInside(realBase, realPath)) {
      throw new ExtractorDataError(`SFTP file ${file.path} resolves outside base_directory`);
    }
    try {
      // Download the resolved path so a later symlink swap cannot redirect the read.
      await this.readRanges(realPath, targetPath, file.size, signal);
    } catch (error) {
      throw this.fileError(error, file.path);
    }
    return { file, path: targetPath, bytes_downloaded: (await stat(targetPath)).size };
  }

  /**
   * Bounded ranged reader: up to read_concurrency READs in flight, each under the idle
   * timeout, written at their offsets. The size comes from FSTAT or the listing; when
   * neither has it, one sequential read runs until EOF.
   */
  private async readRanges(
    remotePath: string,
    targetPath: string,
    listedSize: number | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    const handle = await this.run<Buffer>(
      'open',
      (done) => this.sftp.open(remotePath, 'r', done),
      signal
    );
    const out = await open(targetPath, 'w');
    try {
      const attrs = await this.run<Stats>(
        'fstat',
        (done) => this.sftp.fstat(handle, done),
        signal
      ).catch((error: unknown) => {
        if (sftpStatus(error) === undefined) throw error;
        return undefined;
      });
      const size = attrs?.size ?? listedSize;
      let next = 0;
      let stop = false;
      const readAt = (offset: number, length: number) =>
        this.run<number>(
          'read',
          (done) => {
            const buffer = Buffer.allocUnsafe(length);
            this.sftp.read(handle, buffer, 0, length, offset, (error, bytesRead) => {
              if (error) return done(error);
              writeAll(out, buffer.subarray(0, bytesRead), offset).then(
                () => done(undefined, bytesRead),
                done
              );
            });
          },
          signal
        ).catch((error: unknown) => {
          if (sftpStatus(error) === SFTP_STATUS_EOF) return 0;
          throw error;
        });
      const worker = async () => {
        while (!stop && (size === undefined || next < size)) {
          let offset = next;
          const end =
            size === undefined
              ? offset + READ_CHUNK_BYTES
              : Math.min(offset + READ_CHUNK_BYTES, size);
          next = end;
          // Servers may answer with fewer bytes than asked; read the rest of the range.
          while (offset < end) {
            const bytesRead = await readAt(offset, end - offset);
            if (bytesRead === 0) {
              stop = true; // EOF: the file is shorter than expected (or size was unknown)
              return;
            }
            offset += bytesRead;
          }
        }
      };
      const guarded = () =>
        worker().catch((error: unknown) => {
          stop = true; // the other workers finish their current READ and stop
          throw error;
        });
      const workers = size === undefined ? 1 : this.connection.read_concurrency;
      // allSettled: no READ may still write to `out` after it is closed below.
      const results = await Promise.allSettled(Array.from({ length: workers }, guarded));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await out.close();
      await this.run<void>('close', (done) => this.sftp.close(handle, done), signal).catch(
        () => undefined
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ssh) this.ssh.end();
    else this.sftp.end();
  }

  /** Destroy the connection and reject every pending operation with `error`. */
  private fail(error: DogsledRuntimeError): void {
    if (this.failure) return;
    this.failure = error;
    if (this.ssh) this.ssh.destroy();
    else this.sftp.end();
    for (const reject of [...this.pending]) reject(error);
  }

  /** Run one SFTP request under the idle timeout. */
  private run<T>(
    op: string,
    start: (done: (error: Error | null | undefined, value?: T) => void) => void,
    signal?: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (signal?.aborted) return reject(sftpError('SFTP_CANCELLED', op, signal.reason));
      let settled = false;
      const timer = setTimeout(
        () => this.fail(sftpError('SFTP_TIMEOUT', op)),
        this.timeouts.idleMs
      );
      const onAbort = () => this.fail(sftpError('SFTP_CANCELLED', op, signal?.reason));
      const finish = (error: Error | undefined, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(finish);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value as T);
      };
      this.pending.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        start((error, value) => {
          if (!error) return finish(undefined, value);
          // A status reply or a local file error is per-request; anything else means the session is gone.
          if (sftpStatus(error) !== undefined || localErrorCode(error) !== undefined) {
            return finish(error);
          }
          this.fail(this.failure ?? lostConnectionError(error, op));
          finish(this.failure);
        });
      } catch (error) {
        // ssh2 throws synchronously when the channel is already closed.
        this.fail(lostConnectionError(error instanceof Error ? error : undefined, op));
        finish(this.failure);
      }
    });
  }

  private resolveRealBase(signal?: AbortSignal): Promise<string> {
    this.realBase ??= this.run<string>(
      'realpath',
      (done) => this.sftp.realpath(this.connection.base_directory, done),
      signal
    ).catch((error: unknown) => {
      this.realBase = undefined;
      throw this.rootError(error);
    });
    return this.realBase;
  }

  private rootError(error: unknown): unknown {
    const status = sftpStatus(error);
    if (status === SFTP_STATUS_NO_SUCH_FILE) return sftpError('SFTP_PATH_NOT_FOUND', 'list', error);
    if (status === SFTP_STATUS_PERMISSION_DENIED) {
      return sftpError('SFTP_PERMISSION_DENIED', 'list', error);
    }
    return this.fileError(error, this.connection.base_directory);
  }

  private fileError(error: unknown, filePath: string): unknown {
    if (error instanceof DogsledRuntimeError) return error;
    const status = sftpStatus(error);
    const cause = error instanceof Error ? error : undefined;
    // A local disk failure (e.g. ENOSPC) fails the run: skipping files would let a
    // full_refresh load replace the table with partial data.
    if (localErrorCode(error)) return sftpError('SFTP_LOCAL_WRITE_FAILED', 'download', error);
    if (status === SFTP_STATUS_NO_SUCH_FILE) {
      return new ExtractorDataError(`SFTP file ${filePath} no longer exists`, cause);
    }
    if (status === SFTP_STATUS_PERMISSION_DENIED) {
      return new ExtractorDataError(`SFTP permission denied for ${filePath}`, cause);
    }
    // The server's status text stays in `cause`; it is not safe to show or log verbatim.
    const detail = status === undefined ? '' : ` (SFTP status ${status})`;
    return new ExtractorDataError(`SFTP could not read ${filePath}${detail}`, cause);
  }

  /**
   * Returns the attrs when a glob-free path names one regular file, or undefined to walk it.
   * stat follows a named link, so the bookmark tracks the file download() reads; download()
   * still resolves realpath, so a named link cannot leave base_directory.
   */
  private async statNamedFile(
    root: string,
    prefix: string,
    signal?: AbortSignal
  ): Promise<Stats | undefined> {
    let attrs: Stats;
    try {
      attrs = await this.run<Stats>('stat', (done) => this.sftp.stat(root, done), signal);
    } catch (error) {
      if (error instanceof DogsledRuntimeError) throw error;
      if (sftpStatus(error) === SFTP_STATUS_NO_SUCH_FILE) throw this.rootError(error);
      // Some servers refuse STAT but allow folder reads; the walk reports its own errors.
      return undefined;
    }
    if (attrs.mode === undefined) {
      return (await this.opensAsDirectory(root, signal)) ? undefined : attrs;
    }
    if (attrs.isDirectory()) return undefined;
    if (!attrs.isFile()) {
      // Opening a FIFO or device could block until the idle timeout.
      throw new ExtractorDataError(`SFTP path ${prefix} is not a regular file or folder`);
    }
    return attrs;
  }

  /** Some servers omit `mode`; then only a path that opens as a folder is walked. */
  private async opensAsDirectory(remotePath: string, signal?: AbortSignal): Promise<boolean> {
    let handle: Buffer;
    try {
      handle = await this.run<Buffer>(
        'opendir',
        (done) => this.sftp.opendir(remotePath, done),
        signal
      );
    } catch (error) {
      // STAT already found the path, and OpenSSH answers ENOTDIR with NO_SUCH_FILE,
      // so only a refusal is an error here.
      if (sftpStatus(error) === SFTP_STATUS_PERMISSION_DENIED) throw this.rootError(error);
      if (error instanceof DogsledRuntimeError) throw error;
      return false;
    }
    await this.run<void>('close', (done) => this.sftp.close(handle, done), signal).catch(
      () => undefined
    );
    return true;
  }

  /** List one directory; each READDIR batch is its own request so the idle timer tracks progress. */
  private async readDirectory(
    remotePath: string,
    signal?: AbortSignal
  ): Promise<FileEntryWithStats[]> {
    const handle = await this.run<Buffer>(
      'opendir',
      (done) => this.sftp.opendir(remotePath, done),
      signal
    );
    const entries: FileEntryWithStats[] = [];
    try {
      for (;;) {
        try {
          const batch = await this.run<FileEntryWithStats[]>(
            'readdir',
            (done) => this.sftp.readdir(handle, done),
            signal
          );
          for (const entry of batch) entries.push(entry);
        } catch (error) {
          if (sftpStatus(error) === SFTP_STATUS_EOF) return entries;
          throw error;
        }
      }
    } finally {
      await this.run<void>('close', (done) => this.sftp.close(handle, done), signal).catch(
        () => undefined
      );
    }
  }

  private async *walk(
    remotePath: string,
    isRoot: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<ListedFile> {
    let entries: FileEntryWithStats[];
    try {
      entries = await this.readDirectory(remotePath, signal);
    } catch (error) {
      throw isRoot ? this.rootError(error) : this.fileError(error, remotePath);
    }
    for (const entry of entries) {
      const fullPath = remoteJoin(remotePath, entry.filename);
      // Symlinks and special files are skipped so the walk never leaves base_directory.
      if (entry.attrs.isDirectory()) {
        yield* this.walk(fullPath, false, signal);
        continue;
      }
      // A server may omit `mode`; the type is then unknown, so keep the entry and let
      // download()'s realpath check hold it inside base_directory.
      if (entry.attrs.mode !== undefined && !entry.attrs.isFile()) continue;
      yield this.toListed(fullPath, entry.attrs);
    }
  }

  private toListed(fullPath: string, attrs: { mtime?: number; size?: number }): ListedFile {
    const base = this.connection.base_directory.replace(/\/+$/, '') + '/';
    const relative = fullPath.startsWith(base) ? fullPath.slice(base.length) : fullPath;
    return {
      path: relative,
      uri:
        this.connection.port && this.connection.port !== 22
          ? `sftp://${this.connection.host}:${this.connection.port}/${relative}`
          : `sftp://${this.connection.host}/${relative}`,
      last_modified: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : undefined,
      etag: attrs.mtime !== undefined ? `${attrs.mtime}-${attrs.size ?? 0}` : undefined,
      size: attrs.size,
    };
  }
}
