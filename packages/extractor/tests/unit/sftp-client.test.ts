import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { connect as tcpConnect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { DogsledRuntimeError } from '@bobsled-inc/protocol';
import ssh2 from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { withPrivateHostAllowlist } from '../../src/framework/core/index.js';
import type { SftpHostKeyPin, ListedFile } from '../../src/framework/core/index.js';
import { SftpFileStorageClient } from '../../src/runtime/clients/sftp-file-client.js';
import { ExtractorConfigError, ExtractorDataError } from '../../src/runtime/errors.js';
import { SFTP_ERROR_CODES } from '../../src/runtime/index.js';
import {
  generateTestKey,
  startTestSftpServer,
  type TestKey,
  type TestSftpServer,
  type TestSftpServerOptions,
} from './sftp-test-server.js';

const ed25519 = generateTestKey('ed25519');
const rsa = generateTestKey('rsa');
const otherEd25519 = generateTestKey('ed25519');
const clientEd25519 = generateTestKey('ed25519');

let root: string;
let workDir: string;
const bigFile = Buffer.alloc(1024 * 1024 + 123, 7);
const servers: TestSftpServer[] = [];
const clients: SftpFileStorageClient[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sftp-root-'));
  workDir = await mkdtemp(path.join(tmpdir(), 'sftp-work-'));
  await mkdir(path.join(root, 'exports/sub'), { recursive: true });
  await mkdir(path.join(root, 'outside'), { recursive: true });
  await writeFile(path.join(root, 'exports/a.csv'), bigFile);
  await writeFile(path.join(root, 'exports/sub/b.csv'), 'id\n2\n');
  await writeFile(path.join(root, 'secret.txt'), 'secret\n');
  await writeFile(path.join(root, 'outside/c.csv'), 'id\n3\n');
  await symlink('../secret.txt', path.join(root, 'exports/link.csv'));
  await symlink('../outside', path.join(root, 'exports/linkdir'));
  await symlink('../../secret.txt', path.join(root, 'exports/sub/escape.csv'));
  await mkdir(path.join(root, 'many'), { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    await writeFile(path.join(root, `many/f${index}.csv`), `id\n${index}\n`);
  }
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

function pin(key: TestKey, field: 'fingerprint' | 'public_key' = 'fingerprint'): SftpHostKeyPin {
  return field === 'fingerprint'
    ? { algorithm: key.algorithm as SftpHostKeyPin['algorithm'], fingerprint: key.fingerprint }
    : { algorithm: key.algorithm as SftpHostKeyPin['algorithm'], public_key: key.publicKey };
}

async function serve(options: Partial<TestSftpServerOptions> = {}): Promise<TestSftpServer> {
  const server = await startTestSftpServer({ root, hostKeys: [ed25519, rsa], ...options });
  servers.push(server);
  return server;
}

async function connect(
  port: number,
  hostKeys: SftpHostKeyPin[],
  options: {
    password?: string;
    privateKeyPath?: string;
    privateKeyText?: string;
    readConcurrency?: number;
    idleMs?: number;
    baseDirectory?: string;
    passphraseEnv?: string;
  } = {}
): Promise<SftpFileStorageClient> {
  process.env['SFTP_TEST_PASSWORD'] = options.password ?? 'secret';
  if (options.privateKeyPath) process.env['SFTP_TEST_KEY_PATH'] = options.privateKeyPath;
  if (options.privateKeyText) process.env['SFTP_TEST_KEY'] = options.privateKeyText;
  const client = await withPrivateHostAllowlist(['127.0.0.1'], () =>
    SftpFileStorageClient.create(
      {
        host: '127.0.0.1',
        port,
        username: 'agent',
        base_directory: options.baseDirectory ?? '/exports',
        host_keys: hostKeys,
        read_concurrency: options.readConcurrency ?? 4,
      },
      options.privateKeyText
        ? { type: 'private_key', private_key_env: 'SFTP_TEST_KEY' }
        : options.privateKeyPath
          ? {
              type: 'private_key',
              private_key_path_env: 'SFTP_TEST_KEY_PATH',
              passphrase_env: options.passphraseEnv,
            }
          : { type: 'password', password_env: 'SFTP_TEST_PASSWORD' },
      { timeouts: { idleMs: options.idleMs ?? 60_000, readyMs: 5_000 } },
      ['SFTP_TEST_PASSWORD', 'SFTP_TEST_KEY_PATH', 'SFTP_TEST_KEY']
    )
  );
  clients.push(client);
  return client;
}

async function listAll(client: SftpFileStorageClient, signal?: AbortSignal): Promise<ListedFile[]> {
  const files: ListedFile[] = [];
  for await (const file of client.list({ path: '', signal })) files.push(file);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function file(relative: string, size: number | undefined = 1): ListedFile {
  return { path: relative, uri: `sftp://127.0.0.1/${relative}`, size };
}

async function expectSftpCode(
  promise: Promise<unknown>,
  code: string
): Promise<DogsledRuntimeError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(DogsledRuntimeError);
  expect((error as DogsledRuntimeError).code).toBe(code);
  return error as DogsledRuntimeError;
}

describe('SFTP client against a real ssh2 server', () => {
  it('exports every structured error code', () => {
    expect(SFTP_ERROR_CODES).toContain('SFTP_HOST_KEY_MISMATCH');
    expect(SFTP_ERROR_CODES).toContain('SFTP_CONNECTION_LOST');
  });

  it('negotiates the pinned RSA key when the server also offers Ed25519', async () => {
    const server = await serve({ hostKeys: [ed25519, rsa] });
    const client = await connect(server.port, [pin(rsa)]);
    expect((await listAll(client)).map((entry) => entry.path)).toEqual(['a.csv', 'sub/b.csv']);
  });

  it('accepts an Ed25519 pin given as the full public key', async () => {
    const server = await serve({ hostKeys: [ed25519, rsa] });
    const client = await connect(server.port, [pin(ed25519, 'public_key')]);
    expect(await listAll(client)).toHaveLength(2);
  });

  it('accepts any of several pinned keys', async () => {
    const server = await serve({ hostKeys: [rsa] });
    const client = await connect(server.port, [pin(otherEd25519), pin(rsa, 'public_key')]);
    expect(await listAll(client)).toHaveLength(2);
  });

  it('rejects a changed host key as SFTP_HOST_KEY_MISMATCH', async () => {
    const server = await serve({ hostKeys: [ed25519] });
    const error = await expectSftpCode(
      connect(server.port, [pin(otherEd25519)]),
      'SFTP_HOST_KEY_MISMATCH'
    );
    expect(error.retryable).toBe(false);
  });

  it('rejects a key whose fingerprint is pinned under a different algorithm', async () => {
    const server = await serve({ hostKeys: [ed25519] });
    await expectSftpCode(
      connect(server.port, [
        { algorithm: 'ssh-rsa', fingerprint: ed25519.fingerprint },
        pin(otherEd25519),
      ]),
      'SFTP_HOST_KEY_MISMATCH'
    );
  });

  it('reports SFTP_HOST_KEY_TYPE_UNAVAILABLE when the server lacks the pinned type', async () => {
    const server = await serve({ hostKeys: [ed25519] });
    await expectSftpCode(connect(server.port, [pin(rsa)]), 'SFTP_HOST_KEY_TYPE_UNAVAILABLE');
  });

  it('reports SFTP_AUTH_FAILED for a wrong password', async () => {
    const server = await serve();
    await expectSftpCode(
      connect(server.port, [pin(ed25519)], { password: 'wrong' }),
      'SFTP_AUTH_FAILED'
    );
  });

  it('authenticates with an Ed25519 private key', async () => {
    const server = await serve({ clientKey: clientEd25519 });
    const keyPath = path.join(workDir, 'client_ed25519');
    await writeFile(keyPath, clientEd25519.privateKey, { mode: 0o600 });
    const client = await connect(server.port, [pin(ed25519)], { privateKeyPath: keyPath });
    expect(await listAll(client)).toHaveLength(2);
  });

  it('authenticates with private key text from private_key_env', async () => {
    const server = await serve({ clientKey: clientEd25519 });
    const client = await connect(server.port, [pin(ed25519)], {
      privateKeyText: clientEd25519.privateKey,
    });
    expect(await listAll(client)).toHaveLength(2);
  });

  it('lists a single named file, walks a named folder and rejects a missing path', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)]);
    const paths = async (pattern: string) => {
      const out: ListedFile[] = [];
      for await (const entry of client.list({ path: pattern })) out.push(entry);
      return out;
    };
    const single = await paths('sub/b.csv');
    expect(single.map((entry) => entry.path)).toEqual(['sub/b.csv']);
    expect(single[0]).toMatchObject({ size: 5, uri: expect.stringMatching(/\/sub\/b\.csv$/) });
    const downloaded = await client.download(single[0]!, path.join(workDir, 'single.out'));
    expect(downloaded.bytes_downloaded).toBe(5);
    expect((await paths('sub')).map((entry) => entry.path)).toEqual(['sub/b.csv']);
    await expectSftpCode(paths('missing.csv'), 'SFTP_PATH_NOT_FOUND');
    // A named link is listed, but its download still cannot leave base_directory.
    const [link] = await paths('link.csv');
    await expect(client.download(link!, path.join(workDir, 'link.out'))).rejects.toThrow(
      'resolves outside base_directory'
    );
  });

  it('lists a named link with its target metadata so incremental bookmarks see changes', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)], { baseDirectory: '/linked' });
    // Own folder outside exports/, so other listing tests keep their fixtures.
    await mkdir(path.join(root, 'linked'), { recursive: true });
    const target = path.join(root, 'linked/target.csv');
    await writeFile(target, 'id\n1\n');
    await symlink('target.csv', path.join(root, 'linked/named-link.csv'));
    const sizeOf = async () => {
      for await (const entry of client.list({ path: 'named-link.csv' })) return entry.size;
      return undefined;
    };
    expect(await sizeOf()).toBe(5);
    await writeFile(target, 'id\n1\n2\n3\n');
    expect(await sizeOf()).toBe(9);
  });

  it('walks a named folder when the server omits mode, and still lists a named file', async () => {
    const server = await serve({ omitMode: true });
    const client = await connect(server.port, [pin(ed25519)]);
    const paths = async (pattern: string) => {
      const out: string[] = [];
      for await (const entry of client.list({ path: pattern })) out.push(entry.path);
      return out.sort();
    };
    expect(await paths('sub')).toContain('sub/b.csv');
    expect(await paths('sub/b.csv')).toEqual(['sub/b.csv']);
  });

  it('keeps a refused folder probe a permission error when the server omits mode', async () => {
    const server = await serve({ omitMode: true, denyOpendir: true });
    const client = await connect(server.port, [pin(ed25519)]);
    const listing = (async () => {
      for await (const entry of client.list({ path: 'sub' })) void entry;
    })();
    await expectSftpCode(listing, 'SFTP_PERMISSION_DENIED');
  });

  it('still walks a named folder when the server refuses STAT', async () => {
    const server = await serve({ denyStat: true });
    const client = await connect(server.port, [pin(ed25519)]);
    const out: string[] = [];
    for await (const entry of client.list({ path: 'sub' })) out.push(entry.path);
    expect(out).toContain('sub/b.csv');
  });

  it('refuses a named path that is a FIFO instead of opening it', async () => {
    await mkdir(path.join(root, 'special'), { recursive: true });
    execFileSync('mkfifo', [path.join(root, 'special/pipe.csv')]);
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)], { baseDirectory: '/special' });
    const listing = (async () => {
      for await (const entry of client.list({ path: 'pipe.csv' })) void entry;
    })();
    await expect(listing).rejects.toThrow('is not a regular file or folder');
  });

  it('reports SFTP_NOT_SSH when the peer is not an SSH server', async () => {
    const http = createServer((socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      await expectSftpCode(
        connect((http.address() as AddressInfo).port, [pin(ed25519)]),
        'SFTP_NOT_SSH'
      );
    } finally {
      http.close();
    }
  });

  it('reports SFTP_CONNECT_FAILED when nothing listens', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await expectSftpCode(connect(port, [pin(ed25519)]), 'SFTP_CONNECT_FAILED');
  });

  it('skips symlinks while listing and refuses downloads that resolve outside the root', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)]);
    const listed = (await listAll(client)).map((entry) => entry.path);
    expect(listed).toEqual(['a.csv', 'sub/b.csv']);

    for (const escaping of ['link.csv', 'sub/escape.csv', 'linkdir/c.csv']) {
      await expect(
        client.download(file(escaping), path.join(workDir, 'escape.out'))
      ).rejects.toThrow(ExtractorDataError);
    }
    await expect(
      client.download(file('link.csv'), path.join(workDir, 'escape.out'))
    ).rejects.toThrow('resolves outside base_directory');
  });

  it('lists only paths that match the resource glob', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)]);
    const paths = async (pattern: string) => {
      const out: string[] = [];
      for await (const entry of client.list({ path: pattern })) out.push(entry.path);
      return out.sort();
    };
    expect(await paths('*.csv')).toEqual(['a.csv']);
    expect(await paths('sub/*.csv')).toEqual(['sub/b.csv']);
    expect(await paths('s*/b.c?v')).toEqual(['sub/b.csv']);
    expect(await paths('**.csv')).toEqual(['a.csv', 'sub/b.csv']);
    expect(await paths('**/*.csv')).toEqual(['a.csv', 'sub/b.csv']);
    expect(await paths('sub/**/*.csv')).toEqual(['sub/b.csv']);
  });

  it('reports a missing listing root as SFTP_PATH_NOT_FOUND', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)], { baseDirectory: '/missing' });
    await expectSftpCode(listAll(client), 'SFTP_PATH_NOT_FOUND');
  });

  it('keeps a vanished file a per-file data error', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)]);
    await expect(client.download(file('gone.csv'), path.join(workDir, 'gone.out'))).rejects.toThrow(
      ExtractorDataError
    );
    expect(await listAll(client)).toHaveLength(2);
  });

  it('pipelines reads up to read_concurrency and reports the real byte count', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)], { readConcurrency: 4 });
    const target = path.join(workDir, 'a.out');
    const downloaded = await client.download(file('a.csv'), target);
    expect(downloaded.bytes_downloaded).toBe(bigFile.length);
    expect((await readFile(target)).equals(bigFile)).toBe(true);
    expect(server.stats.maxInFlightReads).toBeGreaterThan(1);
    expect(server.stats.maxInFlightReads).toBeLessThanOrEqual(4);
  });

  it('keeps one read in flight when read_concurrency is 1', async () => {
    const server = await serve();
    const client = await connect(server.port, [pin(ed25519)], { readConcurrency: 1 });
    await client.download(file('a.csv'), path.join(workDir, 'a1.out'));
    expect(server.stats.maxInFlightReads).toBe(1);
  });

  it('fails a stalled READ with SFTP_TIMEOUT and fails later operations too', async () => {
    const server = await serve({ stallReads: true });
    const client = await connect(server.port, [pin(ed25519)], { idleMs: 300 });
    const started = Date.now();
    await expectSftpCode(
      client.download(file('a.csv'), path.join(workDir, 'stall.out')),
      'SFTP_TIMEOUT'
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await expectSftpCode(listAll(client), 'SFTP_TIMEOUT');
  });

  it('cancels a stalled download promptly when the signal aborts', async () => {
    const server = await serve({ stallReads: true });
    const client = await connect(server.port, [pin(ed25519)]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expectSftpCode(
      client.download(file('a.csv'), path.join(workDir, 'cancel.out'), {
        signal: controller.signal,
      }),
      'SFTP_CANCELLED'
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('fails with SFTP_CONNECTION_LOST when the connection drops mid-download', async () => {
    const server = await serve({ dropOnRead: true });
    const client = await connect(server.port, [pin(ed25519)]);
    const error = await expectSftpCode(
      client.download(file('a.csv'), path.join(workDir, 'drop.out')),
      'SFTP_CONNECTION_LOST'
    );
    expect(error.retryable).toBe(true);
    await expectSftpCode(listAll(client), 'SFTP_CONNECTION_LOST');
  });

  it('rejects an unusable private key as a config error and closes the socket at once', async () => {
    const encrypted = ssh2.utils.generateKeyPairSync('ed25519', {
      passphrase: 'pass',
      cipher: 'aes256-cbc',
    });
    const keyPath = path.join(workDir, 'client_encrypted');
    await writeFile(keyPath, encrypted.private, { mode: 0o600 });
    let socketClosed = false;
    const sink = createServer((socket) => {
      socket.write('SSH-2.0-sink\r\n');
      socket.on('error', () => undefined);
      socket.on('close', () => (socketClosed = true));
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    try {
      await expect(
        connect((sink.address() as AddressInfo).port, [pin(ed25519)], { privateKeyPath: keyPath })
      ).rejects.toThrow(ExtractorConfigError);
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    } finally {
      sink.close();
    }
  });

  it('recognizes an SSH banner that TCP splits across chunks', async () => {
    const server = await serve({ refuseSftp: true });
    // Proxy that splits the server's banner between "SS" and "H-".
    const proxy = createServer((inbound) => {
      const outbound = tcpConnect(server.port, '127.0.0.1');
      let fragmented = false;
      outbound.on('data', (chunk: Buffer) => {
        if (fragmented) return void inbound.write(chunk);
        fragmented = true;
        // "SS" now, the rest after a pause, so the client reads two separate chunks.
        inbound.write(chunk.subarray(0, 2));
        outbound.pause();
        setTimeout(() => {
          inbound.write(chunk.subarray(2));
          outbound.resume();
        }, 50);
      });
      inbound.pipe(outbound);
      inbound.on('close', () => outbound.destroy());
      outbound.on('close', () => inbound.destroy());
      inbound.on('error', () => undefined);
      outbound.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      await expectSftpCode(
        connect((proxy.address() as AddressInfo).port, [pin(ed25519)]),
        'SFTP_SUBSYSTEM_UNAVAILABLE'
      );
    } finally {
      proxy.close();
    }
  });

  it('downloads a file when the server reports no size', async () => {
    const server = await serve({ omitSize: true });
    const client = await connect(server.port, [pin(ed25519)], { idleMs: 2_000 });
    const listed = (await listAll(client)).find((entry) => entry.path === 'a.csv');
    expect(listed?.size).toBeUndefined();
    const target = path.join(workDir, 'unsized.out');
    const downloaded = await client.download(listed!, target);
    expect(downloaded.bytes_downloaded).toBe(bigFile.length);
    expect((await readFile(target)).equals(bigFile)).toBe(true);
  });

  it('reports a refused sftp subsystem as SFTP_SUBSYSTEM_UNAVAILABLE', async () => {
    const server = await serve({ refuseSftp: true });
    const error = await expectSftpCode(
      connect(server.port, [pin(ed25519)]),
      'SFTP_SUBSYSTEM_UNAVAILABLE'
    );
    expect(error.retryable).toBe(false);
  });

  it('reports a server that presents the pinned key but cannot sign with it as a mismatch', async () => {
    const server = await serve({ hostKeys: [otherEd25519], presentPublicKeyOf: ed25519 });
    const error = await expectSftpCode(
      connect(server.port, [pin(ed25519)]),
      'SFTP_HOST_KEY_MISMATCH'
    );
    expect(error.retryable).toBe(false);
  });

  it('applies the idle timeout per READDIR batch, not to the whole listing', async () => {
    const server = await serve({ readdirBatchSize: 2, readdirDelayMs: 150 });
    const client = await connect(server.port, [pin(ed25519)], {
      idleMs: 400,
      baseDirectory: '/many',
    });
    const started = Date.now();
    expect(await listAll(client)).toHaveLength(6);
    expect(Date.now() - started).toBeGreaterThan(400);
  });

  it('cancels a stalled listing promptly when the signal aborts', async () => {
    const server = await serve({ stallReaddir: true });
    const client = await connect(server.port, [pin(ed25519)]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expectSftpCode(listAll(client, controller.signal), 'SFTP_CANCELLED');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('SFTP client request handling', () => {
  interface MockFile {
    content: Buffer;
    /** Size FSTAT reports; `null` leaves size out of the reply. */
    fstatSize?: number | null;
    readError?: Error;
  }

  /** In-memory SFTP handle API that records how many READs are in flight. */
  function mockSftp(files: Record<string, MockFile>, extra: Record<string, unknown> = {}) {
    const stats = { inFlight: 0, maxInFlight: 0 };
    const handles = new Map<string, MockFile>();
    const sftp = {
      realpath: (remote: string, done: (error: undefined, real: string) => void) =>
        done(undefined, remote),
      open: (remote: string, _flags: string, done: (error?: Error, handle?: Buffer) => void) => {
        const entry = files[remote];
        if (!entry) return done(Object.assign(new Error('no such file'), { code: 2 }));
        handles.set(remote, entry);
        done(undefined, Buffer.from(remote));
      },
      fstat: (handle: Buffer, done: (error: undefined, attrs: object) => void) => {
        const entry = handles.get(handle.toString())!;
        const size = entry.fstatSize === undefined ? entry.content.length : entry.fstatSize;
        done(undefined, size === null ? {} : { size });
      },
      read: (
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        done: (error: Error | undefined, bytesRead?: number) => void
      ) => {
        const entry = handles.get(handle.toString())!;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        setImmediate(() => {
          stats.inFlight -= 1;
          if (entry.readError) return done(entry.readError);
          if (position >= entry.content.length) {
            return done(Object.assign(new Error('eof'), { code: 1 }));
          }
          done(undefined, entry.content.copy(buffer, offset, position, position + length));
        });
      },
      close: (_handle: Buffer, done: () => void) => done(),
      end: () => undefined,
      ...extra,
    } as unknown as SFTPWrapper;
    return { sftp, stats };
  }

  async function mockClient(
    sftp: SFTPWrapper,
    readConcurrency = 4
  ): Promise<SftpFileStorageClient> {
    return SftpFileStorageClient.create(
      {
        host: 'sftp.example.com',
        username: 'agent',
        base_directory: '/exports',
        host_keys: [pin(ed25519)],
        read_concurrency: readConcurrency,
      },
      { type: 'password', password_env: 'SFTP_TEST_PASSWORD' },
      { sftp, timeouts: { idleMs: 2_000 } },
      ['SFTP_TEST_PASSWORD']
    );
  }

  it('reads in parallel with the listed size when FSTAT omits it', async () => {
    const content = Buffer.alloc(300_000, 9);
    const { sftp, stats } = mockSftp({ '/exports/a.csv': { content, fstatSize: null } });
    const client = await mockClient(sftp);
    const target = path.join(workDir, 'fstat-no-size.out');
    const downloaded = await client.download(file('a.csv', content.length), target);
    expect(downloaded.bytes_downloaded).toBe(content.length);
    expect((await readFile(target)).equals(content)).toBe(true);
    expect(stats.maxInFlight).toBe(4);
  });

  it('finishes short local writes instead of truncating the file', async () => {
    const content = Buffer.from('0123456789abcdefghijkl');
    const { sftp } = mockSftp({ '/exports/a.csv': { content } });
    const client = await mockClient(sftp);
    const probe = await open(path.join(workDir, 'probe.out'), 'w');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const original = prototype.write;
    // Each write stores at most 3 bytes, which FileHandle.write is allowed to do.
    const shortWrite = vi.spyOn(prototype, 'write').mockImplementation(function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) {
      return original.call(this, buffer, offset, Math.min(length, 3), position);
    } as never);
    try {
      const target = path.join(workDir, 'short-writes.out');
      const downloaded = await client.download(file('a.csv', content.length), target);
      expect(downloaded.bytes_downloaded).toBe(content.length);
      expect((await readFile(target)).equals(content)).toBe(true);
    } finally {
      shortWrite.mockRestore();
    }
  });

  it('stops at EOF when the file is shorter than its reported size', async () => {
    const content = Buffer.from('id\n1\n');
    const { sftp } = mockSftp({ '/exports/a.csv': { content, fstatSize: 1_000_000 } });
    const client = await mockClient(sftp);
    const downloaded = await client.download(file('a.csv'), path.join(workDir, 'shrunk.out'));
    expect(downloaded.bytes_downloaded).toBe(content.length);
  });

  it('keeps listed entries whose file type the server did not send', async () => {
    const noMode = { size: 5, mtime: 1, isFile: () => false, isDirectory: () => false };
    let batches = 0;
    const { sftp } = mockSftp(
      {},
      {
        opendir: (_path: string, done: (error: undefined, handle: Buffer) => void) =>
          done(undefined, Buffer.from('h')),
        readdir: (_handle: Buffer, done: (error: Error | undefined, list?: unknown[]) => void) => {
          batches += 1;
          if (batches > 1) return done(Object.assign(new Error('eof'), { code: 1 }));
          done(undefined, [{ filename: 'a.csv', longname: 'a.csv', attrs: noMode }]);
        },
      }
    );
    const client = await mockClient(sftp);
    const listed: string[] = [];
    for await (const entry of client.list({ path: '' })) listed.push(entry.path);
    expect(listed).toEqual(['a.csv']);
  });

  it('fails the run on a local write error without blaming the connection', async () => {
    const { sftp } = mockSftp({ '/exports/a.csv': { content: Buffer.from('id\n1\n') } });
    const client = await mockClient(sftp);
    const blocked = path.join(workDir, 'blocked-target');
    await mkdir(blocked, { recursive: true }); // a folder where the file should go: EISDIR
    await expect(client.download(file('a.csv'), blocked)).rejects.toMatchObject({
      code: 'SFTP_LOCAL_WRITE_FAILED',
      retryable: false,
    });
    // The SSH session itself was healthy, so it stays usable.
    const ok = await client.download(file('a.csv'), path.join(workDir, 'local-ok.out'));
    expect(ok.bytes_downloaded).toBe(5);
  });

  it('keeps server status text out of the message and leaves no idle timer behind', async () => {
    const { sftp } = mockSftp({
      '/exports/a.csv': {
        content: Buffer.alloc(200_000),
        readError: Object.assign(new Error('failure on db7.internal.example'), { code: 4 }),
      },
    });
    const client = await mockClient(sftp);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const failed = client.download(file('a.csv'), path.join(workDir, 'status.out'));
      await expect(failed).rejects.toThrow('SFTP could not read a.csv (SFTP status 4)');
      await expect(failed).rejects.not.toThrow('db7');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
