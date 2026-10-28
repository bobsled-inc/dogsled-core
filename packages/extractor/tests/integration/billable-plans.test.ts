import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { makeProvider, makeResource } from '../helpers/fixtures.js';
import { FAKE_SERVER_CERT, createFakeHttpsServer, type FakeServer } from './helpers/fake-server.js';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx/esm');
const cliEntry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe('billable extract plans', () => {
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

  it('estimates and executes a billable plan from extract-intents.yml', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/person/enrich',
        method: 'POST',
        handler: () => ({
          body: { id: 'person_1', profile: 'https://linkedin.example/profile' },
        }),
      },
    ]);

    const project = makeProject(server.url, 10);

    const estimateResult = await runCli(
      ['estimate', '--plan', 'enrich_targets', '--format', 'json'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );
    expect(estimateResult.exitCode).toBe(0);
    expect(JSON.parse(estimateResult.stdout)).toMatchObject({
      plan: 'enrich_targets',
      totals: {
        estimated_requests: 2,
        estimated_credits: 2,
        estimate_confidence: 'exact',
      },
    });

    const runResult = await runCli(['run', '--plan', 'enrich_targets'], project.projectDir, {
      NODE_EXTRA_CA_CERTS: project.caCertPath,
    });
    expect(runResult.exitCode).toBe(0);
    expect(parseJsonLines(runResult.stdout).map((message) => message.type)).toEqual([
      'SCHEMA',
      'RECORD',
      'RECORD',
    ]);
  });

  it('rejects billable resources outside an explicit plan', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/person/enrich',
        method: 'POST',
        handler: () => ({
          body: { id: 'person_1', profile: 'https://linkedin.example/profile' },
        }),
      },
    ]);

    const project = makeProject(server.url, 10);

    const runResult = await runCli(
      ['run', '--integration', 'test_api', 'person_enrich'],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );
    expect(runResult.exitCode).toBe(2);
    expect(runResult.stderr).toContain('Billable resources require an explicit extract plan');

    const lookupResult = await runCli(
      [
        'lookup',
        '--integration',
        'test_api',
        '--resource',
        'person_enrich',
        '--input',
        'profile=x',
      ],
      project.projectDir,
      { NODE_EXTRA_CA_CERTS: project.caCertPath }
    );
    expect(lookupResult.exitCode).toBe(2);
    expect(lookupResult.stderr).toContain('Lookup is disabled for billable resource');

    const scaffoldResult = await runCli(['scaffold-test', 'test_api'], project.projectDir, {
      NODE_EXTRA_CA_CERTS: project.caCertPath,
    });
    expect(scaffoldResult.exitCode).toBe(2);
    expect(scaffoldResult.stderr).toContain('scaffold-test refuses billable resources by default');
  });

  it('rejects over-budget plan execution', async () => {
    server = await createFakeHttpsServer([
      {
        path: '/person/enrich',
        method: 'POST',
        handler: () => ({
          body: { id: 'person_1', profile: 'https://linkedin.example/profile' },
        }),
      },
    ]);

    const project = makeProject(server.url, 1);
    const result = await runCli(['run', '--plan', 'enrich_targets'], project.projectDir, {
      NODE_EXTRA_CA_CERTS: project.caCertPath,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('exceeds budget');
  });

  function makeProject(
    baseUrl: string,
    budgetCredits: number
  ): {
    projectDir: string;
    caCertPath: string;
  } {
    const projectDir = makeTempDir('extractor-billable-project-');
    const caCertPath = path.join(projectDir, 'fake-ca.pem');
    const integrationSpec = makeProvider(baseUrl, { name: 'test_api' });
    const resource = makeResource({
      name: 'person_enrich',
      integration: 'test_api',
      api: {
        endpoint: '/person/enrich',
        method: 'POST',
        request_body: {
          profile: '${{ input.profile }}',
        },
      },
      input: {
        profile: { type: 'string', required: true },
      },
      output: {
        id: { type: 'string', path: '$.id' },
        profile: { type: 'string', path: '$.profile' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
        },
      },
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'credit',
        estimation: {
          model: 'per_input_row',
          amount: 1,
          currency: 'provider_credit',
        },
        authorization: {
          requires_plan: true,
        },
      },
    });

    fs.mkdirSync(path.join(projectDir, 'integrations'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources', 'test_api'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'seeds'), { recursive: true });
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
      path.join(projectDir, 'resources', 'test_api', 'person_enrich.yml'),
      YAML.stringify(resource),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'extract-intents.yml'),
      YAML.stringify({
        spec_version: '1',
        type: 'extract-intents',
        plans: {
          enrich_targets: {
            description: 'Enrich outbound targets',
            budget: {
              max_estimated_credits: budgetCredits,
              on_exceed: 'fail',
            },
            seeds: {
              candidates: {
                format: 'csv',
                path: './seeds/candidates.csv',
              },
            },
            steps: [
              {
                id: 'person_enrich',
                integration: 'test_api',
                resource: 'person_enrich',
                seed: 'candidates',
                input: {
                  profile: '${{ seed.linkedin_url }}',
                },
                limits: {
                  max_input_rows: 2,
                },
              },
            ],
          },
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'seeds', 'candidates.csv'),
      'linkedin_url\nhttps://linkedin.example/profile-a\nhttps://linkedin.example/profile-b\n',
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
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
