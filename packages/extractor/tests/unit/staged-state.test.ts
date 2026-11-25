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

import type { ExtractorState } from '../../src/types/index.js';

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
    const staged = new StagedStateStore(backend, stagedPath);
    const state = await staged.load();
    expect(state).toEqual({ streams: { 'files/docs': bookmark(['a.md']) } });

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

  it('keeps what another run saved in the meantime', async () => {
    const backend = new FileStateStore(path.join(root, 'state'));
    await backend.save({ streams: { 'files/docs': bookmark([]), 'files/old': bookmark([]) } });
    const staged = new StagedStateStore(backend, stagedPath);
    const state = await staged.load();
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
    const staged = new StagedStateStore(state.store(), stagedPath);
    const loaded = await staged.load();
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

  it('is refused when another run changed the state after this one loaded it', async () => {
    const state = service({ streams: {} });
    await stage(state);
    state.change({ streams: { 'files/docs': bookmark(['b.md']) } });
    await expect(commitStagedState(state.store(), stagedPath)).rejects.toThrow(
      /saved state changed while this run was embedding and loading/
    );
    expect(state.puts).toEqual([]);
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

describe('the file for staged state', () => {
  it('may be in the temp folder or the project', () => {
    expect(resolveStagedStatePath('/', path.join(root, 'state.json'))).toBe(
      path.join(root, 'state.json')
    );
    fs.mkdirSync(path.join(root, 'inner'));
    expect(resolveStagedStatePath(root, 'inner/state.json')).toBe(
      path.join(root, 'inner/state.json')
    );
  });

  it.each(['/etc/state.json', '/state.json'])('may not be elsewhere: %s', (file) => {
    expect(() => resolveStagedStatePath(root, file)).toThrow(/within temp directory or project/);
  });

  it('may not be behind a link that leaves them, or in a folder that does not exist', () => {
    fs.symlinkSync('/etc', path.join(root, 'link'));
    expect(() => resolveStagedStatePath(root, 'link/state.json')).toThrow(
      /within temp directory or project/
    );
    expect(() => resolveStagedStatePath(root, 'missing/state.json')).toThrow(/does not exist/);
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
    await extract('--advance-state', '--staged-state', stagedPath);
    expect(fs.existsSync(stagedPath)).toBe(false);
    const { streams } = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ExtractorState;
    expect(streams['files/docs']).toMatchObject({ cursor_value: '2026-01-01T00:00:00Z' });
  });

  it('needs one of the two sources of state to commit', async () => {
    await expect(commit()).rejects.toThrow('Missing --capture-file <path>.');
  });
});
