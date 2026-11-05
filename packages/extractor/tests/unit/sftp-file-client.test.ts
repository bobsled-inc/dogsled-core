import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { extractFileStorageResource } from '../../src/runtime/file-storage-extractor.js';
import { S3FileStorageClient } from '../../src/runtime/clients/s3-file-client.js';
import { SftpFileStorageClient } from '../../src/runtime/clients/sftp-file-client.js';
import { FakeWritable } from '../helpers/fixtures.js';
import {
  FreezableRelay,
  generateClientKey,
  startSftpTestServer,
  type SftpTestServer,
  type SftpTestServerOptions,
} from '../helpers/sftp-test-server.js';

import type { ListedFile, ListFilesOptions } from '../../src/framework/core/index.js';
import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';

type Connection = Parameters<typeof SftpFileStorageClient.create>[0];
type Auth = Parameters<typeof SftpFileStorageClient.create>[1];
type ConnectOptions = {
  connection?: Partial<Connection>;
  auth?: Auth;
  env?: Record<string, string>;
  port?: number;
};

const PASSWORD_ENV = 'SFTP_TEST_PASSWORD';
const JAN_1_2026 = 1_767_225_600;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function serve(options?: SftpTestServerOptions): Promise<SftpTestServer> {
  const server = await startSftpTestServer(options);
  cleanups.push(() => server.stop());
  return server;
}

async function connect(
  server: SftpTestServer,
  options: ConnectOptions = {}
): Promise<SftpFileStorageClient> {
  vi.stubEnv(PASSWORD_ENV, server.password);
  for (const [name, value] of Object.entries(options.env ?? {})) vi.stubEnv(name, value);
  const client = await SftpFileStorageClient.create(
    {
      host: '127.0.0.1',
      port: options.port ?? server.port,
      username: server.username,
      base_directory: '/data',
      ...options.connection,
    },
    {
      host_fingerprint: server.fingerprint,
      ...(options.auth ?? { type: 'password', password_env: PASSWORD_ENV }),
    },
    undefined,
    [PASSWORD_ENV, ...Object.keys(options.env ?? {})]
  );
  cleanups.push(() => client.close());
  return client;
}

async function listAll(
  client: { list(options: ListFilesOptions): AsyncGenerator<ListedFile> },
  pathGlob: string,
  options: Omit<ListFilesOptions, 'path'> = {}
): Promise<ListedFile[]> {
  const files: ListedFile[] = [];
  for await (const file of client.list({ path: pathGlob, ...options })) files.push(file);
  return files;
}

async function paths(
  client: { list(options: ListFilesOptions): AsyncGenerator<ListedFile> },
  pathGlob: string,
  options: Omit<ListFilesOptions, 'path'> = {}
): Promise<string[]> {
  return (await listAll(client, pathGlob, options)).map((file) => file.path);
}

function collectWarnings(): { warnings: string[]; onWarning: (message: string) => void } {
  const warnings: string[] = [];
  return { warnings, onWarning: (message) => void warnings.push(message) };
}

function exportsTree(server: SftpTestServer): void {
  server.tree
    .file('/data/exports/a.csv', 'id\n1\n', JAN_1_2026)
    .file('/data/exports/b.parquet', 'PAR1', JAN_1_2026)
    .file('/data/exports/nested/c.csv', 'id\n3\n', JAN_1_2026);
}

describe('SFTP file storage client', () => {
  describe('closing', () => {
    it.each([{}, { keepalive_interval_seconds: 1 }])(
      'ends the whole SSH connection, not only the SFTP channel (%o)',
      async (connection) => {
        const server = await serve();
        exportsTree(server);
        const client = await connect(server, { connection });
        expect(await paths(client, 'exports/*.csv')).toEqual(['exports/a.csv']);
        expect(server.openConnections).toBe(1);

        const closed = server.waitForClose(3_000);
        await client.close();

        expect(await closed).toBe(true);
        expect(server.openConnections).toBe(0);
      }
    );

    it('lets the process exit after it closes the client', async () => {
      const server = await serve();
      server.tree.file('/data/a.csv', 'id\n1\n');
      const script = fileURLToPath(new URL('../helpers/sftp-list-and-close.ts', import.meta.url));
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: {
          ...process.env,
          SFTP_TEST_PORT: String(server.port),
          SFTP_TEST_FINGERPRINT: server.fingerprint,
          [PASSWORD_ENV]: server.password,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      const exit = once(child, 'exit').then(([code]) => code as number | null);
      const result = await Promise.race([exit, delay(15_000).then(() => 'still running')]);
      if (result === 'still running') child.kill('SIGKILL');

      expect({ result, stdout, stderr }).toEqual({ result: 0, stdout: 'a.csv\n', stderr: '' });
    }, 30_000);
  });

  describe('listing', () => {
    it('matches globs exactly like the S3 client', async () => {
      const keys = [
        'top.csv',
        'exports/a.csv',
        'exports/b.parquet',
        'exports/nested/c.csv',
        'exports/nested/deeper/d.csv',
        'exports-old/e.csv',
        'archive/2026-11/f.csv',
      ];
      const server = await serve();
      for (const key of keys) server.tree.file(`/data/${key}`, key);
      const client = await connect(server);
      const s3 = new S3FileStorageClient(
        { bucket: 'raw', region: 'us-east-1' },
        { type: 'default_chain' },
        {
          ListObjectsV2Command: class {
            constructor(readonly input: unknown) {}
          },
          GetObjectCommand: class {
            constructor(readonly input: unknown) {}
          },
          client: {
            send: async (command: unknown) => {
              const { Prefix } = (command as { input: { Prefix: string } }).input;
              return {
                Contents: keys
                  .filter((key) => key.startsWith(Prefix))
                  .sort()
                  .map((Key) => ({ Key })),
              };
            },
          },
        }
      );

      const patterns = [
        '*.csv',
        'exports/*.csv',
        'exports/**',
        'exports/**/*.csv',
        '**/*.csv',
        'exports-*/*.csv',
        'exports/?.csv',
        'archive/2026-*/*.csv',
        '*/nested/*.csv',
      ];
      for (const pattern of patterns) {
        const expected = (await paths(s3, pattern)).sort();
        expect({ pattern, files: (await paths(client, pattern)).sort() }).toEqual({
          pattern,
          files: expected,
        });
      }
      expect(await paths(client, 'exports/*.csv')).toEqual(['exports/a.csv']);
    });

    it('reads one file when the path names a file', async () => {
      const server = await serve();
      exportsTree(server);
      const client = await connect(server);

      expect(await listAll(client, 'exports/nested/c.csv')).toEqual([
        {
          path: 'exports/nested/c.csv',
          uri: `sftp://127.0.0.1:${server.port}/exports/nested/c.csv`,
          last_modified: '2026-01-01T00:00:00.000Z',
          etag: `${JAN_1_2026}-5`,
          size: 5,
        },
      ]);
    });

    it.each(['exports', 'exports/'])('reads every file below a folder path (%s)', async (folder) => {
      const server = await serve();
      exportsTree(server);
      const client = await connect(server);

      const files = await listAll(client, folder);

      expect(files.map((file) => file.path)).toEqual([
        'exports/a.csv',
        'exports/b.parquet',
        'exports/nested/c.csv',
      ]);
      expect(files[2]).toEqual({
        path: 'exports/nested/c.csv',
        uri: `sftp://127.0.0.1:${server.port}/exports/nested/c.csv`,
        last_modified: '2026-01-01T00:00:00.000Z',
        etag: `${JAN_1_2026}-5`,
        size: 5,
      });
    });

    it('lists entries in name order and stops at maxFiles', async () => {
      const server = await serve();
      exportsTree(server);
      const client = await connect(server);

      expect(await paths(client, 'exports/', { maxFiles: 2 })).toEqual([
        'exports/a.csv',
        'exports/b.parquet',
      ]);
    });

    it('fails when the folder or path it starts from cannot be read', async () => {
      const server = await serve();
      exportsTree(server);
      server.tree.deny('/data/exports');
      const client = await connect(server);

      await expect(paths(client, 'exports/*.csv')).rejects.toThrow(
        'SFTP folder "exports" could not be read: Permission denied'
      );
      await expect(paths(client, 'exports/')).rejects.toThrow('SFTP folder "exports"');
      await expect(paths(client, 'missing/')).rejects.toThrow('SFTP path "missing" could not be read');
      await expect(paths(client, 'missing/*.csv')).rejects.toThrow('SFTP folder "missing"');
    });

    it('skips subfolders it cannot read and reports them', async () => {
      const server = await serve();
      exportsTree(server);
      server.tree.file('/data/exports/locked/secret.csv', 'id\n9\n').deny('/data/exports/locked');
      const client = await connect(server);
      const { warnings, onWarning } = collectWarnings();

      expect(await paths(client, 'exports/', { onWarning })).toEqual([
        'exports/a.csv',
        'exports/b.parquet',
        'exports/nested/c.csv',
      ]);
      expect(warnings).toEqual(['Skipping SFTP folder exports/locked: Permission denied']);
    });

    it('follows links to folders and files and reports the target attributes', async () => {
      const server = await serve();
      server.tree
        .file('/archive/2026/x.csv', 'id\n7\n', JAN_1_2026)
        .link('/data/exports/current', '/archive/2026')
        .link('/data/exports/latest.csv', '../../archive/2026/x.csv');
      const client = await connect(server);

      const files = await listAll(client, 'exports/');

      expect(files).toEqual([
        expect.objectContaining({ path: 'exports/latest.csv', size: 5, etag: `${JAN_1_2026}-5` }),
        expect.objectContaining({ path: 'exports/current/x.csv', size: 5 }),
      ]);
      const dir = await mkdtemp(path.join(tmpdir(), 'sftp-link-'));
      await client.download(files[1]!, path.join(dir, 'x.csv'));
      expect(await readFile(path.join(dir, 'x.csv'), 'utf8')).toBe('id\n7\n');
    });

    it('lists each folder once, at its own path, when links point back into the listing', async () => {
      const server = await serve();
      exportsTree(server);
      server.tree
        .link('/data/exports/again', '/data/exports/nested')
        .link('/data/exports/nested/loop', '/data/exports');
      const client = await connect(server);
      const { warnings, onWarning } = collectWarnings();

      expect(await paths(client, 'exports/**', { onWarning })).toEqual([
        'exports/a.csv',
        'exports/b.parquet',
        'exports/nested/c.csv',
      ]);
      expect(warnings).toEqual([
        'Skipping SFTP link exports/again: this listing already reads the folder it points to',
        'Skipping SFTP link exports/nested/loop: this listing already reads the folder it points to',
      ]);
    });

    it('skips folder links when the server does not resolve them', async () => {
      const server = await serve({ realpathFollowsLinks: false });
      exportsTree(server);
      server.tree.link('/data/exports/loop', '/data/exports');
      const client = await connect(server);
      const { warnings, onWarning } = collectWarnings();

      expect(await paths(client, 'exports/', { onWarning })).toEqual([
        'exports/a.csv',
        'exports/b.parquet',
        'exports/nested/c.csv',
      ]);
      expect(warnings).toEqual([
        'Skipping SFTP link exports/loop: the server does not report the folder it points to',
      ]);
    });

    it('skips a broken link and reports it', async () => {
      const server = await serve();
      exportsTree(server);
      server.tree.link('/data/exports/broken.csv', '/nowhere/gone.csv');
      const client = await connect(server);
      const { warnings, onWarning } = collectWarnings();

      expect(await paths(client, 'exports/*.csv', { onWarning })).toEqual(['exports/a.csv']);
      expect(warnings).toEqual(['Skipping SFTP link exports/broken.csv: No such file']);
    });

    it('works out file types itself when the server leaves them out of listings', async () => {
      const server = await serve({ omitListingModes: true });
      exportsTree(server);
      server.tree.file('/archive/y.csv', 'id\n8\n').link('/data/exports/linked', '/archive');
      const client = await connect(server);

      expect(await paths(client, 'exports/')).toEqual([
        'exports/a.csv',
        'exports/b.parquet',
        'exports/nested/c.csv',
        'exports/linked/y.csv',
      ]);
    });

    it('waits for files modified within min_file_age_seconds and reports them once', async () => {
      const server = await serve();
      const now = Math.floor(Date.now() / 1000);
      server.tree
        .file('/data/old.csv', 'id\n1\n', now - 3_600)
        .file('/data/new.csv', 'id\n2\n', now)
        .file('/data/newer.csv', 'id\n3\n', now);
      const client = await connect(server, { connection: { min_file_age_seconds: 600 } });
      const { warnings, onWarning } = collectWarnings();

      expect(await paths(client, '*.csv', { onWarning })).toEqual(['old.csv']);
      expect(warnings).toEqual([
        'Skipped 2 SFTP file(s) modified in the last 600 seconds; a later run reads them.',
      ]);
    });
  });

  describe('downloads', () => {
    it('streams by default and reads in parallel when read_concurrency is set', async () => {
      const content = randomBytes(512 * 1024);
      const dir = await mkdtemp(path.join(tmpdir(), 'sftp-download-'));
      for (const [label, connection, expectParallel] of [
        ['stream', {}, false],
        ['parallel', { read_concurrency: 4 }, true],
      ] as const) {
        const server = await serve({ deferReads: true });
        server.tree.file('/data/big.bin', content).file('/data/empty.bin', '');
        const client = await connect(server, { connection });
        const [big, empty] = await listAll(client, '*.bin').then((files) =>
          ['big.bin', 'empty.bin'].map((name) => files.find((file) => file.path === name)!)
        );

        const downloaded = await client.download(big!, path.join(dir, `${label}.bin`));
        await client.download(empty!, path.join(dir, `${label}-empty.bin`));

        expect(downloaded.bytes_downloaded).toBe(content.length);
        expect((await readFile(path.join(dir, `${label}.bin`))).equals(content)).toBe(true);
        expect(await readFile(path.join(dir, `${label}-empty.bin`), 'utf8')).toBe('');
        if (expectParallel) expect(server.stats.maxReadsInFlight).toBeGreaterThan(1);
        else expect(server.stats.maxReadsInFlight).toBe(1);
      }
    });
  });

  describe('authentication', () => {
    it('logs in with private key text from private_key_env', async () => {
      const key = generateClientKey();
      const server = await serve({ methods: ['publickey'], publicKeys: [key.public] });
      server.tree.file('/data/a.csv', 'id\n1\n');
      const client = await connect(server, {
        auth: { type: 'private_key', private_key_env: 'SFTP_TEST_KEY' },
        env: { SFTP_TEST_KEY: key.private },
      });

      expect(await paths(client, '*.csv')).toEqual(['a.csv']);
    });

    it('logs in with an encrypted key and its passphrase', async () => {
      const passphrase = randomBytes(8).toString('hex');
      const key = generateClientKey(passphrase);
      const server = await serve({ methods: ['publickey'], publicKeys: [key.public] });
      server.tree.file('/data/a.csv', 'id\n1\n');
      const client = await connect(server, {
        auth: {
          type: 'private_key',
          private_key_env: 'SFTP_TEST_KEY',
          passphrase_env: 'SFTP_TEST_PASSPHRASE',
        },
        env: { SFTP_TEST_KEY: key.private, SFTP_TEST_PASSPHRASE: passphrase },
      });

      expect(await paths(client, '*.csv')).toEqual(['a.csv']);
    });

    it('still reads a private key file named by private_key_path_env', async () => {
      const key = generateClientKey();
      const server = await serve({ methods: ['publickey'], publicKeys: [key.public] });
      server.tree.file('/data/a.csv', 'id\n1\n');
      const keyPath = path.join(await mkdtemp(path.join(tmpdir(), 'sftp-key-')), 'id_ed25519');
      await writeFile(keyPath, key.private, { mode: 0o600 });
      const client = await connect(server, {
        auth: { type: 'private_key', private_key_path_env: 'SFTP_TEST_KEY_PATH' },
        env: { SFTP_TEST_KEY_PATH: keyPath },
      });

      expect(await paths(client, '*.csv')).toEqual(['a.csv']);
    });

    it('rejects a key it cannot read before it opens a connection', async () => {
      const server = await serve({ methods: ['publickey'] });
      const notAKey = `not-a-key-${randomBytes(4).toString('hex')}`;

      const attempt = connect(server, {
        auth: { type: 'private_key', private_key_env: 'SFTP_TEST_KEY' },
        env: { SFTP_TEST_KEY: notAKey },
      });

      await expect(attempt).rejects.toThrow('SFTP auth private key could not be read');
      await expect(attempt).rejects.not.toThrow(notAKey);
      expect(server.stats.acceptedConnections).toBe(0);
    });

    it('reads every credential before it opens a connection', async () => {
      const server = await serve();

      await expect(
        connect(server, {
          auth: { type: 'password', password_env: 'SFTP_TEST_MISSING' },
          env: { SFTP_TEST_MISSING: '' },
        })
      ).rejects.toThrow('SFTP auth password_env references missing env var SFTP_TEST_MISSING');
      expect(server.stats.acceptedConnections).toBe(0);
    });

    it('needs exactly one private key source', async () => {
      const server = await serve({ methods: ['publickey'] });

      await expect(
        connect(server, {
          auth: {
            type: 'private_key',
            private_key_env: 'SFTP_TEST_KEY',
            private_key_path_env: 'SFTP_TEST_KEY_PATH',
          },
          env: { SFTP_TEST_KEY: 'unused', SFTP_TEST_KEY_PATH: 'unused' },
        })
      ).rejects.toThrow('exactly one of private_key_env or private_key_path_env');
      expect(server.stats.acceptedConnections).toBe(0);
    });

    it('requires private_key_env to be declared in auth_env_vars', async () => {
      await expect(
        SftpFileStorageClient.create(
          { host: '127.0.0.1', username: 'acme', base_directory: '/data' },
          {
            type: 'private_key',
            private_key_env: 'SFTP_TEST_KEY',
            host_fingerprint: 'SHA256:abc',
          },
          undefined,
          []
        )
      ).rejects.toThrow('Add SFTP_TEST_KEY to auth_env_vars');
    });
  });

  describe('host keys', () => {
    it.each([
      ['padded', (fingerprint: string) => fingerprint],
      ['unpadded', (fingerprint: string) => fingerprint.replace(/=+$/, '')],
      ['unprefixed', (fingerprint: string) => fingerprint.replace(/^SHA256:/, '')],
    ])('accepts a %s SHA256 fingerprint', async (_label, format) => {
      const server = await serve();
      server.tree.file('/data/a.csv', 'id\n1\n');
      expect(server.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}=$/);
      const client = await connect(server, {
        auth: {
          type: 'password',
          password_env: PASSWORD_ENV,
          host_fingerprint: format(server.fingerprint),
        },
      });

      expect(await paths(client, '*.csv')).toEqual(['a.csv']);
    });

    it('refuses a server whose host key does not match', async () => {
      const server = await serve();
      const other = await serve();

      await expect(
        connect(server, {
          auth: { type: 'password', password_env: PASSWORD_ENV, host_fingerprint: other.fingerprint },
        })
      ).rejects.toThrow('Host denied (verification failed)');
    });
  });

  describe('older servers', () => {
    it('answers keyboard-interactive password prompts only when enabled', async () => {
      const server = await serve({ methods: ['keyboard-interactive'] });
      server.tree.file('/data/a.csv', 'id\n1\n');

      await expect(connect(server)).rejects.toThrow('All configured authentication methods failed');

      const client = await connect(server, {
        auth: { type: 'password', password_env: PASSWORD_ENV, keyboard_interactive: true },
      });
      expect(await paths(client, '*.csv')).toEqual(['a.csv']);
    });

    it('offers legacy algorithms only when enabled', async () => {
      const server = await serve({
        algorithms: { kex: ['diffie-hellman-group14-sha1'], cipher: ['aes128-cbc'] },
      });
      server.tree.file('/data/a.csv', 'id\n1\n');

      await expect(connect(server)).rejects.toThrow('Handshake failed');

      const client = await connect(server, { connection: { legacy_algorithms: true } });
      expect(await paths(client, '*.csv')).toEqual(['a.csv']);
    });

    it('notices a server that stops answering when keepalive is on', async () => {
      const server = await serve();
      server.tree.file('/data/a.csv', 'id\n1\n');
      const quiet = await new FreezableRelay(server.port).start();
      const watched = await new FreezableRelay(server.port).start();
      cleanups.push(() => quiet.stop(), () => watched.stop());
      const withoutKeepalive = await connect(server, { port: quiet.port });
      const withKeepalive = await connect(server, {
        port: watched.port,
        connection: { keepalive_interval_seconds: 0.2 },
      });
      quiet.freeze();
      watched.freeze();

      const waiting = paths(withoutKeepalive, '*.csv');
      waiting.catch(() => undefined);
      await expect(paths(withKeepalive, '*.csv')).rejects.toThrow();
      expect(
        await Promise.race([
          waiting.then(
            () => 'finished',
            () => 'failed'
          ),
          delay(250).then(() => 'waiting'),
        ])
      ).toBe('waiting');
    });
  });

  describe('extraction', () => {
    it('logs skipped folders and closes the connection when the run ends', async () => {
      const server = await serve();
      server.tree
        .file('/data/exports/a.csv', 'id,name\n1,Ada\n')
        .file('/data/exports/locked/b.csv', 'id,name\n2,Grace\n')
        .deny('/data/exports/locked');
      vi.stubEnv(PASSWORD_ENV, server.password);
      const stdout = new FakeWritable();
      const stderr = new FakeWritable();
      const state: ExtractorState = { streams: {} };
      const resource: FileResourceSpec = {
        spec_version: '1',
        type: 'resource',
        name: 'people',
        description: '',
        input: {},
        source: { path: 'exports/', format: 'csv', options: { header: true } },
        replication: { method: 'full_refresh' },
        extract: {},
        output: { id: { type: 'integer' }, name: { type: 'string' } },
      } as FileResourceSpec;

      const result = await extractFileStorageResource({
        integration: {
          spec_version: '1',
          type: 'integration',
          name: 'partner_drop',
          source_type: 'sftp',
          auth_env_vars: [PASSWORD_ENV],
          connection: {
            host: '127.0.0.1',
            port: server.port,
            username: server.username,
            base_directory: '/data',
          },
          auth: { type: 'password', password_env: PASSWORD_ENV, host_fingerprint: server.fingerprint },
        } as IntegrationSpec,
        resource,
        integrationName: 'partner_drop',
        emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
        logger: new ControlLogger({ stream: stderr }),
        state,
        stateStore: { load: vi.fn().mockResolvedValue(state), save: vi.fn() },
        advanceState: false,
      });

      expect(result.recordCount).toBe(1);
      expect(stderr.chunks.join('')).toContain(
        'Skipping SFTP folder exports/locked: Permission denied'
      );
      expect(server.openConnections).toBe(0);
    });
  });
});
