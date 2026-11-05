import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { posix } from 'node:path';

/**
 * In-process SFTP server for tests. It serves an in-memory tree, so folder
 * permissions and links behave the same for every user, including root.
 * Host and client keys are generated at run time; no key material is stored.
 */

type Attributes = {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
};

type ParsedKey = {
  type: string;
  getPublicSSH(): Buffer;
  verify(data: Buffer, signature: Buffer, hashAlgo?: string): boolean | Error;
};

type AuthContext = {
  method: string;
  username: string;
  password?: string;
  key?: { algo: string; data: Buffer };
  signature?: Buffer;
  blob?: Buffer;
  hashAlgo?: string;
  accept(): void;
  reject(methods?: string[], isPartial?: boolean): void;
  prompt(
    prompts: Array<{ prompt: string; echo: boolean }>,
    callback: (answers: string[]) => void
  ): void;
};

interface SftpStream {
  on(event: 'REALPATH' | 'STAT' | 'LSTAT' | 'OPENDIR', listener: (id: number, path: string) => void): this;
  on(event: 'READDIR' | 'FSTAT' | 'CLOSE', listener: (id: number, handle: Buffer) => void): this;
  on(event: 'OPEN', listener: (id: number, path: string, flags: number) => void): this;
  on(
    event: 'READ',
    listener: (id: number, handle: Buffer, offset: number, length: number) => void
  ): this;
  handle(id: number, handle: Buffer): void;
  status(id: number, code: number, message?: string): void;
  data(id: number, data: Buffer): void;
  name(
    id: number,
    names: Array<{ filename: string; longname: string; attrs: Partial<Attributes> }>
  ): void;
  attrs(id: number, attrs: Attributes): void;
}

interface ServerConnection {
  on(event: 'authentication', listener: (context: AuthContext) => void): this;
  on(event: 'session', listener: (accept: () => SshSession) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  end(): void;
}

interface SshSession {
  on(event: 'sftp', listener: (accept: () => SftpStream) => void): this;
}

interface SshServer {
  listen(port: number, host: string, callback: () => void): void;
  address(): AddressInfo;
  close(callback?: () => void): void;
}

interface Ssh2Module {
  Server: new (
    config: Record<string, unknown>,
    listener: (connection: ServerConnection) => void
  ) => SshServer;
  utils: {
    generateKeyPairSync(
      type: 'ed25519',
      options?: { passphrase?: string; cipher?: string; rounds?: number }
    ): { private: string; public: string };
    parseKey(data: string): ParsedKey | ParsedKey[] | Error;
    sftp: { STATUS_CODE: Record<string, number> };
  };
}

export const ssh2 = createRequire(import.meta.url)('ssh2') as Ssh2Module;
const STATUS = ssh2.utils.sftp.STATUS_CODE;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

type TreeNode =
  | { type: 'dir'; mtime: number; denied: boolean }
  | { type: 'file'; mtime: number; content: Buffer }
  | { type: 'link'; mtime: number; target: string };

type Resolved = { path: string; node: TreeNode } | { error: number };

const nowSeconds = () => Math.floor(Date.now() / 1000);

export class MemoryTree {
  private readonly nodes = new Map<string, TreeNode>([
    ['/', { type: 'dir', mtime: nowSeconds(), denied: false }],
  ]);

  mkdir(path: string, mtime = nowSeconds()): this {
    let current = '/';
    for (const segment of posix.normalize(path).split('/').filter(Boolean)) {
      current = posix.join(current, segment);
      if (!this.nodes.has(current)) this.nodes.set(current, { type: 'dir', mtime, denied: false });
    }
    return this;
  }

  file(path: string, content: string | Buffer, mtime = nowSeconds()): this {
    this.mkdir(posix.dirname(path));
    this.nodes.set(posix.normalize(path), {
      type: 'file',
      mtime,
      content: typeof content === 'string' ? Buffer.from(content) : content,
    });
    return this;
  }

  link(path: string, target: string): this {
    this.mkdir(posix.dirname(path));
    this.nodes.set(posix.normalize(path), { type: 'link', mtime: nowSeconds(), target });
    return this;
  }

  deny(path: string): this {
    const node = this.nodes.get(posix.normalize(path));
    if (node?.type !== 'dir') throw new Error(`No test folder at ${path}`);
    node.denied = true;
    return this;
  }

  names(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...this.nodes.keys()]
      .filter((key) => key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map((key) => key.slice(prefix.length));
  }

  lookup(path: string): TreeNode | undefined {
    return this.nodes.get(path);
  }

  resolve(path: string, followLast: boolean, depth = 0): Resolved {
    const segments = posix.normalize(posix.join('/', path)).split('/').filter(Boolean);
    let current = '/';
    for (const [index, segment] of segments.entries()) {
      const candidate = posix.join(current, segment);
      const node = this.nodes.get(candidate);
      if (!node) return { error: STATUS['NO_SUCH_FILE']! };
      const last = index === segments.length - 1;
      if (node.type === 'link' && (!last || followLast)) {
        if (depth > 32) return { error: STATUS['FAILURE']! };
        const target = this.resolve(posix.resolve(current, node.target), true, depth + 1);
        if ('error' in target) return target;
        if (!last && target.node.type !== 'dir') return { error: STATUS['NO_SUCH_FILE']! };
        current = target.path;
      } else {
        if (!last && node.type !== 'dir') return { error: STATUS['NO_SUCH_FILE']! };
        current = candidate;
      }
    }
    return { path: current, node: this.nodes.get(current)! };
  }
}

function attributesOf(node: TreeNode): Attributes {
  const base = { uid: 1000, gid: 1000, atime: node.mtime, mtime: node.mtime };
  if (node.type === 'dir') return { ...base, mode: S_IFDIR | 0o755, size: 4096 };
  if (node.type === 'file') return { ...base, mode: S_IFREG | 0o644, size: node.content.length };
  return { ...base, mode: S_IFLNK | 0o777, size: node.target.length };
}

function longnameOf(name: string, node: TreeNode): string {
  const kind = node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : '-';
  return `${kind}rw-r--r-- 1 acme acme ${attributesOf(node).size} Jan 1 00:00 ${name}`;
}

export type SftpTestServerOptions = {
  methods?: Array<'password' | 'publickey' | 'keyboard-interactive'>;
  publicKeys?: string[];
  algorithms?: Record<string, string[]>;
  deferReads?: boolean;
  realpathFollowsLinks?: boolean;
  omitListingModes?: boolean;
};

type Handle =
  | { kind: 'dir'; path: string; sent: boolean }
  | { kind: 'file'; content: Buffer };

export class SftpTestServer {
  readonly tree = new MemoryTree();
  readonly username = 'acme';
  readonly password = randomBytes(12).toString('hex');
  readonly stats = { reads: 0, maxReadsInFlight: 0, acceptedConnections: 0, closedConnections: 0 };
  readonly fingerprint: string;
  port = 0;

  private readonly hostKey = ssh2.utils.generateKeyPairSync('ed25519');
  private readonly server: SshServer;
  private readonly connections = new Set<ServerConnection>();
  private readonly closeWaiters: Array<() => void> = [];
  private readsInFlight = 0;

  constructor(private readonly options: SftpTestServerOptions = {}) {
    const blob = Buffer.from(this.hostKey.public.split(' ')[1] ?? '', 'base64');
    this.fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64')}`;
    this.server = new ssh2.Server(
      { hostKeys: [this.hostKey.private], ...(options.algorithms ? { algorithms: options.algorithms } : {}) },
      (connection) => this.accept(connection)
    );
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get openConnections(): number {
    return this.connections.size;
  }

  waitForClose(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private accept(connection: ServerConnection): void {
    this.connections.add(connection);
    this.stats.acceptedConnections += 1;
    connection.on('error', () => undefined);
    connection.on('close', () => {
      this.connections.delete(connection);
      this.stats.closedConnections += 1;
      for (const waiter of this.closeWaiters.splice(0)) waiter();
    });
    connection.on('authentication', (context) => this.authenticate(context));
    connection.on('session', (acceptSession) => {
      acceptSession().on('sftp', (acceptSftp) => this.serve(acceptSftp()));
    });
  }

  private authenticate(context: AuthContext): void {
    const methods: string[] = this.options.methods ?? ['password', 'publickey'];
    if (context.username !== this.username || !methods.includes(context.method)) {
      context.reject(methods);
      return;
    }
    if (context.method === 'password') {
      if (context.password === this.password) context.accept();
      else context.reject(methods);
      return;
    }
    if (context.method === 'keyboard-interactive') {
      context.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
        if (answers[0] === this.password) context.accept();
        else context.reject(methods);
      });
      return;
    }
    const key = (this.options.publicKeys ?? [])
      .map((line) => ssh2.utils.parseKey(line))
      .find(
        (parsed): parsed is ParsedKey =>
          !(parsed instanceof Error) &&
          !Array.isArray(parsed) &&
          parsed.type === context.key?.algo &&
          parsed.getPublicSSH().equals(context.key.data)
      );
    if (!key) {
      context.reject(methods);
      return;
    }
    if (!context.signature) {
      context.accept();
      return;
    }
    if (context.blob && key.verify(context.blob, context.signature, context.hashAlgo) === true) {
      context.accept();
    } else {
      context.reject(methods);
    }
  }

  private serve(sftp: SftpStream): void {
    const handles = new Map<string, Handle>();
    let nextHandle = 0;
    const open = (handle: Handle) => {
      const id = Buffer.from(String((nextHandle += 1)));
      handles.set(id.toString(), handle);
      return id;
    };
    const fail = (id: number, resolved: Resolved): resolved is { error: number } => {
      if ('error' in resolved) sftp.status(id, resolved.error);
      return 'error' in resolved;
    };

    sftp.on('REALPATH', (id, path) => {
      const resolved =
        this.options.realpathFollowsLinks === false
          ? { path: posix.normalize(posix.join('/', path)), node: this.tree.lookup('/')! }
          : this.tree.resolve(path, true);
      if (fail(id, resolved)) return;
      sftp.name(id, [{ filename: resolved.path, longname: resolved.path, attrs: attributesOf(resolved.node) }]);
    });
    sftp.on('STAT', (id, path) => {
      const resolved = this.tree.resolve(path, true);
      if (!fail(id, resolved)) sftp.attrs(id, attributesOf(resolved.node));
    });
    sftp.on('LSTAT', (id, path) => {
      const resolved = this.tree.resolve(path, false);
      if (!fail(id, resolved)) sftp.attrs(id, attributesOf(resolved.node));
    });
    sftp.on('OPENDIR', (id, path) => {
      const resolved = this.tree.resolve(path, true);
      if (fail(id, resolved)) return;
      if (resolved.node.type !== 'dir') return sftp.status(id, STATUS['FAILURE']!, 'Not a folder');
      if (resolved.node.denied) return sftp.status(id, STATUS['PERMISSION_DENIED']!);
      sftp.handle(id, open({ kind: 'dir', path: resolved.path, sent: false }));
    });
    sftp.on('READDIR', (id, handle) => {
      const entry = handles.get(handle.toString());
      if (entry?.kind !== 'dir') return sftp.status(id, STATUS['FAILURE']!);
      if (entry.sent) return sftp.status(id, STATUS['EOF']!);
      entry.sent = true;
      const names = this.tree
        .names(entry.path)
        .sort()
        .reverse()
        .map((name) => {
          const node = this.tree.lookup(posix.join(entry.path, name))!;
          const { mode, ...withoutMode } = attributesOf(node);
          return {
            filename: name,
            longname: longnameOf(name, node),
            attrs: this.options.omitListingModes ? withoutMode : { ...withoutMode, mode },
          };
        });
      const dot = attributesOf({ type: 'dir', mtime: 0, denied: false });
      sftp.name(id, [
        { filename: '.', longname: '.', attrs: dot },
        { filename: '..', longname: '..', attrs: dot },
        ...names,
      ]);
    });
    sftp.on('OPEN', (id, path) => {
      const resolved = this.tree.resolve(path, true);
      if (fail(id, resolved)) return;
      if (resolved.node.type !== 'file') return sftp.status(id, STATUS['FAILURE']!, 'Not a file');
      sftp.handle(id, open({ kind: 'file', content: resolved.node.content }));
    });
    sftp.on('FSTAT', (id, handle) => {
      const entry = handles.get(handle.toString());
      if (entry?.kind !== 'file') return sftp.status(id, STATUS['FAILURE']!);
      sftp.attrs(id, attributesOf({ type: 'file', mtime: nowSeconds(), content: entry.content }));
    });
    sftp.on('READ', (id, handle, offset, length) => {
      const entry = handles.get(handle.toString());
      if (entry?.kind !== 'file') return sftp.status(id, STATUS['FAILURE']!);
      this.stats.reads += 1;
      this.readsInFlight += 1;
      this.stats.maxReadsInFlight = Math.max(this.stats.maxReadsInFlight, this.readsInFlight);
      const respond = () => {
        this.readsInFlight -= 1;
        if (offset >= entry.content.length) sftp.status(id, STATUS['EOF']!);
        else sftp.data(id, entry.content.subarray(offset, offset + length));
      };
      if (this.options.deferReads) setImmediate(respond);
      else respond();
    });
    sftp.on('CLOSE', (id, handle) => {
      handles.delete(handle.toString());
      sftp.status(id, STATUS['OK']!);
    });
  }
}

export async function startSftpTestServer(options?: SftpTestServerOptions): Promise<SftpTestServer> {
  return new SftpTestServer(options).start();
}

export function generateClientKey(passphrase?: string): { private: string; public: string } {
  return ssh2.utils.generateKeyPairSync(
    'ed25519',
    passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 1 } : undefined
  );
}

/** A TCP relay that can stop forwarding, so a test can simulate a silent server. */
export class FreezableRelay {
  port = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private frozen = false;

  constructor(targetPort: number) {
    this.server = createServer((inbound) => {
      const outbound = connect(targetPort, '127.0.0.1');
      for (const socket of [inbound, outbound]) {
        this.sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => this.sockets.delete(socket));
      }
      inbound.on('data', (chunk) => this.frozen || outbound.write(chunk));
      outbound.on('data', (chunk) => this.frozen || inbound.write(chunk));
      inbound.on('close', () => outbound.destroy());
      outbound.on('close', () => inbound.destroy());
    });
  }

  async start(): Promise<this> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  freeze(): void {
    this.frozen = true;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
