import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PIPELINE_SUMMARY_VERSION,
  PROTOCOL_VERSION,
  parseStderrMessage,
  parseStdoutMessage,
} from '@bobsled-inc/protocol';
import { queryPersistentDb } from './helpers/duckdb.js';
import { makeProvider, makeResource } from './helpers/fixtures.js';
import { FAKE_SERVER_CERT, createFakeHttpsServer, type FakeServer } from './helpers/fake-server.js';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx/esm');
const cliEntry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe('pipeline smoke', () => {
  let server: FakeServer | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }

    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the delegated extract+load pipeline and emits a versioned summary', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/items',
        handler: () => ({ body: [{ id: 1, name: 'alpha' }] }),
      },
    ]);

    const project = makeProject(server.url);
    const outputDir = path.join(project.projectDir, 'pipeline-output');

    const result = await runCli(
      [
        'pipeline',
        '--integration',
        'test_api',
        '--resource',
        'test_items',
        '--dest',
        'local',
        '--format',
        'jsonl',
        '--output-dir',
        outputDir,
      ],
      project.projectDir,
      {
        BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
        NODE_EXTRA_CA_CERTS: project.caCertPath,
      }
    );

    expect(result.exitCode).toBe(0);
    const stdoutMessages = parseJsonLines(result.stdout);
    expect(stdoutMessages.length).toBeGreaterThan(0);
    expect(
      stdoutMessages.every((message) => {
        const parsed = parseStdoutMessage(message);
        return parsed !== null && parsed._v === PROTOCOL_VERSION;
      })
    ).toBe(true);
    expect(stdoutMessages).toContainEqual(
      expect.objectContaining({
        _v: PROTOCOL_VERSION,
        type: 'STATE',
        stream: 'test_items',
        value: expect.objectContaining({
          record_count: 1,
        }),
      })
    );

    const stderrMessages = parseJsonLines(result.stderr);
    expect(stderrMessages.length).toBeGreaterThan(0);
    expect(
      stderrMessages.every((message) => {
        if (message.type === 'PIPELINE_SUMMARY') {
          return message._v === PIPELINE_SUMMARY_VERSION;
        }

        try {
          return parseStderrMessage(message) !== null && message._v === PROTOCOL_VERSION;
        } catch {
          return isLoaderJsonLine(message);
        }
      })
    ).toBe(true);

    expect(stderrMessages).toContainEqual(
      expect.objectContaining({
        _v: PIPELINE_SUMMARY_VERSION,
        type: 'PIPELINE_SUMMARY',
        integration: 'test_api',
        total_streams: 1,
        succeeded: 1,
        failed: 0,
        total_records_extracted: 1,
        total_rows_loaded: 0,
        streams: {
          test_items: expect.objectContaining({
            status: 'success',
            records_extracted: 1,
            rows_loaded: 0,
          }),
        },
      })
    );

    const outputFiles = fs
      .readdirSync(outputDir, { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.jsonl'));
    expect(outputFiles.length).toBeGreaterThan(0);
  });

  it('runs the delegated extract+embed+load pipeline and persists vector columns to DuckDB', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/items',
        handler: () => ({
          body: [
            { id: 1, body: 'alpha note' },
            { id: 2, body: 'beta note' },
          ],
        }),
      },
    ]);

    const project = makeEmbeddingProject(server.url);
    const outputDir = path.join(project.projectDir, 'pipeline-output');
    const dbPath = path.join(project.projectDir, 'embeddings.duckdb');

    const result = await runCli(
      [
        'pipeline',
        '--integration',
        'test_api',
        '--resource',
        'test_items',
        '--dest',
        'duckdb',
        '--db-path',
        dbPath,
        '--output-dir',
        outputDir,
        '--embed-config-json',
        JSON.stringify({
          provider: 'openai',
          model: 'text-embedding-3-small',
          api_key: 'stub-key',
          streams: {
            test_items: [{ field: 'body' }],
          },
        }),
      ],
      project.projectDir,
      {
        BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
        BOBSLED_CORE_EMBED_STUB: '1',
        NODE_EXTRA_CA_CERTS: project.caCertPath,
      }
    );

    expect(result.exitCode).toBe(0);

    const rows = await queryPersistentDb(
      dbPath,
      'SELECT id, body, body_embedding FROM main.test_items ORDER BY id'
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: BigInt(1),
      body: 'alpha note',
    });
    expect(rows[0]?.['body_embedding']).toHaveLength(1536);
  });

  function makeProject(baseUrl: string): { projectDir: string; caCertPath: string } {
    const projectDir = makeTempDir('bobsled-pipeline-smoke-');
    const caCertPath = path.join(projectDir, 'fake-ca.pem');
    const integrationSpec = makeProvider(baseUrl, { name: 'test_api' });
    const resource = makeResource({
      name: 'test_items',
      integration: 'test_api',
      endpoint: '/items',
      response: { record_path: '$' },
    });

    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'test_api'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'extractor.yml'),
      YAML.stringify({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
        state_dir: '.extractor',
        output_dir: 'output',
        default_output: 'stdout',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'integrations', 'test_api.yml'),
      YAML.stringify(integrationSpec),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'test_api', 'test_items.yml'),
      YAML.stringify(resource),
      'utf-8'
    );
    fs.writeFileSync(caCertPath, FAKE_SERVER_CERT, 'utf-8');

    return { projectDir, caCertPath };
  }

  function makeEmbeddingProject(baseUrl: string): { projectDir: string; caCertPath: string } {
    const projectDir = makeTempDir('bobsled-pipeline-embed-smoke-');
    const caCertPath = path.join(projectDir, 'fake-ca.pem');
    const integrationSpec = makeProvider(baseUrl, { name: 'test_api' });
    const resource = makeResource({
      name: 'test_items',
      integration: 'test_api',
      endpoint: '/items',
      response: { record_path: '$' },
    });
    resource.output = {
      id: {
        type: 'integer',
        path: '$.id',
      },
      body: {
        type: 'string',
        path: '$.body',
        embedding_candidate: true,
      },
    };

    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'test_api'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'extractor.yml'),
      YAML.stringify({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
        state_dir: '.extractor',
        output_dir: 'output',
        default_output: 'stdout',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'integrations', 'test_api.yml'),
      YAML.stringify(integrationSpec),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'resources', 'test_api', 'test_items.yml'),
      YAML.stringify(resource),
      'utf-8'
    );
    fs.writeFileSync(caCertPath, FAKE_SERVER_CERT, 'utf-8');

    return { projectDir, caCertPath };
  }

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }
});

function parseJsonLines(output: string): Array<Record<string, unknown>> {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isLoaderJsonLine(message: Record<string, unknown>): boolean {
  if (typeof message['level'] !== 'string' || typeof message['ts'] !== 'string') {
    return false;
  }

  // Log line (has `event`) or metric line (has `name` + `value`, `stream` optional for pipeline-wide metrics).
  return (
    typeof message['event'] === 'string' ||
    (typeof message['name'] === 'string' && 'value' in message)
  );
}

async function runCli(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env['NODE_BINARY'] ?? 'node',
      ['--import', tsxLoader, cliEntry, ...args],
      {
        cwd,
        env: { ...process.env, ...envOverrides },
        signal: AbortSignal.timeout(15_000),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });
  });
}
