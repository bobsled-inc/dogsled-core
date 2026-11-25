import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCommitStateCommand } from '../../src/commands/commit-state.js';
import { registerExtractCommand } from '../../src/commands/extract.js';
import {
  commitStagedState,
  resolveStagedStatePath,
  StagedStateStore,
} from '../../src/runtime/staged-state.js';
import { HttpStateStore } from '../../src/runtime/state-backend.js';
import { FileStateStore } from '../../src/runtime/state.js';
import { createWarehouseClient, type WarehouseClient } from '../../src/runtime/warehouse-client.js';

import type { ExtractorState } from '../../src/types/index.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});
vi.mock('../../src/runtime/warehouse-client.js', () => ({ createWarehouseClient: vi.fn() }));

function warehouseClient(): WarehouseClient {
  return {
    dialect: 'postgres',
    async *execute() {
      yield [{ id: 1, updated_at: '2026-01-01T00:00:00.000Z' }];
    },
    testConnection: vi.fn(),
    introspect: vi.fn(),
    close: vi.fn(),
  } as unknown as WarehouseClient;
}

const bookmark = (files: string[]): ExtractorState['streams'][string] => ({
  last_run_at: '2026-01-01T00:00:00.000Z',
  record_count: files.length,
  files: Object.fromEntries(files.map((file) => [file, { etag: `"${file}"` }])),
});

let root: string;
let stagedPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-staged-state-')));
  stagedPath = path.join(root, 'staged.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('staged state with a directory backend', () => {
  it('is not saved before it is committed, and is complete then', async () => {
    const backend = new FileStateStore(path.join(root, 'state'));
    await backend.save({ streams: { 'files/docs': bookmark(['a.md']) } });
    const state = await backend.load();
    const staged = new StagedStateStore(backend, state, stagedPath);
    expect(await staged.load()).toEqual(state);

    state.streams['files/docs'] = bookmark(['a.md', 'b.md']);
    await staged.save(state);
    state.streams['files/notes'] = bookmark(['n.md']);
    await staged.save(state);
    expect((await backend.load()).streams).toEqual({ 'files/docs': bookmark(['a.md']) });
    expect(fs.statSync(stagedPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).sort()).toEqual(['staged.json', 'state']);

    await commitStagedState(new FileStateStore(path.join(root, 'state')), stagedPath);
    expect((await backend.load()).streams).toEqual({
      'files/docs': bookmark(['a.md', 'b.md']),
      'files/notes': bookmark(['n.md']),
    });
  });

  describe('while it is written', () => {
    const UUID = '00000000-0000-4000-8000-000000000000';
    const target = (): string => path.join(root, 'target');

    /** Save over a link at the name that a temp file would have. */
    async function saveOverLink(name: string): Promise<void> {
      fs.writeFileSync(target(), 'untouched');
      fs.symlinkSync(target(), name);
      const backend = new FileStateStore(path.join(root, 'state'));
      const staged = new StagedStateStore(backend, { streams: {} }, stagedPath);
      await staged.save({ streams: { 'files/docs': bookmark(['a.md']) } });
    }

    it('uses a name that is not known before', async () => {
      await saveOverLink(`${stagedPath}.${process.pid}.tmp`);
      expect(fs.readFileSync(target(), 'utf8')).toBe('untouched');
      expect(fs.readFileSync(stagedPath, 'utf8')).toContain('a.md');
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([
        `staged.json.${process.pid}.tmp`,
      ]);
    });

    it('never writes through a file that is there', async () => {
      vi.mocked(randomUUID).mockReturnValueOnce(UUID);
      await expect(saveOverLink(`${stagedPath}.${UUID}.tmp`)).rejects.toThrow(/EEXIST/);
      expect(fs.readFileSync(target(), 'utf8')).toBe('untouched');
      expect(fs.existsSync(stagedPath)).toBe(false);
    });
  });

  it('is saved over what another run of the same stream saved, as before', async () => {
    const backend = new FileStateStore(path.join(root, 'state'));
    await backend.save({ streams: { 'files/docs': bookmark([]) } });
    const state = await backend.load();
    const staged = new StagedStateStore(backend, state, stagedPath);
    state.streams['files/docs'] = bookmark(['a.md']);
    await staged.save(state);
    expect(JSON.parse(fs.readFileSync(stagedPath, 'utf8'))).toEqual({
      streams: { 'files/docs': bookmark(['a.md']) },
    });
    await backend.save({ streams: { 'files/docs': bookmark(['b.md']) } });
    await commitStagedState(backend, stagedPath);
    expect((await backend.load()).streams).toEqual({ 'files/docs': bookmark(['a.md']) });
  });

  it('keeps what another run saved in the meantime', async () => {
    const backend = new FileStateStore(path.join(root, 'state'));
    await backend.save({ streams: { 'files/docs': bookmark([]), 'files/old': bookmark([]) } });
    const state = await backend.load();
    const staged = new StagedStateStore(backend, state, stagedPath);
    state.streams['files/docs'] = bookmark(['a.md']);
    await staged.save(state);

    await backend.save({
      streams: {
        'files/docs': bookmark([]),
        'files/old': bookmark(['other.csv']),
        'files/new': bookmark(['new.csv']),
      },
    });
    await commitStagedState(backend, stagedPath);
    expect((await backend.load()).streams).toEqual({
      'files/docs': bookmark(['a.md']),
      'files/old': bookmark(['other.csv']),
      'files/new': bookmark(['new.csv']),
    });
  });

  it.each(['', 'not json', '{"streams":{"files/docs":{"files":"private.pdf"}}}'])(
    'is refused without a quote when it is damaged: %j',
    async (content) => {
      fs.writeFileSync(stagedPath, content);
      const backend = new FileStateStore(path.join(root, 'state'));
      await expect(commitStagedState(backend, stagedPath)).rejects.toThrow(
        /^The staged state cannot be read\.$/
      );
      expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
    }
  );
});

describe('staged state with an HTTP backend', () => {
  /** A state service that sends an ETag, or none, and honors If-Match. */
  function service(initial: ExtractorState | undefined, hasEtags = true) {
    let current = initial;
    let revision = 1;
    const puts: Array<{ ifMatch: string | null; body: ExtractorState }> = [];
    const etag = (): Record<string, string> => (hasEtags ? { etag: `"v${revision}"` } : {});
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      if (init.method === 'GET') {
        return current === undefined
          ? new Response(null, { status: 404 })
          : Response.json(current, { headers: etag() });
      }
      const ifMatch = new Headers(init.headers).get('if-match');
      if (ifMatch !== null && ifMatch !== `"v${revision}"`) {
        return new Response(null, { status: 412 });
      }
      current = JSON.parse(String(init.body)) as ExtractorState;
      revision += 1;
      puts.push({ ifMatch, body: current });
      return new Response(null, { status: 204, headers: etag() });
    });
    return {
      store: () =>
        new HttpStateStore({
          url: 'https://state.example/docs',
          fetch: fetchMock as unknown as typeof fetch,
        }),
      puts,
      /** Another run saves its state. */
      change: (state: ExtractorState) => {
        current = state;
        revision += 1;
      },
    };
  }

  async function stage(state: ReturnType<typeof service>): Promise<void> {
    const store = state.store();
    const loaded = await store.load();
    const staged = new StagedStateStore(store, loaded, stagedPath);
    loaded.streams['files/docs'] = bookmark(['a.md']);
    await staged.save(loaded);
    expect(state.puts).toEqual([]);
  }

  it.each([
    ['an ETag', true, '"v1"'],
    ['no ETag', false, null],
  ])(
    'is saved once, with the precondition of a service that sends %s',
    async (_, etags, ifMatch) => {
      const state = service({ streams: { 'files/old': bookmark(['o.csv']) } }, etags);
      await stage(state);
      await commitStagedState(state.store(), stagedPath);
      expect(state.puts).toEqual([
        {
          ifMatch,
          body: { streams: { 'files/old': bookmark(['o.csv']), 'files/docs': bookmark(['a.md']) } },
        },
      ]);
    }
  );

  it('is saved where there was no state', async () => {
    const state = service(undefined);
    await stage(state);
    await commitStagedState(state.store(), stagedPath);
    expect(state.puts).toEqual([
      { ifMatch: null, body: { streams: { 'files/docs': bookmark(['a.md']) } } },
    ]);
  });

  it.each([
    ['another stream was saved', { 'files/other': bookmark(['o.csv']) }],
    ['a stream of this run was saved as it was, in another order', {}],
  ])('is merged into the state that is there when %s', async (_label, others) => {
    const before = bookmark(['a.md', 'b.md']);
    const state = service({ streams: { 'files/docs': before } });
    const store = state.store();
    const loaded = await store.load();
    const staged = new StagedStateStore(store, loaded, stagedPath);
    loaded.streams['files/docs'] = bookmark(['a.md', 'b.md', 'c.md']);
    await staged.save(loaded);

    const reversed = JSON.parse(
      JSON.stringify(before, Object.keys({ ...before, ...before.files, etag: '' }).reverse())
    ) as typeof before;
    expect(Object.keys(reversed)[0]).not.toBe(Object.keys(before)[0]);
    expect(reversed).toEqual(before);
    state.change({ streams: { ...others, 'files/docs': reversed } });
    await commitStagedState(state.store(), stagedPath);
    expect(state.puts).toEqual([
      {
        ifMatch: '"v2"',
        body: { streams: { ...others, 'files/docs': bookmark(['a.md', 'b.md', 'c.md']) } },
      },
    ]);
  });

  it.each([
    ['changed', { 'files/docs': bookmark([]) }, { 'files/docs': bookmark(['b.md']) }],
    ['created', {}, { 'files/docs': bookmark(['b.md']) }],
    ['removed', { 'files/docs': bookmark([]) }, {}],
  ])('is refused when another run %s a stream of this run', async (_label, before, after) => {
    const state = service({ streams: before });
    await stage(state);
    state.change({ streams: { ...after, 'files/other': bookmark(['o.csv']) } });
    await expect(commitStagedState(state.store(), stagedPath)).rejects.toThrow(
      /^The saved state of "files\/docs" changed while this run was embedding and loading/
    );
    expect(state.puts).toEqual([]);
  });

  it('is compared with what was loaded, also when a bookmark is changed in place', async () => {
    const state = service({ streams: { 'files/docs': bookmark([]) } });
    const store = state.store();
    const loaded = await store.load();
    const staged = new StagedStateStore(store, loaded, stagedPath);
    loaded.streams['files/docs']!.record_count = 7;
    loaded.streams['files/docs'] = bookmark(['a.md']);
    await staged.save(loaded);
    await commitStagedState(state.store(), stagedPath);
    expect(state.puts).toHaveLength(1);
  });

  it('is refused by the service when the state changes during the commit', async () => {
    const state = service({ streams: {} });
    await stage(state);
    const store = state.store();
    const load = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation(async () => {
      const loaded = await load();
      state.change({ streams: { 'files/docs': bookmark(['b.md']) } });
      return loaded;
    });
    await expect(commitStagedState(store, stagedPath)).rejects.toThrow(/save returned 412/);
    expect(state.puts).toEqual([]);
  });
});

describe('the folder of staged state', () => {
  const folder = (): string => path.join(root, 'folder');
  const resolveIn = (name: string): string =>
    resolveStagedStatePath('/', path.join(name, 'state.json'));
  const uid = process.getuid?.() ?? 0;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(process.getuid)('may be anywhere, if only this user can open it', () => {
    fs.mkdirSync(folder(), { mode: 0o700 });
    // Neither the temp folder nor the project of the process.
    vi.stubEnv('TMPDIR', '/usr');
    expect(resolveIn(folder())).toBe(path.join(folder(), 'state.json'));
    expect(resolveStagedStatePath(root, 'folder/state.json')).toBe(
      path.join(folder(), 'state.json')
    );
  });

  it.runIf(process.getuid).each([0o750, 0o705, 0o701, 0o777])(
    'may not be open to others: %o',
    (mode) => {
      fs.mkdirSync(folder());
      fs.chmodSync(folder(), mode);
      expect(() => resolveIn(folder())).toThrow(/not private to this user/);
    }
  );

  it.runIf(process.getuid)('may not belong to another user', () => {
    fs.mkdirSync(folder(), { mode: 0o700 });
    vi.spyOn(process as Required<NodeJS.Process>, 'getuid').mockReturnValue(uid + 1);
    expect(() => resolveIn(folder())).toThrow(/not private to this user/);
  });

  it('may not be a link, a file or missing', () => {
    fs.mkdirSync(folder(), { mode: 0o700 });
    fs.symlinkSync(folder(), path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'file'), '', { mode: 0o600 });
    expect(() => resolveIn(path.join(root, 'link'))).toThrow(/not private to this user/);
    expect(() => resolveIn(path.join(root, 'file'))).toThrow(/not private to this user/);
    expect(() => resolveIn(path.join(root, 'missing'))).toThrow(/does not exist/);
  });

  it('must be in the temp folder or the project where users cannot be compared', () => {
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      fs.mkdirSync(folder());
      expect(resolveIn(folder())).toBe(path.join(folder(), 'state.json'));
      vi.stubEnv('TMPDIR', '/usr');
      vi.stubEnv('TEMP', '/usr');
      vi.stubEnv('TMP', '/usr');
      expect(resolveStagedStatePath(root, 'folder/state.json')).toBe(
        path.join(folder(), 'state.json')
      );
      expect(() => resolveStagedStatePath('/usr', path.join(folder(), 'state.json'))).toThrow(
        /not private to this user/
      );
    } finally {
      if (getuid) Object.defineProperty(process, 'getuid', getuid);
    }
  });
});

describe('extract run --staged-state', () => {
  const originalCwd = process.cwd();
  const statePath = (): string => path.join(root, '.dogsled', 'state', 'state.json');

  async function run(register: (program: Command) => void, args: string[]): Promise<void> {
    const program = new Command().exitOverride();
    register(program);
    await program.parseAsync(args, { from: 'user' });
  }

  function write(file: string, body: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }

  beforeEach(() => {
    process.chdir(root);
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    write('data/docs/a.md', 'Feed the dogs at dusk.\n');
    write(
      'integrations/files.yml',
      `spec_version: '1'
type: integration
name: files
source_type: local
connection: { base_directory: data }
auth: { type: none }
`
    );
    write(
      'resources/files/docs.yml',
      `spec_version: '1'
type: resource
name: docs
integration: files
source: { path: 'docs/*.md', format: document }
replication:
  method: incremental_append
  cursor: { field: etag }
output:
  document_id: { type: string }
`
    );
    write('extractor.yml', 'state_dir: .dogsled/state\n');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  const extract = (...args: string[]): Promise<void> =>
    run(registerExtractCommand, ['run', 'docs', '--integration', 'files', ...args]);
  const commit = (...args: string[]): Promise<void> =>
    run(registerCommitStateCommand, ['commit-state', '--integration', 'files', ...args]);

  it('keeps the whole bookmark back until commit-state saves it', async () => {
    await extract('--advance-state', '--staged-state', stagedPath);
    expect(fs.existsSync(statePath())).toBe(false);

    await commit('--staged-state', stagedPath);
    expect(process.exitCode).toBe(0);
    const { streams } = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ExtractorState;
    expect(Object.keys(streams['files/docs']!.files!)).toEqual([
      expect.stringContaining('docs/a.md'),
    ]);
  });

  it('writes no file for a limited run', async () => {
    await extract('--advance-state', '--limit', '1', '--staged-state', stagedPath);
    expect(fs.existsSync(stagedPath)).toBe(false);
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('is for one integration', async () => {
    await expect(
      run(registerExtractCommand, ['run', '--advance-state', '--staged-state', stagedPath])
    ).rejects.toThrow('--staged-state needs --integration.');
  });

  it('leaves other sources as they are', async () => {
    write(
      'integrations/files.yml',
      `spec_version: '2'
type: source
name: files
transports:
  - { id: api, type: http, base_url: 'https://api.example.com', auth: { type: none } }
`
    );
    write(
      'resources/files/docs.yml',
      `spec_version: '1'
type: resource
name: docs
integration: files
description: Example records.
input: {}
api: { method: GET, endpoint: /docs }
extract:
  record_path: $.docs
  incremental: { cursor_field: updated_at, cursor_param: since }
output:
  id: { type: integer, path: $.id }
  updated_at: { type: timestamp, path: $.updated_at }
`
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ docs: [{ id: 1, updated_at: '2026-01-01T00:00:00Z' }] })
    );
    await extract('--advance-state', '--staged-state', path.join(root, 'missing', 'state.json'));
    const { streams } = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ExtractorState;
    expect(streams['files/docs']).toMatchObject({ cursor_value: '2026-01-01T00:00:00Z' });
  });

  it('leaves a warehouse as it is', async () => {
    write(
      'integrations/files.yml',
      `spec_version: '1'
type: integration
name: files
source_type: postgres
auth_env_vars: [EXAMPLE_DB_HOST, EXAMPLE_DB_USER, EXAMPLE_DB_PASSWORD]
connection: { host_env: EXAMPLE_DB_HOST, port: 5432, database: kennel, schema: public }
auth: { type: password, username_env: EXAMPLE_DB_USER, password_env: EXAMPLE_DB_PASSWORD }
`
    );
    write(
      'resources/files/docs.yml',
      `spec_version: '1'
type: resource
name: docs
integration: files
source: { table: docs, database: kennel, schema: public }
replication: { method: incremental_append, cursor_field: updated_at }
output:
  id: { type: integer }
  updated_at: { type: timestamp }
`
    );
    vi.stubEnv('EXAMPLE_DB_HOST', 'db.example.com');
    vi.stubEnv('EXAMPLE_DB_USER', 'example');
    vi.stubEnv('EXAMPLE_DB_PASSWORD', 'synthetic-password');
    vi.mocked(createWarehouseClient).mockResolvedValue(warehouseClient());
    await extract('--advance-state', '--staged-state', path.join(root, 'missing', 'state.json'));
    const { streams } = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ExtractorState;
    expect(streams['files/docs']).toMatchObject({ cursor_value: '2026-01-01T00:00:00.000Z' });
  });

  it('refuses a folder that is open to others before it reads a file', async () => {
    fs.mkdirSync(path.join(root, 'open'));
    fs.chmodSync(path.join(root, 'open'), 0o755);
    await expect(
      extract('--advance-state', '--staged-state', path.join(root, 'open', 'state.json'))
    ).rejects.toThrow(/not private to this user/);
    expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('needs one of the two sources of state to commit', async () => {
    await expect(commit()).rejects.toThrow('Missing --capture-file <path>.');
  });
});
