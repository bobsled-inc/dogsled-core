import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runProjectPipeline } from '../../../src/pipeline/index.js';
import { createFakeHttpsServer, type FakeServer } from '../../integration/helpers/fake-server.js';

const SOURCE_TOKEN = 'host-source-canary';
const WIF_TOKEN = [
  { alg: 'RS256' },
  {
    aud: 'snowflake',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'https://issuer.example.com',
    sub: 'synthetic-host-test',
  },
  'synthetic-signature',
]
  .map((part) => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)))
  .map((part) => part.toString('base64url'))
  .join('.');

interface ExtractorCall {
  args: string[];
  env: NodeJS.ProcessEnv;
  stderr: string;
}

const CA_CERT_PATH = fileURLToPath(
  new URL('../../integration/fixtures/fake-server-cert.pem', import.meta.url)
);
let server: FakeServer;
const authorizations: Array<string | undefined> = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  server = await createFakeHttpsServer([
    {
      path: '/items',
      handler: (request) => {
        authorizations.push(request.headers.authorization);
        return { body: [{ id: 1, name: 'one' }] };
      },
    },
  ]);
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  authorizations.length = 0;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(destinations: string, destinationNames: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-host-dest-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'integrations'));
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(
    path.join(root, 'integrations/custom.yml'),
    `spec_version: '1'
type: integration
name: custom
transport:
  type: http
  base_url: ${server.url}
  auth:
    type: bearer
    token: \${{ env.HOST_SOURCE_TOKEN }}
`
  );
  fs.writeFileSync(
    path.join(root, 'resources/items.yml'),
    `spec_version: '1'
type: resource
name: items
integration: custom
description: Items
api:
  endpoint: /items
  method: GET
input: {}
output:
  id: { type: integer, path: $.id }
  name: { type: string, path: $.name }
extract:
  record_path: $
  table:
    primary_key: [id]
`
  );
  const destination =
    destinationNames.length === 1
      ? `destination: ${destinationNames[0]}`
      : `destinations: [${destinationNames.join(', ')}]`;
  fs.writeFileSync(
    path.join(root, 'dogsled.yml'),
    `destinations:
${destinations}
pipelines:
  items:
    schedule: manual
    source: custom
    ${destination}
    resources: [items]
`
  );
  return root;
}

const SNOWFLAKE_WIF = `  warehouse:
    type: snowflake
    account: demo
    username: demo_user
    credentials_workload_identity_token: \${{ env.HOST_DEST_WIF }}
    warehouse: demo_wh
    database: DEMO_DB
    schema: DEMO_SCHEMA
`;

const BIGQUERY_TOKEN = `  lake:
    type: bigquery
    project: demo-project
    dataset: demo_dataset
    credentials_access_token: $HOST_BQ_TOKEN
`;

function fakeLoader(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  stdin.resume();
  stdin.on('end', () => {
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    setImmediate(() => child.emit('close', 0, null));
  });
  return child;
}

/**
 * Spawns the real extractor CLI. Loader children are replaced so no warehouse
 * connection is attempted.
 */
function makeSpawn(calls: ExtractorCall[]) {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (!args.includes('--integration')) return fakeLoader();
    const call: ExtractorCall = { args: [...args], env: { ...options.env }, stderr: '' };
    calls.push(call);
    const child = spawnChild(command, args, options);
    child.stderr?.on('data', (chunk: Buffer) => {
      call.stderr += chunk.toString();
    });
    return child;
  };
}

function hostDeclarations(call: ExtractorCall): string[] {
  const index = call.args.indexOf('--host-env-names-json');
  return index < 0 ? [] : (JSON.parse(call.args[index + 1]!) as string[]);
}

const localApiEnv = {
  DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
  NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
};

const hostEnv = {
  ...localApiEnv,
  HOST_SOURCE_TOKEN: SOURCE_TOKEN,
  HOST_DEST_WIF: WIF_TOKEN,
  HOST_WIF_ALIAS: WIF_TOKEN,
};

describe('host-declared credentials with destination-only names (real extractor child)', () => {
  it('runs a Snowflake workload identity destination with a declared source and token alias', async () => {
    const projectRoot = makeProject(SNOWFLAKE_WIF, ['warehouse']);
    const calls: ExtractorCall[] = [];
    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: hostEnv,
        declaredEnvNames: ['HOST_SOURCE_TOKEN', 'HOST_DEST_WIF', 'HOST_WIF_ALIAS'],
      },
      { spawn: makeSpawn(calls) }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.stderr).not.toContain('must be supplied in options.env');
    expect(result).toMatchObject({ exitCode: 0 });
    expect(authorizations).toEqual([`Bearer ${SOURCE_TOKEN}`]);
    expect(hostDeclarations(calls[0]!)).toEqual(['HOST_SOURCE_TOKEN']);
    expect(calls[0]!.env['HOST_DEST_WIF']).toBeUndefined();
    expect(calls[0]!.env['HOST_WIF_ALIAS']).toBeUndefined();
    expect(Object.values(calls[0]!.env)).not.toContain(WIF_TOKEN);
  }, 60_000);

  it('keeps the destination token stripped across a fan-out', async () => {
    const projectRoot = makeProject(`${SNOWFLAKE_WIF}${BIGQUERY_TOKEN}`, ['warehouse', 'lake']);
    const calls: ExtractorCall[] = [];
    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: { ...hostEnv, HOST_BQ_TOKEN: 'host-bq-canary' },
        declaredEnvNames: ['HOST_SOURCE_TOKEN', 'HOST_DEST_WIF', 'HOST_WIF_ALIAS', 'HOST_BQ_TOKEN'],
      },
      { spawn: makeSpawn(calls) }
    );

    expect(calls[0]!.stderr).not.toContain('must be supplied in options.env');
    expect(result).toMatchObject({ exitCode: 0 });
    expect(authorizations).toEqual([`Bearer ${SOURCE_TOKEN}`]);
    expect(hostDeclarations(calls[0]!)).toEqual(['HOST_SOURCE_TOKEN', 'HOST_BQ_TOKEN']);
    expect(Object.values(calls[0]!.env)).not.toContain(WIF_TOKEN);
  }, 60_000);

  it('passes every declared name to the extractor for a BigQuery destination', async () => {
    const projectRoot = makeProject(BIGQUERY_TOKEN, ['lake']);
    const calls: ExtractorCall[] = [];
    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: {
          HOST_SOURCE_TOKEN: SOURCE_TOKEN,
          HOST_BQ_TOKEN: 'host-bq-canary',
          ...localApiEnv,
        },
        declaredEnvNames: ['HOST_SOURCE_TOKEN', 'HOST_BQ_TOKEN'],
      },
      { spawn: makeSpawn(calls) }
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(authorizations).toEqual([`Bearer ${SOURCE_TOKEN}`]);
    expect(hostDeclarations(calls[0]!)).toEqual(['HOST_SOURCE_TOKEN', 'HOST_BQ_TOKEN']);
  }, 60_000);

  it('still rejects an undeclared source name in the extractor', async () => {
    const projectRoot = makeProject(SNOWFLAKE_WIF, ['warehouse']);
    const calls: ExtractorCall[] = [];
    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: hostEnv,
        declaredEnvNames: ['HOST_DEST_WIF', 'HOST_WIF_ALIAS'],
      },
      { spawn: makeSpawn(calls) }
    ).catch((error: unknown) => error);

    expect(result).not.toMatchObject({ exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(hostDeclarations(calls[0]!)).toEqual([]);
    expect(calls[0]!.stderr).toContain('Undeclared environment variable: HOST_SOURCE_TOKEN');
    expect(authorizations).toEqual([]);
  }, 60_000);

  function useReservedSourceToken(projectRoot: string): void {
    const file = path.join(projectRoot, 'integrations/custom.yml');
    const integration = fs
      .readFileSync(file, 'utf8')
      .replace('HOST_SOURCE_TOKEN', 'SLACK_BOT_TOKEN');
    fs.writeFileSync(file, `${integration}auth_env_vars: [SLACK_BOT_TOKEN]\n`);
  }

  it('sends a reserved source name the host supplied for the run', async () => {
    const projectRoot = makeProject(BIGQUERY_TOKEN, ['lake']);
    useReservedSourceToken(projectRoot);
    const calls: ExtractorCall[] = [];
    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: { ...localApiEnv, SLACK_BOT_TOKEN: SOURCE_TOKEN, HOST_BQ_TOKEN: 'host-bq-canary' },
        declaredEnvNames: ['SLACK_BOT_TOKEN', 'HOST_BQ_TOKEN'],
      },
      { spawn: makeSpawn(calls) }
    );

    expect(calls[0]!.stderr).not.toContain('Reserved credential name');
    expect(result).toMatchObject({ exitCode: 0 });
    expect(authorizations).toEqual([`Bearer ${SOURCE_TOKEN}`]);
  }, 60_000);

  it('blocks a reserved source name the host left undeclared', async () => {
    const projectRoot = makeProject(BIGQUERY_TOKEN, ['lake']);
    useReservedSourceToken(projectRoot);
    const calls: ExtractorCall[] = [];
    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: { ...localApiEnv, SLACK_BOT_TOKEN: SOURCE_TOKEN, HOST_BQ_TOKEN: 'host-bq-canary' },
        declaredEnvNames: ['HOST_BQ_TOKEN'],
      },
      { spawn: makeSpawn(calls) }
    ).catch((error: unknown) => error);

    expect(result).not.toMatchObject({ exitCode: 0 });
    expect(calls[0]!.stderr).toContain('Reserved credential name env.SLACK_BOT_TOKEN');
    expect(calls[0]!.stderr).not.toContain(SOURCE_TOKEN);
    expect(authorizations).toEqual([]);
  }, 60_000);

  it('marks a library run as host-owned even when it declares nothing', async () => {
    const projectRoot = makeProject(`${BIGQUERY_TOKEN}    auth_env_vars: [HOST_BQ_TOKEN]\n`, [
      'lake',
    ]);
    useReservedSourceToken(projectRoot);
    const calls: ExtractorCall[] = [];
    await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'items',
        quiet: true,
        env: { ...localApiEnv, SLACK_BOT_TOKEN: SOURCE_TOKEN, HOST_BQ_TOKEN: 'host-bq-canary' },
      },
      { spawn: makeSpawn(calls) }
    ).catch((error: unknown) => error);

    expect(calls[0]!.args).toContain('--host-env-names-json');
    expect(hostDeclarations(calls[0]!)).toEqual([]);
    expect(calls[0]!.stderr).toContain('Reserved credential name env.SLACK_BOT_TOKEN');
    expect(authorizations).toEqual([]);
  }, 60_000);

  it('rejects a Project resource name that would parse as the host flag', async () => {
    const projectRoot = makeProject(BIGQUERY_TOKEN, ['lake']);
    useReservedSourceToken(projectRoot);
    const config = path.join(projectRoot, 'dogsled.yml');
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace(
          'resources: [items]',
          `resources: ['--host-env-names-json', '["SLACK_BOT_TOKEN"]']`
        )
    );
    const calls: ExtractorCall[] = [];
    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'items',
          quiet: true,
          env: { ...localApiEnv, SLACK_BOT_TOKEN: SOURCE_TOKEN, HOST_BQ_TOKEN: 'host-bq-canary' },
          declaredEnvNames: ['HOST_BQ_TOKEN'],
        },
        { spawn: makeSpawn(calls) }
      )
    ).rejects.toThrow('Resource "--host-env-names-json" not found');
    expect(calls).toHaveLength(0);
    expect(authorizations).toEqual([]);
  }, 60_000);

  it('still rejects a declared name missing from the host map before any spawn', async () => {
    const projectRoot = makeProject(SNOWFLAKE_WIF, ['warehouse']);
    const calls: ExtractorCall[] = [];
    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'items',
          quiet: true,
          quiet: true,
          env: { ...localApiEnv, HOST_DEST_WIF: WIF_TOKEN },
          declaredEnvNames: ['HOST_DEST_WIF', 'HOST_SOURCE_TOKEN'],
        },
        { spawn: makeSpawn(calls) }
      )
    ).rejects.toThrow('Host-declared environment variable HOST_SOURCE_TOKEN must be supplied');
    expect(calls).toHaveLength(0);
    expect(authorizations).toEqual([]);
  });
});
