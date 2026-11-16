import { Readable, Writable } from 'node:stream';

import { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEmbedderConfigInput,
  registerRunCommand,
  runEmbedCommand,
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
          BOBSLED_CORE_EMBED_STUB: '1',
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
          BOBSLED_CORE_EMBED_STUB: '1',
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
          BOBSLED_CORE_EMBED_STUB: '1',
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
