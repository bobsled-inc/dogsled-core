import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_EMBEDDING_TOKEN_ENV,
  HOST_EMBEDDING_URL_ENV,
  runProjectPipeline,
} from '../../../src/pipeline/index.js';
import { createThrowawayCertificate } from '../../helpers/throwaway-certificate.js';
import { queryPersistentDb } from '../../integration/helpers/duckdb.js';

const TOKEN = 'synthetic-host-token';
const MODEL = { provider: 'acme', id: 'acme-embed-1', dimensions: 4 };

interface HostRequest {
  headers: IncomingHttpHeaders;
  inputs: Array<{ id: string; text: string }>;
}

let server: Server;
let hostUrl: string;
let caCertPath: string;
const requests: HostRequest[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readJson(request: IncomingMessage): Promise<{ inputs: HostRequest['inputs'] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A host application's embedding endpoint, over https. */
beforeAll(async () => {
  const { cert, key } = createThrowawayCertificate();
  caCertPath = path.join(makeTempDir('dogsled-host-ca-'), 'ca.pem');
  fs.writeFileSync(caCertPath, cert);
  server = createServer({ cert, key }, (request, response) => {
    void readJson(request).then(({ inputs }) => {
      requests.push({ headers: request.headers, inputs });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          model: MODEL,
          limits: { maxInputs: 2, maxInputCharacters: 5_000 },
          results: inputs.map(({ id, text }) =>
            text.includes('unreadable')
              ? { id, error: 'unsupported_text' }
              : { id, embedding: [text.length, 0.5, -1, 0] }
          ),
          usage: { tokens: inputs.length },
        })
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  hostUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/embed`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeProject(embed: string): { root: string; dbPath: string } {
  const root = makeTempDir('dogsled-host-documents-');
  const write = (file: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  write('data/docs/feeding.md', '# Feeding\n\nFeed the dogs at dawn.\n');
  write('data/docs/harness.md', '# Harness\n\nCheck every buckle before a run.\n');
  write('data/docs/trail.md', '# Trail\n\nThis unreadable page has no route.\n');
  write(
    'integrations/files.yml',
    `spec_version: '1'
type: integration
name: files
source_type: local
connection:
  base_directory: data
auth:
  type: none
`
  );
  write(
    'resources/files/docs.yml',
    `spec_version: '1'
type: resource
name: docs
integration: files
source:
  path: docs/*.md
  format: document
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
  local:
    type: duckdb
    db_path: ./kennel.duckdb
pipelines:
  kennel:
    schedule: manual
    source: files
    destination: local
    table_prefix: kb__
    resources: [docs]
    embed:
${embed}`
  );
  return { root, dbPath: path.join(root, 'kennel.duckdb') };
}

const EMBED = `      provider: host
      dimension: 4
      streams:
        docs: [{ field: text }]
`;

/** Run the real extractor, embedder and loader, and keep what they were given and wrote. */
async function run(projectRoot: string) {
  const children: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv; stderr: string }> = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = spawnChild(command, args, options);
    const entry = { args, env: { ...options.env }, stderr: '' };
    children.push(entry);
    child.stderr?.on('data', (chunk: Buffer) => (entry.stderr += chunk.toString()));
    return child;
  };
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const result = await runProjectPipeline(
    {
      projectRoot,
      pipelineName: 'kennel',
      env: {
        [HOST_EMBEDDING_URL_ENV]: hostUrl,
        [HOST_EMBEDDING_TOKEN_ENV]: TOKEN,
        NODE_EXTRA_CA_CERTS: caCertPath,
      },
    },
    { spawn }
  );
  const logs = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
  stderr.mockRestore();
  return { result, children, logs };
}

async function chunks(dbPath: string) {
  const rows = await queryPersistentDb(
    dbPath,
    'SELECT text, text_embedding FROM main.kb__docs__chunks ORDER BY text'
  );
  return rows.map((row) => ({
    text: String(row['text']).split('\n').at(-1),
    length: String(row['text']).length,
    vector: row['text_embedding'],
  }));
}

/** Every file a run left in the project, such as its saved state. */
function projectFiles(root: string): string {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'latin1'))
    .join('\n');
}

describe('a document Resource embedded by a host-supplied model', () => {
  it('loads its chunks with vectors, and replaces them when a file changes', async () => {
    const { root, dbPath } = makeProject(EMBED);
    const first = await run(root);
    expect(first.result.errors).toEqual([]);
    expect(first.result).toMatchObject({ exitCode: 0, status: 'success' });

    // The host was asked for its model before it was sent any text.
    expect(requests[0]!.inputs).toEqual([]);
    expect(requests.slice(1).flatMap(({ inputs }) => inputs)).toHaveLength(3);
    for (const { headers } of requests) {
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    }

    const loaded = await chunks(dbPath);
    expect(loaded.map(({ text }) => text)).toEqual([
      'Feed the dogs at dawn.',
      'Check every buckle before a run.',
      'This unreadable page has no route.',
    ]);
    expect(loaded.map(({ length, vector }) => [length, vector])).toEqual([
      [loaded[0]!.length, [loaded[0]!.length, 0.5, -1, 0]],
      [loaded[1]!.length, [loaded[1]!.length, 0.5, -1, 0]],
      [loaded[2]!.length, null],
    ]);

    // Only the chunk table has a vector column.
    const columns = await queryPersistentDb(
      dbPath,
      `SELECT table_name, data_type FROM information_schema.columns
       WHERE column_name = 'text_embedding'`
    );
    expect(columns).toEqual([{ table_name: 'kb__docs__chunks', data_type: 'FLOAT[]' }]);

    // What the embedder wrote about the run.
    const embed = first.children.find(({ args }) => args.includes('--config'))!;
    expect(embed.stderr).toContain('unsupported_text: 1');
    expect(embed.stderr).toContain('"embedding_inputs_rejected":1');

    // Only the embedder had the endpoint and token, and nothing repeated the token.
    expect(first.children).toHaveLength(4);
    expect(first.children[3]!.args).toContain('commit-state');
    for (const child of first.children) {
      const hasToken = child === embed;
      expect(child.env[HOST_EMBEDDING_URL_ENV]).toBe(hasToken ? hostUrl : undefined);
      expect(child.env[HOST_EMBEDDING_TOKEN_ENV]).toBe(hasToken ? TOKEN : undefined);
      expect(child.stderr + child.args.join(' ')).not.toContain(TOKEN);
    }
    expect(first.logs + JSON.stringify(first.result) + projectFiles(root)).not.toContain(TOKEN);
    expect(first.logs).not.toContain('Feed the dogs');

    requests.length = 0;
    fs.writeFileSync(path.join(root, 'data/docs/feeding.md'), 'Feed the dogs at dusk instead.\n');
    const second = await run(root);
    expect(second.result).toMatchObject({ exitCode: 0, status: 'success' });
    expect(requests.map(({ inputs }) => inputs.length)).toEqual([0, 1]);
    const replaced = await chunks(dbPath);
    expect(replaced).toEqual([
      { text: 'Feed the dogs at dusk instead.', length: 30, vector: [30, 0.5, -1, 0] },
      loaded[1],
      loaded[2],
    ]);
  }, 120_000);

  it('writes nothing when the dimension does not match', async () => {
    const { root, dbPath } = makeProject(EMBED.replace('dimension: 4', 'dimension: 8'));
    const { result, children } = await run(root);
    expect(result.status).toBe('failure');
    expect(requests.map(({ inputs }) => inputs)).toEqual([[]]);
    const embed = children.find(({ args }) => args.includes('--config'))!;
    expect(embed.stderr).toContain("sets dimension 8, but the host's embedding model has 4");
    if (fs.existsSync(dbPath)) {
      const tables = await queryPersistentDb(dbPath, 'SELECT table_name FROM duckdb_tables()');
      expect(tables).toEqual([]);
    }
  }, 120_000);

  it('checks the certificate', async () => {
    const trusted = caCertPath;
    caCertPath = path.join(makeTempDir('dogsled-other-ca-'), 'ca.pem');
    fs.writeFileSync(caCertPath, createThrowawayCertificate().cert);
    try {
      const { root } = makeProject(EMBED);
      const { result, children } = await run(root);
      expect(result.status).toBe('failure');
      expect(requests).toEqual([]);
      const embed = children.find(({ args }) => args.includes('--config'))!;
      expect(embed.stderr).toContain('failed with a network error');
      expect(embed.stderr).not.toContain(TOKEN);
    } finally {
      caCertPath = trusted;
    }
  }, 120_000);
});
