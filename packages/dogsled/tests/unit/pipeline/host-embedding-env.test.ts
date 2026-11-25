import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/runtime/workspace.js', () => ({
  resolveCliInvocation: vi.fn((target: string, _metaUrl: string, args: string[]) => ({
    command: `${target}-cli`,
    args,
  })),
}));

import { runPipeline } from '../../../src/commands/pipeline.js';
import {
  HOST_EMBEDDING_TOKEN_ENV,
  HOST_EMBEDDING_URL_ENV,
  runProjectPipeline,
  type RunProjectPipelineOptions,
} from '../../../src/pipeline/index.js';

const TOKEN = 'synthetic-host-token';
const HOST_URL = 'https://host.example/private/embed';
const HOST_ENV = { [HOST_EMBEDDING_URL_ENV]: HOST_URL, [HOST_EMBEDDING_TOKEN_ENV]: TOKEN };
const NAMES = [HOST_EMBEDDING_URL_ENV, HOST_EMBEDDING_TOKEN_ENV];

const HOST = 'provider: host';
const OPENAI = `provider: openai
      model: text-embedding-3-small
      api_key: $OPENAI_API_KEY`;

interface Child {
  stage: string;
  env: NodeJS.ProcessEnv;
  embedConfig?: Record<string, unknown>;
}

const tempDirs: string[] = [];

beforeEach(() => {
  for (const name of [...NAMES, 'DOGSLED_EMBED_STUB']) vi.stubEnv(name, undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(options: {
  provider?: string;
  destinations?: string[];
  field?: string;
  enabled?: boolean;
}): string {
  const { provider, destinations = ['one'], field = 'text', enabled = true } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-host-embedding-'));
  tempDirs.push(root);
  const write = (file: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
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
  method: full_refresh
output:
  document_id: { type: string }
`
  );
  write(
    'dogsled.yml',
    `destinations:
${destinations.map((name) => `  ${name}: { type: duckdb, db_path: ./${name}.duckdb }`).join('\n')}
pipelines:
  documents:
    schedule: manual
    source: files
    enabled: ${enabled}
    table_prefix: kb__
    ${destinations.length > 1 ? `destinations: [${destinations.join(', ')}]` : `destination: ${destinations[0]}`}
    resources: [docs]
${
  provider
    ? `    embed:
      ${provider}
      streams:
        docs: [{ field: ${field} }]
`
    : ''
}`
  );
  return root;
}

/** Children that do nothing and succeed, with what each one was given. */
function fakeSpawn(stderrByStage: Record<string, string> = {}) {
  const children: Child[] = [];
  const spawn = vi.fn(
    (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      const stage = args[0] === 'commit-state' ? 'commit-state' : command.replace('-cli', '');
      const configIndex = args.indexOf('--config');
      children.push({
        stage,
        env: { ...options.env },
        ...(stage === 'embed'
          ? { embedConfig: JSON.parse(fs.readFileSync(args[configIndex + 1]!, 'utf8')) }
          : {}),
      });
      const child = new EventEmitter() as ChildProcess;
      const [stdin, stdout, stderr] = [new PassThrough(), new PassThrough(), new PassThrough()];
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        kill: () => {
          setImmediate(() => child.emit('close', null, 'SIGTERM'));
          return true;
        },
      });
      const finish = (): void => {
        if (stderrByStage[stage]) stderr.write(`${stderrByStage[stage]}\n`);
        stdout.end();
        stderr.end();
        setImmediate(() => child.emit('close', 0, null));
      };
      stdin.resume();
      if (Array.isArray(options.stdio) && options.stdio[0] === 'ignore') setImmediate(finish);
      else stdin.on('end', finish);
      return child;
    }
  );
  return { spawn, children };
}

async function run(
  projectRoot: string,
  options: Partial<RunProjectPipelineOptions> = {},
  stderrByStage?: Record<string, string>
) {
  const { spawn, children } = fakeSpawn(stderrByStage);
  const result = await runProjectPipeline(
    { projectRoot, pipelineName: 'documents', quiet: true, ...options },
    { spawn }
  );
  return { result, children };
}

function expectNothingAbout(child: Child): void {
  for (const name of NAMES) expect(child.env).not.toHaveProperty(name);
  expect(Object.values(child.env)).not.toContain(TOKEN);
  expect(Object.values(child.env)).not.toContain(HOST_URL);
}

describe('the environment of each child', () => {
  const sources: Array<[string, () => Partial<RunProjectPipelineOptions>]> = [
    ['options.env', () => ({ env: HOST_ENV })],
    [
      'process.env',
      () => {
        for (const [name, value] of Object.entries(HOST_ENV)) vi.stubEnv(name, value);
        return {};
      },
    ],
  ];

  describe.each(sources)('with the endpoint and token in %s', (_label, supply) => {
    it('gives them only to the embed child of one destination', async () => {
      const { result, children } = await run(makeProject({ provider: HOST }), supply());
      expect(result).toMatchObject({ exitCode: 0, status: 'success' });
      expect(children.map(({ stage }) => stage)).toEqual(['extract', 'embed', 'load']);
      const [extract, embed, load] = children;
      expectNothingAbout(extract!);
      expect(embed!.env).toMatchObject(HOST_ENV);
      expectNothingAbout(load!);
    });

    it('gives them only to the embed child of several destinations', async () => {
      const project = makeProject({ provider: HOST, destinations: ['one', 'two'] });
      const { result, children } = await run(project, supply());
      expect(result).toMatchObject({ exitCode: 0, status: 'success' });
      expect(children.map(({ stage }) => stage)).toEqual([
        'extract',
        'embed',
        'load',
        'load',
        'commit-state',
      ]);
      for (const child of children) {
        if (child.stage === 'embed') expect(child.env).toMatchObject(HOST_ENV);
        else expectNothingAbout(child);
      }
    });

    it.each([
      ['another provider', OPENAI, ['one']],
      ['another provider and several destinations', OPENAI, ['one', 'two']],
      ['no embed block', undefined, ['one']],
      ['no embed block and several destinations', undefined, ['one', 'two']],
    ])('gives them to no child with %s', async (_case, provider, destinations) => {
      const { result, children } = await run(makeProject({ provider, destinations }), supply());
      expect(result).toMatchObject({ exitCode: 0 });
      expect(children.length).toBeGreaterThanOrEqual(2);
      for (const child of children) expectNothingAbout(child);
    });
  });

  it('gives them to no child of a stub run, which needs neither', async () => {
    const project = makeProject({ provider: HOST });
    const { result, children } = await run(project, { env: { DOGSLED_EMBED_STUB: '1' } });
    expect(result).toMatchObject({ exitCode: 0 });
    const stubbed = await run(project, { env: { ...HOST_ENV, DOGSLED_EMBED_STUB: '1' } });
    for (const child of [...children, ...stubbed.children]) expectNothingAbout(child);
  });

  it('never puts them in the embed config file', async () => {
    const { children } = await run(makeProject({ provider: HOST }), { env: HOST_ENV });
    expect(children[1]!.embedConfig).toEqual({
      provider: 'host',
      streams: { docs__chunks: [{ field: 'text' }] },
    });
  });

  it('applies to a direct run too', async () => {
    const { spawn, children } = fakeSpawn();
    const exitCode = await runPipeline(
      ['docs'],
      {
        integration: 'files',
        dest: 'duckdb',
        dbPath: './one.duckdb',
        outputDir: './output',
        embedConfigJson: JSON.stringify({
          provider: 'host',
          streams: { docs__chunks: [{ field: 'text' }] },
        }),
      },
      { spawn, env: HOST_ENV }
    );
    expect(exitCode).toBe(0);
    for (const child of children) {
      if (child.stage === 'embed') expect(child.env).toMatchObject(HOST_ENV);
      else expectNothingAbout(child);
    }
  });
});

describe('what a run may reference', () => {
  it.each([
    ['neither', {}, NAMES.join(', ')],
    ['only the URL', { [HOST_EMBEDDING_URL_ENV]: HOST_URL }, HOST_EMBEDDING_TOKEN_ENV],
    ['only the token', { [HOST_EMBEDDING_TOKEN_ENV]: TOKEN }, HOST_EMBEDDING_URL_ENV],
  ])('starts nothing when the host set %s', async (_label, env, missing) => {
    const refused = {
      exitCode: 2,
      message: expect.stringContaining(`Not set: ${missing}.`),
    };
    for (const destinations of [['one'], ['one', 'two']]) {
      const { spawn } = fakeSpawn();
      const projectRoot = makeProject({ provider: HOST, destinations });
      const started = runProjectPipeline(
        { projectRoot, pipelineName: 'documents', quiet: true, env },
        { spawn }
      );
      await expect(started).rejects.toMatchObject(refused);
      expect(spawn).not.toHaveBeenCalled();
    }

    const { spawn } = fakeSpawn();
    const direct = runPipeline(
      ['docs'],
      {
        integration: 'files',
        outputDir: './output',
        embedConfigJson: JSON.stringify({
          provider: 'host',
          streams: { docs__chunks: [{ field: 'text' }] },
        }),
      },
      { spawn, env }
    );
    await expect(direct).rejects.toMatchObject(refused);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(NAMES)('resolves no destination placeholder for %s', async (name) => {
    for (const placeholder of [`$${name}`, `\${{ env.${name} }}`]) {
      const { spawn, children } = fakeSpawn();
      const direct = runPipeline(
        ['docs'],
        {
          integration: 'files',
          dest: 'postgres',
          postgresHost: 'db.example.com',
          postgresDatabase: 'example',
          postgresUser: 'example',
          postgresPassword: placeholder,
          outputDir: './output',
          embedConfigJson: JSON.stringify({
            provider: 'host',
            streams: { docs__chunks: [{ field: 'text' }] },
          }),
        },
        { spawn, env: HOST_ENV }
      );
      await expect(direct).rejects.toThrow('reserved');
      await expect(direct).rejects.not.toThrow(TOKEN);
      expect(children.filter(({ stage }) => stage === 'load')).toEqual([]);
    }
  });

  it.each(NAMES)('resolves no authored destination setting for %s', async (name) => {
    const project = makeProject({ provider: HOST });
    const config = path.join(project, 'dogsled.yml');
    fs.writeFileSync(
      config,
      fs.readFileSync(config, 'utf8').replace('./one.duckdb', `'\${{ env.${name} }}'`)
    );
    const { spawn, children } = fakeSpawn();
    const started = runProjectPipeline(
      { projectRoot: project, pipelineName: 'documents', quiet: true, env: HOST_ENV },
      { spawn }
    );
    await expect(started).rejects.toThrow('reserved');
    expect(children).toEqual([]);
  });

  it.each(NAMES)('lets no host declare %s', async (name) => {
    const { spawn } = fakeSpawn();
    const started = runProjectPipeline(
      {
        projectRoot: makeProject({ provider: HOST }),
        pipelineName: 'documents',
        env: HOST_ENV,
        declaredEnvNames: [name],
      },
      { spawn }
    );
    await expect(started).rejects.toThrow(/^declaredEnvNames: .* reserved/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('adds the names a host declares to the block, which ignores them', async () => {
    const { result, children } = await run(makeProject({ provider: HOST }), {
      env: { ...HOST_ENV, HOST_SOURCE_TOKEN: 'synthetic-source' },
      declaredEnvNames: ['HOST_SOURCE_TOKEN'],
    });
    expect(result.exitCode).toBe(0);
    expect(children[1]!.embedConfig).toMatchObject({ auth_env_vars: ['HOST_SOURCE_TOKEN'] });
  });
});

describe('what a run may report', () => {
  const leaky = JSON.stringify({
    level: 'error',
    event: `Failed to load stream "docs__chunks" to duckdb: ${HOST_URL} said ${TOKEN}`,
    ts: '2026-01-01T00:00:00.000Z',
  });

  it.each(['options.env', 'process.env'])('redacts both values from %s', async (source) => {
    if (source === 'process.env') {
      for (const [name, value] of Object.entries(HOST_ENV)) vi.stubEnv(name, value);
    }
    const events: unknown[] = [];
    const { result } = await run(
      makeProject({ provider: HOST }),
      {
        ...(source === 'options.env' ? { env: HOST_ENV } : {}),
        onEvent: (event) => events.push(event),
        quiet: false,
      },
      { embed: leaky, load: leaky }
    );
    const written = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk));
    const told = JSON.stringify([result, events, written]);
    expect(result.errors[0]?.message).toContain('[REDACTED]');
    expect(told).toContain('docs__chunks');
    expect(told).not.toContain(TOKEN);
    expect(told).not.toContain('host.example');
  });

  it('redacts both values from what a host resolver reports', async () => {
    for (const [name, value] of Object.entries(HOST_ENV)) vi.stubEnv(name, value);
    const { spawn } = fakeSpawn();
    const result = await runProjectPipeline(
      { projectRoot: makeProject({ provider: OPENAI }), pipelineName: 'documents', quiet: true },
      {
        spawn,
        resolvePipeline: async (options, resolveDefault) => ({
          ...(await resolveDefault(options)),
          warnings: [`${HOST_URL} ${TOKEN}`],
        }),
      }
    );
    expect(result.warnings).toEqual(['[REDACTED] [REDACTED]']);
  });
});

describe('the report of refused inputs', () => {
  const report = {
    _v: 1,
    type: 'LOG',
    level: 'warn',
    message: 'The embedding provider refused 3 inputs',
    time: '2026-01-01T00:00:00.000Z',
    event: 'embedding.inputs_rejected',
    attributes: { stream: 'docs__chunks', counts: { too_long: 2, constructor: 1 } },
  };

  it.each([['one'], ['one', 'two']])(
    'keeps its event and attributes on the way out (%#)',
    async (...destinations) => {
      const project = makeProject({ provider: HOST, destinations });
      const logFile = path.join(project, 'run.log');
      const { result } = await run(
        project,
        { env: HOST_ENV, quiet: false, logFile },
        { embed: JSON.stringify(report) }
      );
      expect(result.exitCode).toBe(0);
      const written = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk));
      // The run ends the log file without waiting for it.
      await vi.waitFor(() =>
        expect(fs.readFileSync(logFile, 'utf8')).toContain('embedding.inputs_rejected')
      );
      for (const lines of [written.join(''), fs.readFileSync(logFile, 'utf8')]) {
        const forwarded = lines
          .split('\n')
          .filter((line) => line.includes('embedding.inputs_rejected'))
          .map((line) => JSON.parse(line) as unknown);
        expect(forwarded).toEqual([report]);
      }
    }
  );
});

describe('the streams a run hands to the embedder', () => {
  it.each([['one'], ['one', 'two']])('are the chunk streams (%#)', async (...destinations) => {
    const { children } = await run(makeProject({ provider: OPENAI, destinations }));
    const embed = children.find(({ stage }) => stage === 'embed');
    expect(embed?.embedConfig?.['streams']).toEqual({ docs__chunks: [{ field: 'text' }] });
  });

  it('are resolved for a host that resolves the pipeline itself', async () => {
    const projectRoot = makeProject({ provider: OPENAI });
    const { spawn, children } = fakeSpawn();
    await runProjectPipeline(
      { projectRoot, pipelineName: 'documents', quiet: true },
      {
        spawn,
        resolvePipeline: async (options, resolveDefault) => {
          const resolved = await resolveDefault(options);
          return { ...resolved, pipeline: structuredClone(resolved.pipeline) };
        },
      }
    );
    expect(children[1]?.embedConfig?.['streams']).toEqual({ docs__chunks: [{ field: 'text' }] });
  });

  it('are checked for a pipeline that validation skipped', async () => {
    const projectRoot = makeProject({ provider: OPENAI, field: 'body', enabled: false });
    const { spawn } = fakeSpawn();
    const started = runProjectPipeline(
      { projectRoot, pipelineName: 'documents', quiet: true },
      { spawn }
    );
    await expect(started).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('only the "text" of its chunks can be embedded'),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
