import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_EMBEDDING_TOKEN_ENV,
  HOST_EMBEDDING_URL_ENV,
  runProjectPipeline,
  type PipelineExecutionState,
  type RunProjectPipelineOptions,
} from '../../../src/pipeline/index.js';
import { createThrowawayCertificate } from '../../helpers/throwaway-certificate.js';
import { queryPersistentDb } from '../../integration/helpers/duckdb.js';

const MODEL = { provider: 'acme', id: 'acme-embed-1', dimensions: 2 };
const EMPTY: PipelineExecutionState = { streams: {} };

type Stage = 'extract' | 'embed' | 'load' | 'commit-state';

let server: Server;
let origin: string;
let caCertPath: string;
const tempDirs: string[] = [];

/** Texts the embedding endpoint got, and what it does before it answers. A number is its status. */
let texts: string[];
let beforeAnswer: () => Promise<number | void>;
/** A state service that honors If-Match. */
let service: { state: PipelineExecutionState; revision: number; puts: Array<string | undefined> };

function makeTempDir(prefix: string, parent = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  tempDirs.push(dir);
  return dir;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

async function answerEmbedding(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { inputs } = await readJson<{ inputs: Array<{ id: string; text: string }> }>(request);
  texts.push(...inputs.map(({ text }) => text));
  const status = inputs.length > 0 ? await beforeAnswer() : undefined;
  if (typeof status === 'number') response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  const results = inputs.map(({ id, text }) => ({ id, embedding: [text.length, 1] }));
  response.end(JSON.stringify({ model: MODEL, results }));
}

async function answerState(request: IncomingMessage, response: ServerResponse): Promise<void> {
  expect(request.headers.authorization).toBe('Bearer synthetic-state-token');
  if (request.method === 'PUT') {
    const state = await readJson<PipelineExecutionState>(request);
    service.puts.push(request.headers['if-match']);
    if (request.headers['if-match'] !== `"v${service.revision}"`) {
      response.writeHead(412).end();
      return;
    }
    service.state = state;
    service.revision += 1;
  }
  response.setHeader('etag', `"v${service.revision}"`);
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(service.state));
}

beforeAll(async () => {
  const { cert, key } = createThrowawayCertificate();
  caCertPath = path.join(makeTempDir('dogsled-state-ca-'), 'ca.pem');
  fs.writeFileSync(caCertPath, cert);
  server = createServer({ cert, key }, (request, response) => {
    if (request.url?.startsWith('/api/notes')) {
      response.setHeader('content-type', 'application/json');
      response.end('{"notes":[{"id":1,"body":"Rest.","updated_at":"2026-01-01T00:00:00Z"}]}');
      return;
    }
    void (request.url === '/state' ? answerState : answerEmbedding)(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  texts = [];
  beforeAnswer = async () => {};
  service = { state: EMPTY, revision: 1, puts: [] };
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeProject(embed = true): string {
  const root = makeTempDir('dogsled-embed-state-');
  const write = (file: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  write('data/docs/feeding.md', 'Feed the dogs at dawn.\n');
  write('data/docs/harness.md', 'Check every buckle.\n');
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
  write(
    'dogsled.yml',
    `destinations:
  local: { type: duckdb, db_path: ./kennel.duckdb }
pipelines:
  kennel:
    schedule: manual
    source: files
    destination: local
    table_prefix: ''
    resources: [docs]
${embed ? '    embed: { provider: host, streams: { docs: [{ field: text }] } }\n' : ''}`
  );
  return root;
}

/** The same project, but its pipeline reads an API and embeds a field of its records. */
function makeApiProject(): string {
  const root = makeProject();
  fs.rmSync(path.join(root, 'resources/files'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'integrations/files.yml'),
    `spec_version: '2'
type: source
name: files
transports:
  - { id: api, type: http, base_url: '${origin}/api', auth: { type: none } }
`
  );
  fs.mkdirSync(path.join(root, 'resources/files'));
  fs.writeFileSync(
    path.join(root, 'resources/files/docs.yml'),
    `spec_version: '1'
type: resource
name: docs
integration: files
description: Example notes.
input: {}
api: { method: GET, endpoint: /notes }
extract:
  record_path: $.notes
  incremental: { cursor_field: updated_at, cursor_param: since }
output:
  id: { type: integer, path: $.id }
  body: { type: string, path: $.body }
  updated_at: { type: timestamp, path: $.updated_at }
`
  );
  const config = path.join(root, 'dogsled.yml');
  fs.writeFileSync(
    config,
    fs.readFileSync(config, 'utf8').replace('{ field: text }', '{ field: body }')
  );
  return root;
}

/** The same project, but its pipeline reads a database that does not answer. */
function makeWarehouseProject(): string {
  const root = makeProject();
  fs.writeFileSync(
    path.join(root, 'integrations/files.yml'),
    `spec_version: '1'
type: integration
name: files
source_type: postgres
auth_env_vars: [EXAMPLE_DB_HOST, EXAMPLE_DB_USER, EXAMPLE_DB_PASSWORD]
connection: { host_env: EXAMPLE_DB_HOST, port: 1, database: kennel, schema: public }
auth: { type: password, username_env: EXAMPLE_DB_USER, password_env: EXAMPLE_DB_PASSWORD }
`
  );
  fs.writeFileSync(
    path.join(root, 'resources/files/docs.yml'),
    `spec_version: '1'
type: resource
name: docs
integration: files
source: { table: docs, database: kennel, schema: public }
replication: { method: incremental_append, cursor_field: updated_at }
output:
  text: { type: string }
  updated_at: { type: timestamp }
`
  );
  return root;
}

function stageOf(args: readonly string[]): Stage {
  if (args.includes('commit-state')) return 'commit-state';
  if (args.includes('--integration')) return 'extract';
  return args.includes('--dest') ? 'load' : 'embed';
}

interface RunOptions extends Partial<RunProjectPipelineOptions> {
  /** A script that takes the loader's place. */
  loader?: string;
}

/** Run the real stages. `extracted` resolves when the extractor has exited. */
function start(projectRoot: string, { loader, env, ...options }: RunOptions = {}) {
  const children: Array<{ stage: Stage; args: readonly string[] }> = [];
  let onExtracted = (): void => {};
  const extracted = new Promise<void>((resolve) => (onExtracted = resolve));
  const spawn = (command: string, args: readonly string[], spawned: SpawnOptions): ChildProcess => {
    const stage = stageOf(args);
    children.push({ stage, args });
    const child =
      stage === 'load' && loader !== undefined
        ? spawnChild(process.execPath, ['-e', loader], spawned)
        : spawnChild(command, args, spawned);
    if (stage === 'extract') child.once('close', onExtracted);
    return child;
  };
  const result = runProjectPipeline(
    {
      projectRoot,
      pipelineName: 'kennel',
      ...options,
      env: {
        [HOST_EMBEDDING_URL_ENV]: `${origin}/embed`,
        [HOST_EMBEDDING_TOKEN_ENV]: 'synthetic-host-token',
        NODE_EXTRA_CA_CERTS: caCertPath,
        ...env,
      },
    },
    { spawn }
  );
  return { result, children, extracted };
}

/** The part of a result that a host stores or shows. Compare it whole: an empty state is a subset of any. */
async function outcome(result: ReturnType<typeof start>['result']) {
  const { status, exitCode, state } = await result;
  return { status, exitCode, state };
}

const stages = (children: Array<{ stage: Stage }>): Stage[] => children.map(({ stage }) => stage);

function filesOf(state: PipelineExecutionState | undefined): string[] {
  const stream = state?.streams['files/docs'] as { files?: Record<string, unknown> } | undefined;
  return Object.keys(stream?.files ?? {})
    .map((uri) => path.basename(uri))
    .sort();
}

async function vectors(root: string): Promise<number> {
  const rows = await queryPersistentDb(
    path.join(root, 'kennel.duckdb'),
    'SELECT count(text_embedding)::INTEGER AS n FROM docs__chunks'
  );
  return Number(rows[0]!['n']);
}

const ALL_FILES = ['feeding.md', 'harness.md'];
const ALL_TEXTS = ['Check every buckle.', 'Feed the dogs at dawn.'];

describe('the state of documents that a run embeds', () => {
  it('stays when the embed stage fails after extraction, and the retry embeds the same files', async () => {
    const root = makeProject();
    const failed = start(root, { state: EMPTY });
    beforeAnswer = async () => {
      await failed.extracted;
      return 400;
    };
    expect(await outcome(failed.result)).toEqual({ status: 'failure', exitCode: 1, state: EMPTY });
    expect(stages(failed.children)).toEqual(['extract', 'embed', 'load']);

    texts = [];
    beforeAnswer = async () => {};
    const retry = await start(root, { state: EMPTY }).result;
    expect(retry).toMatchObject({ status: 'success', exitCode: 0 });
    expect(texts.sort()).toEqual(ALL_TEXTS);
    expect(filesOf(retry.state)).toEqual(ALL_FILES);
    expect(await vectors(root)).toBe(2);

    texts = [];
    const next = await start(root, { state: retry.state! }).result;
    expect(next.status).toBe('success');
    expect(texts).toEqual([]);
    expect(filesOf(next.state)).toEqual(ALL_FILES);
    expect(await vectors(root)).toBe(2);
  }, 240_000);

  it('stays when the load fails after the stages before it ended well', async () => {
    const { result, children } = start(makeProject(), {
      state: EMPTY,
      loader: "process.stdin.resume().on('end', () => process.exit(3))",
    });
    expect(await outcome(result)).toEqual({ status: 'failure', exitCode: 3, state: EMPTY });
    expect(texts.sort()).toEqual(ALL_TEXTS);
    expect(stages(children)).toEqual(['extract', 'embed', 'load']);
  }, 120_000);

  it('is saved whole, in the project, after every stage ended well', async () => {
    const root = makeProject();
    const statePath = path.join(root, '.extractor', 'state.json');
    const { result, children, extracted } = start(root);
    const savedBeforeAnswer: boolean[] = [];
    beforeAnswer = async () => {
      await extracted;
      savedBeforeAnswer.push(fs.existsSync(statePath));
    };
    expect(await result).toMatchObject({ status: 'success', exitCode: 0 });
    expect(new Set(savedBeforeAnswer)).toEqual(new Set([false]));
    expect(stages(children)).toEqual(['extract', 'embed', 'load', 'commit-state']);
    expect(filesOf(JSON.parse(fs.readFileSync(statePath, 'utf8')))).toEqual(ALL_FILES);

    const { args } = children.find(({ stage }) => stage === 'commit-state')!;
    const stagedPath = args[args.indexOf('--staged-state') + 1]!;
    expect(children[0]!.args).toContain(stagedPath);
    expect(fs.existsSync(path.dirname(stagedPath))).toBe(false);
  }, 120_000);

  it('is saved by the extractor, as before, in a run that embeds nothing', async () => {
    const { result, children } = start(makeProject(false), { state: EMPTY });
    const { status, state } = await result;
    expect(status).toBe('success');
    expect(filesOf(state)).toEqual(ALL_FILES);
    expect(stages(children)).toEqual(['extract', 'load']);
    expect(children[0]!.args).toContain('--advance-state');
    expect(children[0]!.args).not.toContain('--staged-state');
  }, 120_000);

  it('stays when the run is cancelled while it embeds', async () => {
    const controller = new AbortController();
    const { result, children, extracted } = start(makeProject(), {
      state: EMPTY,
      signal: controller.signal,
    });
    beforeAnswer = async () => {
      await extracted;
      controller.abort();
    };
    const { status, state } = await result;
    expect({ status, state }).toEqual({ status: 'cancelled', state: EMPTY });
    expect(stages(children)).not.toContain('commit-state');
  }, 120_000);

  it('stays when the run is cancelled after the load', async () => {
    const controller = new AbortController();
    const { result, children } = start(makeProject(), {
      state: EMPTY,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'stage_completed' && event.stage === 'load') controller.abort();
      },
    });
    const { status, state } = await result;
    expect({ status, state }).toEqual({ status: 'cancelled', state: EMPTY });
    expect(stages(children)).toEqual(['extract', 'embed', 'load']);
  }, 120_000);

  it('has no file to save after a limited run', async () => {
    const { result, children } = start(makeProject(), { state: EMPTY, maxRecords: 1 });
    expect(await outcome(result)).toEqual({ status: 'success', exitCode: 0, state: EMPTY });
    expect(stages(children)).toEqual(['extract', 'embed', 'load']);
  }, 120_000);

  describe('in a run with a temp folder of its own', () => {
    const tempFolders: Array<[string, (root: string) => string]> = [
      ['outside the temp folder', () => makeTempDir('.dogsled-own-temp-', process.cwd())],
      ['inside the project', (root) => makeTempDir('own-temp-', root)],
    ];

    it.each(tempFolders)(
      'is saved when that folder is %s',
      async (_label, makeFolder) => {
        const root = makeProject();
        const { result, children } = start(root, {
          state: EMPTY,
          env: { TMPDIR: makeFolder(root) },
        });
        const { status, state } = await result;
        expect(status).toBe('success');
        expect(stages(children)).toEqual(['extract', 'embed', 'load', 'commit-state']);
        expect(filesOf(state)).toEqual(ALL_FILES);
      },
      120_000
    );

    it.each(tempFolders)(
      'is saved by the extractor, as before, for an API when that folder is %s',
      async (_label, makeFolder) => {
        const root = makeApiProject();
        const { result, children } = start(root, {
          state: EMPTY,
          env: { TMPDIR: makeFolder(root), DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1' },
        });
        const { status, state } = await result;
        expect(status).toBe('success');
        expect(stages(children)).toEqual(['extract', 'embed', 'load']);
        expect(texts).toEqual(['Rest.']);
        expect(state?.streams['files/docs']).toMatchObject({
          cursor_value: '2026-01-01T00:00:00Z',
        });
      },
      120_000
    );

    it.each(tempFolders)(
      'lets a warehouse run reach its source, as before, when that folder is %s',
      async (_label, makeFolder) => {
        const root = makeWarehouseProject();
        const { result, children } = start(root, {
          state: EMPTY,
          env: {
            TMPDIR: makeFolder(root),
            DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
            EXAMPLE_DB_HOST: '127.0.0.1',
            EXAMPLE_DB_USER: 'example',
            EXAMPLE_DB_PASSWORD: 'synthetic-password',
          },
        });
        expect((await result).status).toBe('failure');
        expect(stages(children)).toEqual(['extract', 'embed', 'load']);
        const logs = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk));
        expect(logs.join('')).toContain('ECONNREFUSED');
        expect(logs.join('')).not.toContain('staged state');
      },
      120_000
    );
  });

  describe('in an https state backend', () => {
    const backend = (): NodeJS.ProcessEnv => ({
      DOGSLED_STATE_BACKEND: `${origin}/state`,
      DOGSLED_STATE_AUTH_ENV: 'EXAMPLE_STATE_TOKEN',
      EXAMPLE_STATE_TOKEN: 'synthetic-state-token',
      DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
    });

    it('is put once, with the version the run started from, only after success', async () => {
      const root = makeProject();
      const failed = start(root, { env: backend() });
      beforeAnswer = async () => {
        await failed.extracted;
        return 400;
      };
      expect((await failed.result).status).toBe('failure');
      expect(service).toEqual({ state: EMPTY, revision: 1, puts: [] });

      beforeAnswer = async () => {};
      expect((await start(root, { env: backend() }).result).status).toBe('success');
      expect(service.puts).toEqual(['"v1"']);
      expect(filesOf(service.state)).toEqual(ALL_FILES);
    }, 240_000);

    const OTHER = { last_run_at: '2026-01-01T00:00:00.000Z', record_count: 1 };

    it('is merged when another run saved another stream', async () => {
      const { result, extracted } = start(makeProject(), { env: backend() });
      beforeAnswer = async () => {
        await extracted;
        service.state = { streams: { 'api/notes': OTHER } };
        service.revision = 7;
      };
      expect((await result).status).toBe('success');
      expect(service.puts).toEqual(['"v7"']);
      expect(filesOf(service.state)).toEqual(ALL_FILES);
      expect(service.state.streams['api/notes']).toEqual(OTHER);
    }, 120_000);

    it('is refused when another run saved the same stream, and the run fails', async () => {
      const saved = { streams: { 'files/docs': OTHER } };
      const { result, children, extracted } = start(makeProject(), { env: backend() });
      beforeAnswer = async () => {
        await extracted;
        service.state = saved;
        service.revision = 7;
      };
      expect((await result).status).toBe('failure');
      expect(stages(children)).toEqual(['extract', 'embed', 'load', 'commit-state']);
      expect(service.state).toEqual(saved);
      expect(service.puts).toEqual([]);
      const logs = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk));
      expect(logs.join('')).toContain('saved state of \\"files/docs\\" changed while this run');
      expect(logs.join('')).not.toContain('synthetic-state-token');
    }, 120_000);
  });
});
