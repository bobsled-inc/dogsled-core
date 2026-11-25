import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEmbedderConfigInput,
  registerRunCommand,
  runEmbedCommand,
  takeRunEnv,
} from '../../../src/commands/run.js';
import { outputColumnName } from '../../../src/output-column.js';

function createWritableBuffer(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
  };
}

describe('buildEmbedderConfigInput', () => {
  it('parses a valid inline config', () => {
    const config = buildEmbedderConfigInput({
      configJson: JSON.stringify({
        provider: 'openai',
        model: 'text-embedding-3-small',
        api_key: 'sk-test',
        streams: {
          docs: [{ field: 'body' }],
        },
      }),
    });

    expect(config).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key: 'sk-test',
    });
  });

  it('requires exactly one config source', () => {
    expect(() => buildEmbedderConfigInput({})).toThrow(CommandError);
    expect(() =>
      buildEmbedderConfigInput({
        configPath: '/tmp/embedder.json',
        configJson: '{}',
      })
    ).toThrow(/Exactly one of --config <path> or --config-json <json> is required/);
  });

  it('exposes the default output column name helper', () => {
    expect(outputColumnName('body')).toBe('body_embedding');
    expect(outputColumnName('body', 'embedding')).toBe('embedding');
  });
});

describe('registerRunCommand', () => {
  it('accepts output-mode flags on the run command', () => {
    const program = new Command();

    registerRunCommand(program);

    const runCommand = program.commands[0];
    expect(runCommand?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--json', '--verbose', '--quiet', '--log-format'])
    );
  });
});

describe('the environment of dogsled embed run', () => {
  const hostEnv = {
    DOGSLED_HOST_EMBEDDING_URL: 'https://host.example/embed',
    DOGSLED_HOST_EMBEDDING_TOKEN: 'synthetic-host-token',
  };
  const streams = { docs: [{ field: 'body' }] };
  const hostNames = (env: Record<string, string | undefined>): string[] =>
    Object.keys(env).filter((name) => name.toUpperCase().includes('HOST_EMBEDDING'));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Run the command with both variables set, and look at what the run and a child would get. */
  async function runWith(config: Record<string, unknown>) {
    for (const [name, value] of Object.entries(hostEnv)) vi.stubEnv(name, value);
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    let given: Record<string, string | undefined> = {};
    let inherited: string[] = [];
    const program = new Command();
    registerRunCommand(program, async (_config, dependencies) => {
      given = dependencies?.env ?? {};
      inherited = hostNames(process.env);
    });
    await program.parseAsync(['node', 'dogsled', 'run', '--config-json', JSON.stringify(config)]);
    return { given, inherited };
  }

  it('gives the endpoint and token to a host run, and to no process it starts', async () => {
    const { given, inherited } = await runWith({ provider: 'host', streams });
    expect(given).toMatchObject(hostEnv);
    expect(inherited).toEqual([]);
  });

  it('gives them to no other provider, and to no process it starts', async () => {
    const { given, inherited } = await runWith({
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key: '$OPENAI_API_KEY',
      streams,
    });
    expect(hostNames(given)).toEqual([]);
    expect(given['OPENAI_API_KEY']).toBe('test-key');
    expect(inherited).toEqual([]);
  });

  it('removes them in any case, and keeps everything else', () => {
    const processEnv: Record<string, string | undefined> = {
      PATH: '/bin',
      Dogsled_Host_Embedding_Token: 'synthetic-host-token',
    };
    const env = takeRunEnv(
      { provider: 'ollama', model: 'example', base_url: 'http://127.0.0.1:11434/api', streams },
      processEnv
    );
    expect(processEnv).toEqual({ PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('runEmbedCommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves env placeholders and runs in stub mode', async () => {
    const output = createWritableBuffer();
    const errorOutput = createWritableBuffer();

    await runEmbedCommand(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        api_key: '$OPENAI_API_KEY',
        streams: {
          docs: [{ field: 'body' }],
        },
      },
      {
        input: Readable.from([
          `${JSON.stringify({
            _v: 1,
            type: 'SCHEMA',
            stream: 'docs',
            schema: {
              columns: [
                { name: 'id', type: 'integer', primary_key: true },
                { name: 'body', type: 'string' },
              ],
            },
            key_properties: ['id'],
            load_strategy: 'append',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'docs',
            time_extracted: '2026-04-23T00:00:00.000Z',
            record: { id: 1, body: 'hello' },
          })}\n`,
        ]),
        output: output.stream,
        errorOutput: errorOutput.stream,
        env: {
          OPENAI_API_KEY: 'sk-test',
          DOGSLED_EMBED_STUB: '1',
        },
      }
    );

    const lines = output.chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const record = lines.find((line) => line.type === 'RECORD');
    expect(record).toBeDefined();
    expect(record!.record.body_embedding).toHaveLength(1536);
  });

  it('respects quiet mode by suppressing non-error logs', async () => {
    const errorOutput = createWritableBuffer();

    await runEmbedCommand(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        api_key: 'sk-test',
        streams: {
          docs: [{ field: 'body' }],
        },
      },
      {
        input: Readable.from([
          `${JSON.stringify({
            _v: 1,
            type: 'SCHEMA',
            stream: 'docs',
            schema: {
              columns: [
                { name: 'id', type: 'integer', primary_key: true },
                { name: 'body', type: 'string' },
              ],
            },
            key_properties: ['id'],
            load_strategy: 'append',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'docs',
            time_extracted: '2026-04-23T00:00:00.000Z',
            record: { id: 1, body: 'hello' },
          })}\n`,
        ]),
        output: createWritableBuffer().stream,
        errorOutput: errorOutput.stream,
        env: {
          DOGSLED_EMBED_STUB: '1',
        },
        logOptions: {
          quiet: true,
          verbose: true,
          logFormat: 'json',
        },
      }
    );

    expect(errorOutput.chunks.join('')).toBe('');
  });

  it('supports pretty verbose logging', async () => {
    const errorOutput = createWritableBuffer();

    await runEmbedCommand(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        api_key: 'sk-test',
        streams: {
          docs: [{ field: 'body' }],
        },
      },
      {
        input: Readable.from([
          `${JSON.stringify({
            _v: 1,
            type: 'SCHEMA',
            stream: 'docs',
            schema: {
              columns: [
                { name: 'id', type: 'integer', primary_key: true },
                { name: 'body', type: 'string' },
              ],
            },
            key_properties: ['id'],
            load_strategy: 'append',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'docs',
            time_extracted: '2026-04-23T00:00:00.000Z',
            record: { id: 1, body: 'hello' },
          })}\n`,
        ]),
        output: createWritableBuffer().stream,
        errorOutput: errorOutput.stream,
        env: {
          DOGSLED_EMBED_STUB: '1',
        },
        logOptions: {
          verbose: true,
          logFormat: 'pretty',
        },
      }
    );

    expect(errorOutput.chunks.join('')).toContain('[debug]');
    expect(errorOutput.chunks.join('')).toContain('[metric]');
  });

  it.each(['RECORD', 'BATCH'])(
    'still embeds whitespace in a %s for a provider other than host',
    async (type) => {
      const output = createWritableBuffer();
      const dir = mkdtempSync(path.join(os.tmpdir(), 'embed-run-'));
      const file = path.join(dir, 'docs-0.jsonl');
      writeFileSync(file, `${JSON.stringify({ id: 1, body: ' ' })}\n`);
      const message =
        type === 'RECORD'
          ? {
              time_extracted: '2026-04-23T00:00:00.000Z',
              record: { id: 1, body: ' ' },
            }
          : { encoding: { format: 'jsonl' }, manifest: [pathToFileURL(file).href] };
      await runEmbedCommand(
        {
          provider: 'openai',
          model: 'text-embedding-3-small',
          api_key: 'sk-test',
          dimension: 2,
          streams: { docs: [{ field: 'body' }] },
        },
        {
          input: Readable.from([
            `${JSON.stringify({
              _v: 1,
              type: 'SCHEMA',
              stream: 'docs',
              schema: {
                columns: [
                  { name: 'id', type: 'integer' },
                  { name: 'body', type: 'string' },
                ],
              },
              key_properties: [],
              load_strategy: 'append',
            })}\n`,
            `${JSON.stringify({ _v: 1, type, stream: 'docs', ...message })}\n`,
          ]),
          output: output.stream,
          errorOutput: createWritableBuffer().stream,
          env: { DOGSLED_EMBED_STUB: '1', DOGSLED_EMBEDDER_TMP_DIR: dir },
        }
      );
      const written = JSON.parse(output.chunks.join('').trim().split('\n')[1]!);
      const row =
        type === 'RECORD'
          ? written.record
          : JSON.parse(readFileSync(new URL(written.manifest[0]), 'utf8'));
      expect(row).toEqual({ id: 1, body: ' ', body_embedding: [0, 0] });
      rmSync(dir, { recursive: true, force: true });
    }
  );

  it('throws when the configured env var is missing', async () => {
    await expect(
      runEmbedCommand(
        {
          provider: 'openai',
          model: 'text-embedding-3-small',
          api_key: '$MISSING_OPENAI_API_KEY',
          streams: {
            docs: [{ field: 'body' }],
          },
        },
        {
          env: {},
        }
      )
    ).rejects.toThrow(/MISSING_OPENAI_API_KEY/);
  });
});

describe('embedder provider security', () => {
  const streams = { docs: [{ field: 'body' }] };
  it.each([
    { provider: 'amazon-bedrock', model: 'test', region: 'evil.example#' },
    { provider: 'ollama', model: 'test', base_url: 'http://remote.example/api' },
    { provider: 'openai', model: 'test', api_key: '$UNRELATED_SECRET' },
  ])('rejects unsafe embed configuration $provider', (config) => {
    expect(() =>
      buildEmbedderConfigInput({ configJson: JSON.stringify({ ...config, streams }) })
    ).toThrow();
  });
  it('accepts explicitly declared custom key names', () => {
    expect(
      buildEmbedderConfigInput({
        configJson: JSON.stringify({
          provider: 'openai',
          model: 'test',
          api_key: '$CUSTOM_AI_KEY',
          auth_env_vars: ['CUSTOM_AI_KEY'],
          streams,
        }),
      })
    ).toMatchObject({ auth_env_vars: ['CUSTOM_AI_KEY'] });
  });
  it('rejects an undeclared key in direct command calls before resolving its value', async () => {
    const readSecret = vi.fn(() => 'must-not-appear');
    const env = Object.defineProperty({}, 'UNRELATED_SECRET', { get: readSecret });
    await expect(
      runEmbedCommand(
        {
          provider: 'openai',
          model: 'text-embedding-3-small',
          api_key: '$UNRELATED_SECRET',
          streams,
        },
        {
          env,
          input: Readable.from([]),
          output: createWritableBuffer().stream,
          errorOutput: createWritableBuffer().stream,
        }
      )
    ).rejects.toThrow('Undeclared API key environment variable: UNRELATED_SECRET');
    expect(readSecret).not.toHaveBeenCalled();
  });
});
