/**
 * In-process SFTP server for unit tests: a real ssh2 Server on 127.0.0.1
 * serving a local directory, with switches for stalled and dropped reads.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import ssh2 from 'ssh2';
import type { Connection, ParsedKey, SFTPWrapper } from 'ssh2';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

export type TestKeyType = 'ed25519' | 'rsa' | 'ecdsa';

export interface TestKey {
  privateKey: string;
  /** Second field of the OpenSSH public key line. */
  publicKey: string;
  algorithm: string;
  fingerprint: string;
}

export function generateTestKey(type: TestKeyType): TestKey {
  const pair =
    type === 'rsa'
      ? utils.generateKeyPairSync('rsa', { bits: 2048 })
      : type === 'ecdsa'
        ? utils.generateKeyPairSync('ecdsa', { bits: 256 })
        : utils.generateKeyPairSync('ed25519');
  const [algorithm, publicKey] = pair.public.split(' ') as [string, string];
  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(publicKey, 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
  return { privateKey: pair.private, publicKey, algorithm, fingerprint };
}

export interface TestSftpServerOptions {
  root: string;
  hostKeys: TestKey[];
  password?: string;
  clientKey?: TestKey;
  stallReads?: boolean;
  dropOnRead?: boolean;
  readDelayMs?: number;
  /** Entries per READDIR reply (default: the whole directory). */
  readdirBatchSize?: number;
  /** Delay before every READDIR reply, including the final EOF. */
  readdirDelayMs?: number;
  stallReaddir?: boolean;
  /** Accept the session but refuse to start the sftp subsystem. */
  refuseSftp?: boolean;
  /** Present this key's public blob for the first host key while signing with the real one. */
  presentPublicKeyOf?: TestKey;
  /** Leave `size` out of every attrs reply, as some servers do. */
  omitSize?: boolean;
  /** Leave `mode` out of every attrs reply, as some servers do. */
  omitMode?: boolean;
  /** Refuse every OPENDIR with permission denied. */
  denyOpendir?: boolean;
  /** Refuse every STAT with permission denied, like `sftp-server -P stat`. */
  denyStat?: boolean;
}

export interface TestSftpServer {
  port: number;
  stats: { reads: number; inFlightReads: number; maxInFlightReads: number };
  close(): Promise<void>;
}

function attrsOf(
  stats: import('node:fs').Stats,
  { omitSize = false, omitMode = false }: { omitSize?: boolean; omitMode?: boolean } = {}
) {
  return {
    ...(omitMode ? {} : { mode: stats.mode }),
    uid: stats.uid,
    gid: stats.gid,
    ...(omitSize ? {} : { size: stats.size }),
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function serveSftp(
  sftp: SFTPWrapper,
  connection: Connection,
  options: TestSftpServerOptions,
  stats: TestSftpServer['stats'],
  closing: Set<Promise<unknown>>
): void {
  const handles = new Map<number, { fd?: fs.FileHandle; dir?: string; offset?: number }>();
  // Clients that stall, cancel or drop never send CLOSE; release their files here.
  connection.on('close', () => {
    for (const entry of handles.values()) {
      if (entry.fd) closing.add(entry.fd.close().catch(() => undefined));
    }
    handles.clear();
  });
  let nextHandle = 0;
  const local = (remote: string) => path.join(options.root, path.posix.normalize(`/${remote}`));
  const fail = (reqid: number, error: unknown) => {
    const code = (error as { code?: string }).code;
    sftp.status(
      reqid,
      code === 'ENOENT'
        ? STATUS_CODE.NO_SUCH_FILE
        : code === 'EACCES'
          ? STATUS_CODE.PERMISSION_DENIED
          : STATUS_CODE.FAILURE
    );
  };
  const handleBuffer = (id: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id);
    return buffer;
  };

  sftp
    .on('REALPATH', async (reqid, remote) => {
      try {
        const realRoot = await fs.realpath(options.root);
        const real = await fs.realpath(local(remote));
        const relative = path.relative(realRoot, real);
        const filename =
          relative.startsWith('..') || path.isAbsolute(relative)
            ? `/__outside__${real}`
            : `/${relative.split(path.sep).join('/')}`;
        sftp.name(reqid, [{ filename, longname: filename, attrs: {} as never }]);
      } catch (error) {
        fail(reqid, error);
      }
    })
    .on('OPENDIR', async (reqid, remote) => {
      try {
        const dir = local(remote);
        if (options.denyOpendir) throw Object.assign(new Error(), { code: 'EACCES' });
        if (!(await fs.stat(dir)).isDirectory()) {
          // OpenSSH maps ENOTDIR to NO_SUCH_FILE.
          throw Object.assign(new Error(), { code: 'ENOENT' });
        }
        const id = nextHandle++;
        handles.set(id, { dir });
        sftp.handle(reqid, handleBuffer(id));
      } catch (error) {
        fail(reqid, error);
      }
    })
    .on('READDIR', async (reqid, handle) => {
      if (options.stallReaddir) return;
      if (options.readdirDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.readdirDelayMs));
      }
      const entry = handles.get(handle.readUInt32BE(0));
      if (!entry?.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
      const all = (await fs.readdir(entry.dir)).sort();
      const offset = entry.offset ?? 0;
      if (offset >= all.length) return sftp.status(reqid, STATUS_CODE.EOF);
      const names = all.slice(offset, offset + (options.readdirBatchSize ?? all.length));
      entry.offset = offset + names.length;
      const listing = await Promise.all(
        names.map(async (filename) => ({
          filename,
          longname: filename,
          attrs: attrsOf(await fs.lstat(path.join(entry.dir!, filename)), options) as never,
        }))
      );
      sftp.name(reqid, listing);
    })
    .on('OPEN', async (reqid, remote) => {
      try {
        const fd = await fs.open(local(remote), 'r');
        const id = nextHandle++;
        handles.set(id, { fd });
        sftp.handle(reqid, handleBuffer(id));
      } catch (error) {
        fail(reqid, error);
      }
    })
    .on('FSTAT', async (reqid, handle) => {
      const entry = handles.get(handle.readUInt32BE(0));
      if (!entry?.fd) return sftp.status(reqid, STATUS_CODE.FAILURE);
      sftp.attrs(reqid, attrsOf(await entry.fd.stat(), options) as never);
    })
    .on('STAT', async (reqid, remote) => {
      try {
        if (options.denyStat) throw Object.assign(new Error(), { code: 'EACCES' });
        sftp.attrs(reqid, attrsOf(await fs.stat(local(remote)), options) as never);
      } catch (error) {
        fail(reqid, error);
      }
    })
    .on('LSTAT', async (reqid, remote) => {
      try {
        sftp.attrs(reqid, attrsOf(await fs.lstat(local(remote)), options) as never);
      } catch (error) {
        fail(reqid, error);
      }
    })
    .on('READ', (reqid, handle, offset, length) => {
      stats.reads += 1;
      if (options.dropOnRead) {
        // Simulate a network drop: kill the TCP socket without an SSH disconnect.
        (connection as unknown as { _sock: { destroy(): void } })._sock.destroy();
        return;
      }
      if (options.stallReads) return;
      stats.inFlightReads += 1;
      stats.maxInFlightReads = Math.max(stats.maxInFlightReads, stats.inFlightReads);
      setTimeout(async () => {
        stats.inFlightReads -= 1;
        const entry = handles.get(handle.readUInt32BE(0));
        if (!entry?.fd) return sftp.status(reqid, STATUS_CODE.FAILURE);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await entry.fd.read(buffer, 0, length, offset);
        if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
        sftp.data(reqid, buffer.subarray(0, bytesRead));
      }, options.readDelayMs ?? 2);
    })
    .on('CLOSE', async (reqid, handle) => {
      const id = handle.readUInt32BE(0);
      await handles.get(id)?.fd?.close();
      handles.delete(id);
      sftp.status(reqid, STATUS_CODE.OK);
    });
}

export async function startTestSftpServer(options: TestSftpServerOptions): Promise<TestSftpServer> {
  const stats = { reads: 0, inFlightReads: 0, maxInFlightReads: 0 };
  const password = Buffer.from(options.password ?? 'secret');
  const clientKey: ParsedKey | undefined = options.clientKey
    ? (utils.parseKey(options.clientKey.privateKey) as ParsedKey)
    : undefined;
  const connections = new Set<Connection>();
  const closing = new Set<Promise<unknown>>();
  const hostKeys = options.hostKeys.map((key) => utils.parseKey(key.privateKey) as ParsedKey);
  if (options.presentPublicKeyOf && hostKeys[0]) {
    const blob = Buffer.from(options.presentPublicKeyOf.publicKey, 'base64');
    hostKeys[0].getPublicSSH = () => blob;
  }
  const server = new Server({ hostKeys: hostKeys.map((key) => ({ key })) }, (connection) => {
    connections.add(connection);
    connection.on('error', () => undefined);
    connection.on('close', () => connections.delete(connection));
    connection.on('authentication', (ctx) => {
      if (ctx.username !== 'agent') return ctx.reject();
      if (ctx.method === 'password' && equal(Buffer.from(ctx.password), password)) {
        return ctx.accept();
      }
      if (
        ctx.method === 'publickey' &&
        clientKey &&
        ctx.key.algo === clientKey.type &&
        equal(ctx.key.data, clientKey.getPublicSSH())
      ) {
        if (!ctx.signature) return ctx.accept();
        if (clientKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) {
          return ctx.accept();
        }
      }
      ctx.reject();
    });
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        accept().on('sftp', (acceptSftp, rejectSftp) => {
          if (options.refuseSftp) return rejectSftp();
          serveSftp(acceptSftp(), connection, options, stats, closing);
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    stats,
    close: async () => {
      for (const connection of connections) connection.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(closing);
    },
  };
}
