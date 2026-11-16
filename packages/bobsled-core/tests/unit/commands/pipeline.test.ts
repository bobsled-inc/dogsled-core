import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { manifestWrites } = vi.hoisted(() => ({
  manifestWrites: [] as Array<{ manifestPath: string; manifest: Record<string, unknown> }>,
}));

vi.mock('../../../src/runner/manifest.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/runner/manifest.js')>(
    '../../../src/runner/manifest.js'
  );
  return {
    ...actual,
    writeManifest: vi.fn((manifestPath, manifest, onWarning) => {
      manifestWrites.push({
        manifestPath,
        manifest: JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>,
      });
      return actual.writeManifest(manifestPath, manifest, onWarning);
    }),
  };
});

import {
  buildPipelineSummaryMessage,
  registerPipelineCommand,
  runPipeline,
} from '../../../src/commands/pipeline.js';

import type { ChildProcess } from 'node:child_process';
import type { NamedDestination } from '../../../src/runner/config/schema.js';
import type { Mock } from 'vitest';

vi.mock('../../../src/runtime/workspace.js', () => ({
  resolveCliInvocation: vi.fn((target: string, _metaUrl: string, args: string[]) => ({
    command: `${target}-cli`,
    args,
  })),
}));

vi.mock('@bobsled-inc/integrations', () => ({
  getIntegrationsDir: vi.fn(() => '/mock/integrations'),
}));

vi.mock('@bobsled-inc/embedder', async () => {
  const { z } = await import('zod');
  return {
    EmbedderConfigSchema: z.object({
      provider: z.string(),
      model: z.string(),
      api_key: z.string().optional(),
      streams: z.record(z.string(), z.array(z.object({ field: z.string() }))),
    }),
  };
});

/** Wait for runPipeline's async setup (await import) to complete and spawn both children. */
async function waitForSpawns(spawn: Mock, count = 2) {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(count));
}

function createMockChild(
  options: {
    stdin?: PassThrough | null;
    stderr?: PassThrough | null;
    stdout?: PassThrough | null;
  } = {}
): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = options.stdin ?? null;
  child.stdout = options.stdout ?? null;
  child.stderr = options.stderr ?? null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function createAutoClosingFanOutSpawn(): Mock {
  const extractStdout = new PassThrough();
  const extractChild = createMockChild({ stdout: extractStdout });
  const loadChild = createMockChild({ stdin: new PassThrough() });
  const commitChild = createMockChild();

  return vi
    .fn()
    .mockImplementationOnce(() => {
      setImmediate(() => {
        extractStdout.end();
        extractChild.emit('close', 0);
      });
      return extractChild;
    })
    .mockImplementationOnce(() => {
      setImmediate(() => loadChild.emit('close', 0));
      return loadChild;
    })
    .mockImplementationOnce(() => {
      setImmediate(() => commitChild.emit('close', 0));
      return commitChild;
    }) as Mock;
}

const tempDirs: string[] = [];

function bobsledTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function getManifestSnapshot(index = -1): {
  manifestPath: string;
  manifest: Record<string, unknown>;
} {
  const snapshot = manifestWrites.at(index);
  if (!snapshot) {
    throw new Error('expected a manifest write');
  }
  return snapshot;
}

const mixedModeDestinationCases: Array<{
  label: string;
  destinations: NamedDestination[];
}> = [
  {
    label: 'local-only',
    destinations: [{ name: 'archive', type: 'local', format: 'csv' }],
  },
  {
    label: 'Snowflake',
    destinations: [
      {
        name: 'warehouse',
        type: 'snowflake',
        account: 'acme-org',
        username: 'loader',
        warehouse: 'compute_wh',
        database: 'raw',
      },
    ],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  manifestWrites.length = 0;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('registerPipelineCommand', () => {
  it('registers the command with the expected options', () => {
    const program = new Command();

    registerPipelineCommand(program);

    const pipeline = program.commands[0];
    expect(pipeline?.name()).toBe('pipeline');
    expect(pipeline?.options.map((option) => option.long)).toEqual([
      '--integration',
      '--resource',
      '--format',
      '--output-dir',
      '--dest',
      '--gcs-bucket',
      '--gcs-prefix',
      '--s3-bucket',
      '--s3-prefix',
      '--db-path',
      '--target-schema',
      '--project-id',
      '--dataset-id',
      '--location',
      '--key-filename',
      '--bq-access-token',
      '--sf-account',
      '--sf-username',
      '--sf-password',
      '--sf-private-key-path',
      '--sf-private-key-passphrase',
      '--sf-access-token',
      '--sf-workload-identity-token',
      '--sf-token-command',
      '--sf-warehouse',
      '--sf-database',
      '--sf-role',
      '--databricks-host',
      '--databricks-http-path',
      '--databricks-catalog',
      '--databricks-schema',
      '--databricks-token',
      '--databricks-oauth-client-id',
      '--databricks-oauth-client-secret',
      '--postgres-host',
      '--postgres-port',
      '--postgres-database',
      '--postgres-schema',
      '--postgres-user',
      '--postgres-password',
      '--postgres-ssl',
      '--mysql-host',
      '--mysql-port',
      '--mysql-database',
      '--mysql-user',
      '--mysql-password',
      '--mysql-ssl',
      '--clickhouse-host',
      '--clickhouse-port',
      '--clickhouse-database',
      '--clickhouse-username',
      '--clickhouse-password',
      '--clickhouse-ssl',
      '--clickhouse-vector-index',
      '--turbopuffer-api-key',
      '--turbopuffer-region',
      '--turbopuffer-namespace-prefix',
      '--turbopuffer-distance-metric',
      '--turbopuffer-full-text-columns',
      '--load-strategy',
      '--table-prefix',
      '--full-refresh',
      '--start-date',
      '--end-date',
      '--batch',
      '--batch-format',
      '--batch-size',
      '--buffer-size',
      '--emit-model-spec-source',
      '--input',
      '--verbose',
      '--quiet',
      '--log-file',
      '--log-format',
      '--embed-config-json',
      '--pipeline-name',
      '--destinations-json',
    ]);
  });

  it('rejects a literal Snowflake workload identity token at the CLI boundary', async () => {
    const program = new Command();
    program.exitOverride();
    const run = vi.fn().mockResolvedValue(0);
    registerPipelineCommand(program, run);
    const token = 'eyJhbGciOiJSUzI1NiJ9.secret.payload';

    const error = await program
      .parseAsync([
        'node',
        'dogsled',
        'pipeline',
        '--integration',
        'github',
        '--dest',
        'snowflake',
        '--sf-workload-identity-token',
        token,
      ])
      .then(
        () => new Error('expected workload identity token rejection'),
        (reason: unknown) => reason
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/environment variable reference/i);
    expect((error as Error).message).not.toContain(token);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['$VERCEL_OIDC_TOKEN', '${{ env.VERCEL_OIDC_TOKEN }}'])(
    'accepts the Snowflake workload identity environment reference %s',
    async (reference) => {
      const program = new Command();
      program.exitOverride();
      const run = vi.fn().mockResolvedValue(0);
      registerPipelineCommand(program, run);

      await expect(
        program.parseAsync([
          'node',
          'dogsled',
          'pipeline',
          '--integration',
          'github',
          '--dest',
          'snowflake',
          '--sf-workload-identity-token',
          reference,
        ])
      ).resolves.toBe(program);
      expect(run).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          dest: 'snowflake',
          sfWorkloadIdentityToken: reference,
        })
      );
    }
  );

  it('rejects a Snowflake workload identity token with --dest local before spawning', async () => {
    const program = new Command();
    program.exitOverride();
    const token = 'local-destination-vercel-oidc-token';
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;
    registerPipelineCommand(program, (resourceNames, options) =>
      runPipeline(resourceNames, options, {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        env: { VERCEL_OIDC_TOKEN: token },
      })
    );

    const error = await program
      .parseAsync([
        'node',
        'dogsled',
        'pipeline',
        '--integration',
        'github',
        '--dest',
        'local',
        '--format',
        'csv',
        '--sf-workload-identity-token',
        '$VERCEL_OIDC_TOKEN',
      ])
      .then(
        () => new Error('expected destination validation failure'),
        (reason: unknown) => reason
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/workload identity token.*snowflake destination/i);
    expect((error as Error).message).not.toContain(token);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(mixedModeDestinationCases)(
    'rejects a direct workload identity option with $label named destinations at the CLI boundary',
    async ({ destinations }) => {
      const program = new Command();
      program.exitOverride();
      const token = 'mixed-mode-cli-vercel-oidc-token';
      const spawn = createAutoClosingFanOutSpawn();
      registerPipelineCommand(program, (resourceNames, options) =>
        runPipeline(resourceNames, options, {
          metaUrl: 'file:///dogsled/tests/mock.ts',
          spawn,
          env: { VERCEL_OIDC_TOKEN: token },
        })
      );

      const error = await program
        .parseAsync([
          'node',
          'dogsled',
          'pipeline',
          '--integration',
          'github',
          '--sf-workload-identity-token',
          '$VERCEL_OIDC_TOKEN',
          '--destinations-json',
          JSON.stringify(destinations),
        ])
        .then(
          () => new Error('expected mixed-mode validation failure'),
          (reason: unknown) => reason
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/workload identity token.*named destinations/i);
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).not.toContain('$VERCEL_OIDC_TOKEN');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid batch-size values via parsePositiveInt', async () => {
    const program = new Command();
    program.exitOverride();
    registerPipelineCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dogsled',
        'pipeline',
        '--integration',
        'x',
        '--format',
        'csv',
        '--batch-size',
        '0',
      ])
    ).rejects.toThrow();
  });

  it('rejects negative batch-size values', async () => {
    const program = new Command();
    program.exitOverride();
    registerPipelineCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dogsled',
        'pipeline',
        '--integration',
        'x',
        '--format',
        'csv',
        '--batch-size',
        '-5',
      ])
    ).rejects.toThrow();
  });

  it('rejects non-numeric batch-size values', async () => {
    const program = new Command();
    program.exitOverride();
    registerPipelineCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dogsled',
        'pipeline',
        '--integration',
        'x',
        '--format',
        'csv',
        '--batch-size',
        'abc',
      ])
    ).rejects.toThrow();
  });

  it('rejects invalid batch-format values', async () => {
    const program = new Command();
    program.exitOverride();
    registerPipelineCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dogsled',
        'pipeline',
        '--integration',
        'x',
        '--format',
        'csv',
        '--batch-format',
        'avro',
      ])
    ).rejects.toThrow();
  });

  it.each(['--postgres-port', '--mysql-port', '--clickhouse-port'])(
    'rejects invalid %s values via parsePositiveInt',
    async (portFlag) => {
      const program = new Command();
      program.exitOverride();
      registerPipelineCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dogsled',
          'pipeline',
          '--integration',
          'x',
          '--dest',
          portFlag === '--postgres-port'
            ? 'postgres'
            : portFlag === '--mysql-port'
              ? 'mysql'
              : 'clickhouse',
          '--format',
          'csv',
          portFlag,
          '0',
        ])
      ).rejects.toThrow();
    }
  );
});

describe('runPipeline', () => {
  const baseOptions = {
    format: 'csv',
    outputDir: './out',
    integration: 'github',
  };
  const embedConfigJson = JSON.stringify({
    provider: 'openai',
    model: 'text-embedding-3-small',
    api_key: '$OPENAI_API_KEY',
    streams: {
      repos: [{ field: 'description' }],
    },
  });

  it('spawns extractor and loader with the expected args and pipes stdout into stdin', async () => {
    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();
    const forwardedChunks: string[] = [];
    loadStdin.on('data', (chunk) => forwardedChunks.push(chunk.toString()));

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(['repos'], baseOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    extractStdout.write('protocol-line\n');
    extractStdout.end();
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    expect(forwardedChunks.join('')).toBe('protocol-line\n');
    expect(spawn.mock.calls[0]?.[0]).toBe('extract-cli');
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      'run',
      'repos',
      '--integration',
      'github',
      '--advance-state',
      '--log-format',
      'json',
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(spawn.mock.calls[1]?.[0]).toBe('load-cli');
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      'run',
      '--output-dir',
      './out',
      '--format',
      'csv',
      '--log-format',
      'json',
    ]);
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({
      stdio: ['pipe', 'inherit', 'pipe'],
    });
  });

  it('forwards --bq-access-token to loader when bqAccessToken is set', async () => {
    // Regression: the runner-side emitter for
    // `credentials_access_token`, but the pipeline command's loader
    // arg builder (`buildLoadArgs`) didn't pass `bqAccessToken`
    // through. Exercises the single-destination BQ path.
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'bigquery',
        projectId: 'proj',
        datasetId: 'ds',
        bqAccessToken: 'token-123',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toContain('--bq-access-token');
    expect(loadArgs).not.toContain('token-123');
    expect(spawn.mock.calls[1]?.[2].env.BOBSLED_CORE_LOADER_BQ_ACCESS_TOKEN).toBe('token-123');
    // Order matters for arg pairs — assert adjacency.
    const tokenIdx = loadArgs.indexOf('--bq-access-token');
    expect(loadArgs[tokenIdx + 1]).toBe('$BOBSLED_CORE_LOADER_BQ_ACCESS_TOKEN');
  });

  it('forwards Snowflake static OIDC token to the loader', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfAccessToken: 'jwt-token',
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    const loadOptions = spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(loadArgs).toEqual(
      expect.arrayContaining([
        '--sf-access-token',
        '$BOBSLED_CORE_SNOWFLAKE_ACCESS_TOKEN',
        '--sf-account',
        'acme-org',
      ])
    );
    expect(loadArgs).not.toContain('jwt-token');
    expect(loadOptions.env).toMatchObject({ BOBSLED_CORE_SNOWFLAKE_ACCESS_TOKEN: 'jwt-token' });
  });

  it('forwards only the Snowflake token command when both OIDC fields are set', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfAccessToken: 'jwt-token',
        sfTokenCommand: 'mint-snowflake-token --json',
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toContain('--sf-token-command');
    expect(loadArgs).toContain('mint-snowflake-token --json');
    expect(loadArgs).not.toContain('--sf-access-token');
  });

  it('forwards Snowflake workload identity tokens through the protected child environment', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const env = {
      SF_WIF_TOKEN: 'vercel-oidc-token',
      BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'stale-dedicated-token',
      UNRELATED_ENV: 'preserve-me',
    };
    const originalEnv = { ...env };

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfWorkloadIdentityToken: '$SF_WIF_TOKEN',
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, env }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    const loadOptions = spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(loadArgs).toContain('--sf-workload-identity-token');
    expect(loadArgs).toContain('$BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    expect(loadArgs).not.toContain('vercel-oidc-token');
    expect(loadOptions.env).toEqual(
      expect.objectContaining({
        BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'vercel-oidc-token',
        UNRELATED_ENV: 'preserve-me',
      })
    );
    const extractOptions = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(extractOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    expect(extractOptions.env).not.toHaveProperty('BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    expect(loadOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    expect(env).toEqual(originalEnv);
  });

  it('rejects a blank direct workload identity token before spawning or falling back', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;

    await expect(
      runPipeline(
        ['repos'],
        {
          ...baseOptions,
          dest: 'snowflake',
          sfAccount: 'acme-org',
          sfUsername: 'loader',
          sfWorkloadIdentityToken: '   ',
          sfWarehouse: 'compute_wh',
          sfDatabase: 'raw',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/workload identity token.*non-empty/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a programmatic Snowflake workload identity token for a local destination', async () => {
    const token = 'programmatic-local-vercel-oidc-token';
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;

    const error = await runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'local',
        sfWorkloadIdentityToken: token,
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    ).then(
      () => new Error('expected destination validation failure'),
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/workload identity token.*snowflake destination/i);
    expect((error as Error).message).not.toContain(token);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(mixedModeDestinationCases)(
    'rejects a direct programmatic workload identity token with $label named destinations',
    async ({ destinations }) => {
      const token = 'mixed-mode-programmatic-vercel-oidc-token';
      const spawn = createAutoClosingFanOutSpawn();

      const error = await runPipeline(
        ['repos'],
        {
          ...baseOptions,
          destinations,
          sfWorkloadIdentityToken: token,
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      ).then(
        () => new Error('expected mixed-mode validation failure'),
        (reason: unknown) => reason
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/workload identity token.*named destinations/i);
      expect((error as Error).message).not.toContain(token);
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects a malformed programmatic workload identity reference without exposing it', async () => {
    const malformedReference = '$VERCEL_OIDC_TOKEN.invalid-secret-fragment';
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;

    const error = await runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfWorkloadIdentityToken: malformedReference,
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    ).then(
      () => new Error('expected malformed reference validation failure'),
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(Error);
    const errorWithMetadata = error as Error & { cause?: unknown; code?: unknown };
    expect(errorWithMetadata.message).toMatch(/workload identity token.*environment variable/i);
    expect(errorWithMetadata.message).not.toContain(malformedReference);
    expect(errorWithMetadata.stack).not.toContain(malformedReference);
    expect(String(errorWithMetadata.cause)).not.toContain(malformedReference);
    expect(String(errorWithMetadata.code)).not.toContain(malformedReference);
    expect(
      JSON.stringify({
        ...errorWithMetadata,
        message: errorWithMetadata.message,
        stack: errorWithMetadata.stack,
        cause: errorWithMetadata.cause,
        code: errorWithMetadata.code,
      })
    ).not.toContain(malformedReference);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a direct workload identity password conflict before resolving its environment', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;

    await expect(
      runPipeline(
        ['repos'],
        {
          ...baseOptions,
          dest: 'snowflake',
          sfPassword: 'password-fixture',
          sfWorkloadIdentityToken: '$MISSING_WIF_TOKEN',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, env: {} }
      )
    ).rejects.toThrow(/workload identity token.*password/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a named workload identity access-token conflict before resolving its environment', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;

    await expect(
      runPipeline(
        ['repos'],
        {
          ...baseOptions,
          destinations: [
            {
              auth_env_vars: ['MISSING_ACCESS_TOKEN', 'MISSING_WIF_TOKEN'],
              name: 'warehouse',
              type: 'snowflake',
              account: 'acme-org',
              username: 'loader',
              credentials_access_token: '$MISSING_ACCESS_TOKEN',
              credentials_workload_identity_token: '$MISSING_WIF_TOKEN',
              warehouse: 'compute_wh',
              database: 'raw',
            },
          ],
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, env: {} }
      )
    ).rejects.toThrow(/workload identity token.*access token/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('removes a programmatic literal workload identity token from every non-target child', async () => {
    const extractStdout = new PassThrough();
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const extractChild = createMockChild({ stdout: extractStdout });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const token = 'programmatic-vercel-oidc-token';
    const env = {
      INHERITED_WIF_TOKEN: token,
      VERCEL_OIDC_TOKEN: token,
      BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'stale-dedicated-token',
    };

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfWorkloadIdentityToken: token,
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, env }
    );

    await waitForSpawns(spawn, 2);
    extractStdout.end();
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const extractEnv = (spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env ?? {};
    const loadEnv = (spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv }).env ?? {};
    expect(Object.values(extractEnv)).not.toContain(token);
    expect(loadEnv).toMatchObject({
      BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: token,
    });
    expect(Object.entries(loadEnv).filter(([, value]) => value === token)).toEqual([
      ['BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN', token],
    ]);
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).not.toContain(token);
  });

  it('redacts WIF tokens from single-destination loader diagnostics', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-pipeline-log-'));
    tempDirs.push(logDir);
    const logFile = path.join(logDir, 'pipeline.log');
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadStderr = new PassThrough();
    const loadChild = createMockChild({ stdin: new PassThrough(), stderr: loadStderr });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfWorkloadIdentityToken: '$SF_WIF_TOKEN',
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
        logFile,
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        env: { SF_WIF_TOKEN: 'vercel-oidc-token' },
      }
    );

    await waitForSpawns(spawn);
    loadStderr.write(
      JSON.stringify({ level: 'error', message: 'loader failed with vercel-oidc-token' }) + '\n'
    );
    loadStderr.end();
    extractChild.emit('close', 0);
    loadChild.emit('close', 7);
    await expect(promise).resolves.toBe(7);

    const output = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(output).not.toContain('vercel-oidc-token');
    expect(output).toContain('[REDACTED]');
    await vi.waitFor(() => {
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).not.toContain('vercel-oidc-token');
      expect(log).toContain('[REDACTED]');
    });
  });

  it('redacts WIF tokens from fan-out diagnostics and manifests', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-pipeline-log-'));
    tempDirs.push(logDir);
    const logFile = path.join(logDir, 'pipeline.log');
    const extractStdout = new PassThrough();
    const loadStderr = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const workloadIdentityLoadChild = createMockChild({
      stdin: new PassThrough(),
      stderr: loadStderr,
    });
    const archiveLoadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(workloadIdentityLoadChild)
      .mockReturnValueOnce(archiveLoadChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [
          {
            auth_env_vars: ['SF_WIF_TOKEN'],
            name: 'warehouse',
            type: 'snowflake',
            account: 'acme-org',
            username: 'loader',
            warehouse: 'compute_wh',
            database: 'raw',
            credentials_workload_identity_token: '$SF_WIF_TOKEN',
          },
          { name: 'archive', type: 'local', format: 'csv' },
        ],
        logFile,
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        env: { SF_WIF_TOKEN: 'vercel-oidc-token' },
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 3);
    loadStderr.write(
      JSON.stringify({ level: 'error', message: 'loader failed with vercel-oidc-token' }) + '\n'
    );
    loadStderr.end();
    workloadIdentityLoadChild.emit('close', 7);
    archiveLoadChild.emit('close', 0);

    await expect(promise).resolves.toBe(7);

    const { manifestPath, manifest } = getManifestSnapshot();
    bobsledTempDir(path.dirname(manifestPath));
    const output = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(output).not.toContain('vercel-oidc-token');
    await vi.waitFor(() => {
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).not.toContain('vercel-oidc-token');
      expect(log).toContain('[REDACTED]');
    });
    expect(JSON.stringify(manifest)).not.toContain('vercel-oidc-token');
    const destinations = manifest.destinations as Array<Record<string, unknown>>;
    expect(destinations[0]).toMatchObject({
      name: 'warehouse',
      status: 'failed',
      error: 'loader failed with [REDACTED]',
    });
  });

  it('redacts WIF tokens from direct runPipeline spawn failures', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockImplementationOnce(() => {
        throw new Error('loader spawn failed with vercel-oidc-token');
      }) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfWorkloadIdentityToken: 'vercel-oidc-token',
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', null, 'SIGTERM');

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('loader spawn failed with [REDACTED]');
    expect((error as Error).stack).not.toContain('vercel-oidc-token');
  });

  it('returns a fresh error with only sanitized metadata', async () => {
    const token = 'vercel-oidc-token';
    const sourceError = Object.assign(new Error(`loader failed with ${token}`), {
      customToken: token,
      cause: { token },
    });
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockImplementationOnce(() => {
        throw sourceError;
      }) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfWorkloadIdentityToken: token,
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', null, 'SIGTERM');

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(sourceError);
    expect(JSON.stringify(error)).not.toContain(token);
    expect((error as Error & { customToken?: string }).customToken).toBeUndefined();
    expect((error as Error & { cause?: unknown }).cause).toBe('[REDACTED]');
  });

  it('returns a fresh safe error for thrown plain objects', async () => {
    const token = 'vercel-oidc-token';
    const sourceError = {
      message: `loader failed with ${token}`,
      code: `ERR_WIF_${token}`,
      customToken: token,
    };
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockImplementationOnce(() => {
        throw sourceError;
      }) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfWorkloadIdentityToken: token,
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', null, 'SIGTERM');

    const error = await promise.catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(sourceError);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error).not.toHaveProperty('code');
    expect(error).not.toHaveProperty('customToken');
  });

  it('rejects conflicting direct Snowflake authentication before spawning', async () => {
    const spawn = vi.fn() as Mock;

    await expect(
      runPipeline(
        ['repos'],
        {
          ...baseOptions,
          dest: 'snowflake',
          sfAccount: 'acme-org',
          sfUsername: 'loader',
          sfWorkloadIdentityToken: 'wif-token',
          sfTokenCommand: 'mint-snowflake-token --json',
          sfAccessToken: 'oauth-token',
          sfWarehouse: 'compute_wh',
          sfDatabase: 'raw',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/workload identity.*token command.*access token/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('forwards --bq-token-command to loader when bqTokenCommand is set', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'bigquery',
        projectId: 'proj',
        datasetId: 'ds',
        bqTokenCommand: 'mint-token --json',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    const cmdIdx = loadArgs.indexOf('--bq-token-command');
    expect(cmdIdx).toBeGreaterThanOrEqual(0);
    expect(loadArgs[cmdIdx + 1]).toBe('mint-token --json');
  });

  it('emits only --bq-token-command when both token fields are set (precedence)', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        dest: 'bigquery',
        projectId: 'proj',
        datasetId: 'ds',
        bqAccessToken: 'token-123',
        bqTokenCommand: 'mint-token --json',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toContain('--bq-token-command');
    expect(loadArgs).not.toContain('--bq-access-token');
  });

  it('spawns the embedder between extract and load when embed config is present', async () => {
    const extractStdout = new PassThrough();
    const embedStdin = new PassThrough();
    const embedStdout = new PassThrough();
    const loadStdin = new PassThrough();
    const extractToEmbed: string[] = [];
    const embedToLoad: string[] = [];
    embedStdin.on('data', (chunk) => extractToEmbed.push(chunk.toString()));
    loadStdin.on('data', (chunk) => embedToLoad.push(chunk.toString()));

    const extractChild = createMockChild({ stdout: extractStdout });
    const embedChild = createMockChild({ stdin: embedStdin, stdout: embedStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(embedChild)
      .mockReturnValueOnce(loadChild) as Mock;
    const env = {
      SF_WIF_TOKEN: 'vercel-oidc-token',
      BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'stale-dedicated-token',
    };

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        embedConfigJson,
        workloadIdentitySourceEnvNames: ['SF_WIF_TOKEN'],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        env,
      }
    );

    await waitForSpawns(spawn, 3);
    extractStdout.write('raw-line\n');
    extractStdout.end();
    embedStdout.write('enriched-line\n');
    embedStdout.end();
    extractChild.emit('close', 0);
    embedChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    expect(extractToEmbed.join('')).toBe('raw-line\n');
    expect(embedToLoad.join('')).toBe('enriched-line\n');
    expect(spawn.mock.calls[0]?.[0]).toBe('extract-cli');
    expect(spawn.mock.calls[1]?.[0]).toBe('embed-cli');
    const embedArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(embedArgs[0]).toBe('run');
    expect(embedArgs[1]).toBe('--config');
    expect(embedArgs[2]).toBeDefined();
    expect(path.basename(embedArgs[2]!)).toBe('embed-config.json');
    expect(embedArgs.slice(3)).toEqual(['--log-format', 'json']);
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
      env: expect.objectContaining({
        BOBSLED_CORE_EMBEDDER_TMP_DIR: expect.stringMatching(/bobsled-embed-/),
      }),
    });
    const embedOptions = spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(embedOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    expect(embedOptions.env).not.toHaveProperty('BOBSLED_CORE_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    expect(spawn.mock.calls[2]?.[0]).toBe('load-cli');
  });

  it('passes --embed-config-file to the extractor when --emit-model-spec-source is set with an embed block', async () => {
    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const embedChild = createMockChild({ stdin: new PassThrough(), stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(embedChild)
      .mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        embedConfigJson,
        emitModelSpecSource: true,
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 3);
    extractStdout.end();
    extractChild.emit('close', 0);
    embedChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toContain('--emit-model-spec-source');
    const embedConfigFileIndex = extractArgs.indexOf('--embed-config-file');
    expect(embedConfigFileIndex).toBeGreaterThanOrEqual(0);
    const configPath = extractArgs[embedConfigFileIndex + 1];
    expect(configPath).toBeDefined();
    expect(path.basename(configPath!)).toBe('embed-config.json');
  });

  it('omits --embed-config-file when --emit-model-spec-source is set but no embed block is configured', async () => {
    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      { ...baseOptions, emitModelSpecSource: true },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 2);
    extractStdout.end();
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toContain('--emit-model-spec-source');
    expect(extractArgs).not.toContain('--embed-config-file');
  });

  it('forwards output flags to the embedder subprocess', async () => {
    const extractStdout = new PassThrough();
    const embedStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const embedChild = createMockChild({ stdin: new PassThrough(), stdout: embedStdout });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(embedChild)
      .mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        embedConfigJson,
        verbose: true,
        quiet: true,
        logFormat: 'pretty',
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 3);
    extractStdout.end();
    embedStdout.end();
    extractChild.emit('close', 0);
    embedChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      'run',
      '--config',
      expect.any(String),
      '--verbose',
      '--log-format',
      'json',
    ]);
  });

  it('accepts a literal api key in --embed-config-json for direct CLI runs', async () => {
    const extractStdout = new PassThrough();
    const embedStdin = new PassThrough();
    const embedStdout = new PassThrough();
    const loadStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const embedChild = createMockChild({ stdin: embedStdin, stdout: embedStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(embedChild)
      .mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        embedConfigJson: JSON.stringify({
          provider: 'openai',
          model: 'text-embedding-3-small',
          api_key: 'stub-key',
          streams: {
            repos: [{ field: 'description' }],
          },
        }),
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 3);
    const embedArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(embedArgs[0]).toBe('run');
    expect(embedArgs[1]).toBe('--config');
    expect(embedArgs[2]).toBeDefined();
    const configPath = embedArgs[2];
    if (!configPath) {
      throw new Error('expected embed config path');
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({
      api_key: 'stub-key',
      model: 'text-embedding-3-small',
      provider: 'openai',
    });
    extractStdout.end();
    embedStdout.end();
    extractChild.emit('close', 0);
    embedChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    expect(spawn.mock.calls[1]?.[0]).toBe('embed-cli');
    expect(fs.existsSync(path.dirname(configPath))).toBe(false);
  });

  it('returns the extractor exit code when extraction fails', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline([], baseOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    extractChild.emit('close', 7);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toBe(7);
  });

  it('returns the loader exit code when extraction succeeds and load fails', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline([], baseOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 9);

    await expect(promise).resolves.toBe(9);
  });

  it('does not kill the loader when the extractor exits (loader finishes via pipe EOF)', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline([], baseOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    // The loader should NOT be killed — it finishes via pipe EOF
    expect(loadChild.kill).not.toHaveBeenCalled();

    loadChild.emit('close', 0);
    await promise;
  });

  it('kills the extractor when the loader exits first', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline([], baseOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    loadChild.emit('close', 1);
    expect(extractChild.kill).toHaveBeenCalledWith('SIGTERM');

    extractChild.emit('close', 0);
    await promise;
  });

  it('throws when extract stdout or load stdin is null', async () => {
    const extractChild = createMockChild({ stdout: null });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline([], baseOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });
    await waitForSpawns(spawn);
    expect(extractChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(loadChild.kill).toHaveBeenCalledWith('SIGTERM');
    extractChild.emit('close', null, 'SIGTERM');
    loadChild.emit('close', null, 'SIGTERM');

    await expect(promise).rejects.toThrow('Unable to create the extract/load pipeline.');
  });

  it('passes all extract options through to the spawned command', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const fullOptions = {
      ...baseOptions,
      fullRefresh: true,
      batch: true,
      batchFormat: 'parquet',
      emitModelSpecSource: true,
      batchSize: 500,
      verbose: true,
      quiet: true,
      logFormat: 'json',
      input: ['key1=val1', 'key2=val2'],
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    };

    const promise = runPipeline(['users', 'repos'], fullOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await promise;

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toContain('--full-refresh');
    expect(extractArgs).toContain('--batch');
    const batchFormatIndex = extractArgs.indexOf('--batch-format');
    expect(batchFormatIndex).toBeGreaterThanOrEqual(0);
    expect(extractArgs[batchFormatIndex + 1]).toBe('parquet');
    expect(extractArgs).toContain('--emit-model-spec-source');
    expect(extractArgs).toContain('--advance-state');
    expect(extractArgs).toContain('--batch-size');
    expect(extractArgs).toContain('500');
    expect(extractArgs).toContain('--verbose');
    expect(extractArgs).not.toContain('--quiet');
    expect(extractArgs).toContain('--log-format');
    expect(extractArgs).toContain('json');
    expect(extractArgs).toContain('--input');
    expect(extractArgs).toContain('key1=val1');
    expect(extractArgs).toContain('key2=val2');
    expect(extractArgs).toContain('start_date=2026-03-01');
    expect(extractArgs).toContain('end_date=2026-03-31');
    expect(extractArgs).toContain('users');
    expect(extractArgs).toContain('repos');
  });

  it('implies full refresh when a backfill start date is provided', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        startDate: '2026-03-01',
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await promise;

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toContain('--full-refresh');
    expect(extractArgs).toContain('start_date=2026-03-01');
  });

  it('implies full refresh when only a backfill end date is provided', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        endDate: '2026-03-31',
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await promise;

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toContain('--full-refresh');
    expect(extractArgs).toContain('end_date=2026-03-31');
  });

  it('passes all load options through to the spawned command', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const fullOptions = {
      ...baseOptions,
      dest: 'gcs',
      gcsBucket: 'my-bucket',
      gcsPrefix: 'prefix/',
      bufferSize: 1000,
    };

    const promise = runPipeline([], fullOptions, {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await promise;

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toContain('--dest');
    expect(loadArgs).toContain('gcs');
    expect(loadArgs).toContain('--gcs-bucket');
    expect(loadArgs).toContain('my-bucket');
    expect(loadArgs).toContain('--gcs-prefix');
    expect(loadArgs).toContain('prefix/');
    expect(loadArgs).toContain('--buffer-size');
    expect(loadArgs).toContain('1000');
  });

  it('requires --format for the default local destination', async () => {
    const spawn = vi.fn() as Mock;

    await expect(
      runPipeline(
        [],
        {
          outputDir: './out',
          integration: 'github',
        },
        {
          metaUrl: 'file:///dogsled/tests/mock.ts',
          spawn,
        }
      )
    ).rejects.toThrow('The --format option is required for local, gcs, and s3 destinations.');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires --format for gcs destinations', async () => {
    const spawn = vi.fn() as Mock;

    await expect(
      runPipeline(
        [],
        {
          outputDir: './out',
          integration: 'github',
          dest: 'gcs',
          gcsBucket: 'my-bucket',
        },
        {
          metaUrl: 'file:///dogsled/tests/mock.ts',
          spawn,
        }
      )
    ).rejects.toThrow('The --format option is required for local, gcs, and s3 destinations.');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('omits --format for duckdb destinations', async () => {
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        dest: 'duckdb',
        dbPath: './demo.duckdb',
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await promise;

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toContain('--dest');
    expect(loadArgs).toContain('duckdb');
    expect(loadArgs).not.toContain('--format');
    expect(loadArgs).not.toContain('csv');
  });

  it.each([
    [
      'snowflake',
      {
        ...baseOptions,
        dest: 'snowflake',
        sfAccount: 'acme-org',
        sfUsername: 'loader',
        sfPassword: '$SF_PASSWORD',
        sfPrivateKeyPath: './keys/snowflake.p8',
        sfPrivateKeyPassphrase: '$SF_KEY_PASSPHRASE',
        sfWarehouse: 'compute_wh',
        sfDatabase: 'raw',
        sfRole: 'transformer',
        targetSchema: 'analytics',
      },
      [
        '--dest',
        'snowflake',
        '--sf-account',
        'acme-org',
        '--sf-username',
        'loader',
        '--sf-password',
        '$SF_PASSWORD',
        '--sf-private-key-path',
        './keys/snowflake.p8',
        '--sf-private-key-passphrase',
        '$SF_KEY_PASSPHRASE',
        '--sf-warehouse',
        'compute_wh',
        '--sf-database',
        'raw',
        '--sf-role',
        'transformer',
        '--target-schema',
        'analytics',
      ],
    ],
    [
      'postgres',
      {
        ...baseOptions,
        dest: 'postgres',
        postgresHost: 'db.example.com',
        postgresPort: 5432,
        postgresDatabase: 'warehouse',
        postgresSchema: 'raw',
        postgresUser: 'loader',
        postgresPassword: '$PG_PASSWORD',
        postgresSsl: true,
      },
      [
        '--dest',
        'postgres',
        '--postgres-host',
        'db.example.com',
        '--postgres-port',
        '5432',
        '--postgres-database',
        'warehouse',
        '--postgres-schema',
        'raw',
        '--postgres-user',
        'loader',
        '--postgres-password',
        '$PG_PASSWORD',
        '--postgres-ssl',
      ],
    ],
    [
      'mysql',
      {
        ...baseOptions,
        dest: 'mysql',
        mysqlHost: 'mysql.example.com',
        mysqlPort: 3306,
        mysqlDatabase: 'warehouse',
        mysqlUser: 'loader',
        mysqlPassword: '$MYSQL_PASSWORD',
        mysqlSsl: true,
      },
      [
        '--dest',
        'mysql',
        '--mysql-host',
        'mysql.example.com',
        '--mysql-port',
        '3306',
        '--mysql-database',
        'warehouse',
        '--mysql-user',
        'loader',
        '--mysql-password',
        '$MYSQL_PASSWORD',
        '--mysql-ssl',
      ],
    ],
    [
      'clickhouse',
      {
        ...baseOptions,
        dest: 'clickhouse',
        clickhouseHost: 'ch.example.com',
        clickhousePort: 8443,
        clickhouseDatabase: 'warehouse',
        clickhouseUsername: 'default',
        clickhousePassword: '$CLICKHOUSE_PASSWORD',
        clickhouseSsl: true,
      },
      [
        '--dest',
        'clickhouse',
        '--clickhouse-host',
        'ch.example.com',
        '--clickhouse-port',
        '8443',
        '--clickhouse-database',
        'warehouse',
        '--clickhouse-username',
        'default',
        '--clickhouse-password',
        '$CLICKHOUSE_PASSWORD',
        '--clickhouse-ssl',
      ],
    ],
    [
      'turbopuffer',
      {
        ...baseOptions,
        dest: 'turbopuffer',
        turbopufferApiKey: '$TURBOPUFFER_API_KEY',
        turbopufferRegion: 'gcp-us-central1',
        turbopufferNamespacePrefix: 'app_',
        turbopufferDistanceMetric: 'euclidean_squared',
        turbopufferFullTextColumns: 'title,body',
      },
      [
        '--dest',
        'turbopuffer',
        '--turbopuffer-api-key',
        '$TURBOPUFFER_API_KEY',
        '--turbopuffer-region',
        'gcp-us-central1',
        '--turbopuffer-namespace-prefix',
        'app_',
        '--turbopuffer-distance-metric',
        'euclidean_squared',
        '--turbopuffer-full-text-columns',
        'title,body',
      ],
    ],
  ])(
    'forwards %s destination args to the loader subprocess',
    async (_name, options, expectedArgs) => {
      const extractChild = createMockChild({ stdout: new PassThrough() });
      const loadChild = createMockChild({ stdin: new PassThrough() });
      const spawn = vi
        .fn()
        .mockReturnValueOnce(extractChild)
        .mockReturnValueOnce(loadChild) as Mock;

      const promise = runPipeline([], options, {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        env: {
          SF_PASSWORD: 'sf-secret',
          SF_KEY_PASSPHRASE: 'sf-passphrase',
          PG_PASSWORD: 'pg-secret',
          MYSQL_PASSWORD: 'mysql-secret',
          CLICKHOUSE_PASSWORD: 'ch-secret',
          TURBOPUFFER_API_KEY: 'tp-secret',
        },
      });

      await waitForSpawns(spawn);
      extractChild.emit('close', 0);
      loadChild.emit('close', 0);
      await promise;

      const loadArgs = spawn.mock.calls[1]?.[1] as string[];
      expect(loadArgs).toEqual(
        expect.arrayContaining(
          expectedArgs.map((value, index) => {
            const flag = expectedArgs[index - 1];
            return flag &&
              [
                '--sf-password',
                '--sf-private-key-passphrase',
                '--postgres-password',
                '--mysql-password',
                '--clickhouse-password',
                '--turbopuffer-api-key',
              ].includes(flag)
              ? '$BOBSLED_CORE_LOADER_' + flag.slice(2).replaceAll('-', '_').toUpperCase()
              : value;
          })
        )
      );
      expect(loadArgs).not.toContain('--format');
      expect(loadArgs).not.toContain('csv');
    }
  );

  it('fans out one captured extraction into multiple loaders before committing state', async () => {
    const extractStdout = new PassThrough();
    const loadOneStdin = new PassThrough();
    const loadTwoStdin = new PassThrough();
    const forwardedOne: string[] = [];
    const forwardedTwo: string[] = [];
    loadOneStdin.on('data', (chunk) => forwardedOne.push(chunk.toString()));
    loadTwoStdin.on('data', (chunk) => forwardedTwo.push(chunk.toString()));

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneChild = createMockChild({ stdin: loadOneStdin });
    const loadTwoChild = createMockChild({ stdin: loadTwoStdin });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        pipelineName: 'stripe',
        destinations: [
          {
            name: 'warehouse',
            type: 'local',
            format: 'csv',
            load_strategy: 'append',
          },
          {
            name: 'archive',
            type: 'local',
            format: 'csv',
            table_prefix: 'archive__',
          },
        ],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    await vi.waitFor(() => {
      expect(forwardedOne.join('')).toContain('"type":"STATE"');
      expect(forwardedTwo.join('')).toContain('"type":"STATE"');
    });
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);

    await waitForSpawns(spawn, 4);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    expect(spawn.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        'run',
        '--output-dir',
        './out',
        '--dest',
        'local',
        '--format',
        'csv',
        '--load-strategy',
        'append',
      ])
    );
    expect(spawn.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        'run',
        '--output-dir',
        './out',
        '--dest',
        'local',
        '--format',
        'csv',
        '--table-prefix',
        'archive__',
      ])
    );
    expect(spawn.mock.calls[0]?.[1]).toContain('--no-state-write');
    expect(spawn.mock.calls[3]?.[1]).toEqual([
      'commit-state',
      '--integration',
      'github',
      '--capture-file',
      expect.any(String),
      '--log-format',
      'json',
    ]);
  });

  it('does not commit truncated state after a bounded multi-destination preview', async () => {
    const extractStdout = new PassThrough();
    const loadOneChild = createMockChild({ stdin: new PassThrough() });
    const loadTwoChild = createMockChild({ stdin: new PassThrough() });
    const extractChild = createMockChild({ stdout: extractStdout });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        limit: 10,
        destinations: [
          { name: 'warehouse', type: 'local', format: 'csv' },
          { name: 'archive', type: 'local', format: 'csv' },
        ],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":10}}\n');
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 3);
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--limit', '10']));
    expect(spawn.mock.calls.flatMap((call) => call[1] as string[])).not.toContain('commit-state');
  });

  it('publishes current destination load progress before the loader completes', async () => {
    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const loadStderr = new PassThrough();
    const loadChild = createMockChild({ stdin: new PassThrough(), stderr: loadStderr });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadChild)
      .mockReturnValueOnce(commitChild) as Mock;
    const observedRows: number[] = [];

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        onSummary(stage, summary) {
          if (stage === 'load') {
            observedRows.push(buildPipelineSummaryMessage(summary, 'github').total_rows_loaded);
          }
        },
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 2);
    loadStderr.write('{"level":"info","event":"repos: loaded 2 rows","loadMs":4}\n');
    await vi.waitFor(() => expect(observedRows).toContain(2));
    loadStderr.end();
    loadChild.emit('close', 0);
    await waitForSpawns(spawn, 3);
    commitChild.emit('close', 0);
    await expect(promise).resolves.toBe(0);
  });

  it('runs the embedder once before multi-destination replay and cleans up temp files on success', async () => {
    const extractStdout = new PassThrough();
    const embedStdin = new PassThrough();
    const embedStdout = new PassThrough();
    const loadOneStdin = new PassThrough();
    const loadTwoStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const embedChild = createMockChild({ stdin: embedStdin, stdout: embedStdout });
    const loadOneChild = createMockChild({ stdin: loadOneStdin });
    const loadTwoChild = createMockChild({ stdin: loadTwoStdin });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(embedChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        pipelineName: 'github',
        embedConfigJson,
        destinations: [
          {
            name: 'duckdb',
            type: 'duckdb',
            db_path: './one.duckdb',
          },
          {
            name: 'postgres',
            type: 'postgres',
            host: 'db.example.com',
            database: 'analytics',
            username: 'loader',
          },
        ],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 2);
    extractStdout.write('raw-line\n');
    extractStdout.end();
    embedStdout.write('enriched-line\n');
    embedStdout.end();
    extractChild.emit('close', 0);
    embedChild.emit('close', 0);
    await waitForSpawns(spawn, 4);
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);
    await waitForSpawns(spawn, 5);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    const embedTmpDir = (spawn.mock.calls[1]?.[2] as { env: NodeJS.ProcessEnv }).env[
      'BOBSLED_CORE_EMBEDDER_TMP_DIR'
    ];
    expect(embedTmpDir).toBeDefined();
    if (!embedTmpDir) {
      throw new Error('expected embed temp dir');
    }
    expect(
      spawn.mock.calls.filter((call) => call[0] === 'embed-cli' && call[1][0] === 'run')
    ).toHaveLength(1);
    expect(embedTmpDir).toMatch(/bobsled-embed-/);
    expect(fs.existsSync(embedTmpDir)).toBe(false);
  });

  it('retains embedder temp files when a multi-destination load fails', async () => {
    const extractStdout = new PassThrough();
    const embedStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const embedChild = createMockChild({ stdin: new PassThrough(), stdout: embedStdout });
    const loadOneChild = createMockChild({ stdin: new PassThrough() });
    const loadTwoChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(embedChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        embedConfigJson,
        destinations: [
          {
            name: 'duckdb',
            type: 'duckdb',
            db_path: './one.duckdb',
          },
          {
            name: 'postgres',
            type: 'postgres',
            host: 'db.example.com',
            database: 'analytics',
            username: 'loader',
          },
        ],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 2);
    extractStdout.write('raw-line\n');
    extractStdout.end();
    embedStdout.write('enriched-line\n');
    embedStdout.end();
    extractChild.emit('close', 0);
    embedChild.emit('close', 0);
    await waitForSpawns(spawn, 4);
    loadOneChild.emit('close', 1);
    loadTwoChild.emit('close', 0);

    await expect(promise).resolves.toBe(1);
    const embedTmpDir = (spawn.mock.calls[1]?.[2] as { env: NodeJS.ProcessEnv }).env[
      'BOBSLED_CORE_EMBEDDER_TMP_DIR'
    ];
    expect(embedTmpDir).toBeDefined();
    if (!embedTmpDir) {
      throw new Error('expected embed temp dir');
    }
    expect(embedTmpDir).toMatch(/bobsled-embed-/);
    expect(fs.existsSync(embedTmpDir)).toBe(true);
    expect(fs.existsSync(path.join(embedTmpDir, 'embed-config.json'))).toBe(true);
    fs.rmSync(embedTmpDir, { recursive: true, force: true });
  });

  it('resolves $VARNAME env placeholders for destinations parsed from --destinations-json', async () => {
    const originalArchiveBucket = process.env.ARCHIVE_BUCKET;
    const originalArchivePrefix = process.env.ARCHIVE_PREFIX;
    process.env.ARCHIVE_BUCKET = 'resolved-archive-bucket';
    process.env.ARCHIVE_PREFIX = 'resolved/archive-prefix';

    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadChild)
      .mockReturnValueOnce(commitChild) as Mock;

    try {
      const promise = runPipeline(
        ['repos'],
        {
          ...baseOptions,
          pipelineName: 'github',
          destinationsJson: JSON.stringify([
            {
              auth_env_vars: ['ARCHIVE_BUCKET', 'ARCHIVE_PREFIX'],
              name: 'archive',
              type: 's3',
              format: 'csv',
              bucket: '$ARCHIVE_BUCKET',
              prefix: '$ARCHIVE_PREFIX',
            },
          ]),
        },
        {
          metaUrl: 'file:///dogsled/tests/mock.ts',
          spawn,
        }
      );

      await waitForSpawns(spawn, 1);
      extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
      extractStdout.end();
      extractChild.emit('close', 0);

      await waitForSpawns(spawn, 2);
      expect(spawn.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([
          'run',
          '--output-dir',
          './out',
          '--dest',
          's3',
          '--format',
          'csv',
          '--s3-bucket',
          'resolved-archive-bucket',
          '--s3-prefix',
          'resolved/archive-prefix',
        ])
      );

      loadChild.emit('close', 0);
      await waitForSpawns(spawn, 3);
      commitChild.emit('close', 0);

      await expect(promise).resolves.toBe(0);
    } finally {
      if (originalArchiveBucket === undefined) {
        delete process.env.ARCHIVE_BUCKET;
      } else {
        process.env.ARCHIVE_BUCKET = originalArchiveBucket;
      }
      if (originalArchivePrefix === undefined) {
        delete process.env.ARCHIVE_PREFIX;
      } else {
        process.env.ARCHIVE_PREFIX = originalArchivePrefix;
      }
    }
  });

  it('resolves ${{ env.VARNAME }} env placeholders for destinations parsed from --destinations-json', async () => {
    const originalArchiveBucket = process.env.ARCHIVE_BUCKET;
    const originalArchivePrefix = process.env.ARCHIVE_PREFIX;
    process.env.ARCHIVE_BUCKET = 'resolved-archive-bucket';
    process.env.ARCHIVE_PREFIX = 'resolved/archive-prefix';

    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadChild)
      .mockReturnValueOnce(commitChild) as Mock;

    try {
      const promise = runPipeline(
        ['repos'],
        {
          ...baseOptions,
          pipelineName: 'github',
          destinationsJson: JSON.stringify([
            {
              auth_env_vars: ['ARCHIVE_BUCKET', 'ARCHIVE_PREFIX'],
              name: 'archive',
              type: 's3',
              format: 'csv',
              bucket: '${{ env.ARCHIVE_BUCKET }}',
              prefix: '${{ env.ARCHIVE_PREFIX }}',
            },
          ]),
        },
        {
          metaUrl: 'file:///dogsled/tests/mock.ts',
          spawn,
        }
      );

      await waitForSpawns(spawn, 1);
      extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
      extractStdout.end();
      extractChild.emit('close', 0);

      await waitForSpawns(spawn, 2);
      expect(spawn.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([
          'run',
          '--output-dir',
          './out',
          '--dest',
          's3',
          '--format',
          'csv',
          '--s3-bucket',
          'resolved-archive-bucket',
          '--s3-prefix',
          'resolved/archive-prefix',
        ])
      );

      loadChild.emit('close', 0);
      await waitForSpawns(spawn, 3);
      commitChild.emit('close', 0);

      await expect(promise).resolves.toBe(0);
    } finally {
      if (originalArchiveBucket === undefined) {
        delete process.env.ARCHIVE_BUCKET;
      } else {
        process.env.ARCHIVE_BUCKET = originalArchiveBucket;
      }
      if (originalArchivePrefix === undefined) {
        delete process.env.ARCHIVE_PREFIX;
      } else {
        process.env.ARCHIVE_PREFIX = originalArchivePrefix;
      }
    }
  });

  it('returns the failing destination exit code without committing state', async () => {
    const extractStdout = new PassThrough();
    const loadOneStdin = new PassThrough();
    const loadTwoStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneChild = createMockChild({ stdin: loadOneStdin });
    const loadTwoChild = createMockChild({ stdin: loadTwoStdin });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [
          { name: 'warehouse', type: 'local', format: 'csv' },
          { name: 'archive', type: 'local', format: 'csv' },
        ],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 7);

    await expect(promise).resolves.toBe(7);
    bobsledTempDir(path.dirname(getManifestSnapshot().manifestPath));
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('flushes partial multi-destination loader stderr lines and preserves JSON logs', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();
    const loadStderr = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin, stderr: loadStderr });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        logFormat: 'json',
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 2);
    loadStderr.write('{"level":"info","event":"repos: loaded 2 rows"}');
    loadStderr.end();
    loadChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);

    const output = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('"destination":"warehouse"');
    expect(output).toContain('"event":"repos: loaded 2 rows"');

    stderrWrite.mockRestore();
  });

  it('terminates started loaders when fan-out setup fails before replay wiring completes', async () => {
    const extractStdout = new PassThrough();
    const loadOneStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneChild = createMockChild({ stdin: loadOneStdin });
    const loadTwoChild = createMockChild({ stdin: null });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [
          { name: 'warehouse', type: 'local', format: 'csv' },
          { name: 'archive', type: 'local', format: 'csv' },
        ],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    await vi.waitFor(() => {
      expect(loadOneChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(loadTwoChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    loadOneChild.emit('close', 143);
    loadTwoChild.emit('close', 143);

    await expect(promise).rejects.toThrow(
      'Unable to create loader stdin for destination "archive".'
    );
    bobsledTempDir(path.dirname(getManifestSnapshot().manifestPath));
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('writes a manifest with per-destination rows and deletes the capture dir on success', async () => {
    const extractStdout = new PassThrough();
    const loadOneStdin = new PassThrough();
    const loadOneStderr = new PassThrough();
    const loadTwoStdin = new PassThrough();
    const loadTwoStderr = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneChild = createMockChild({ stdin: loadOneStdin, stderr: loadOneStderr });
    const loadTwoChild = createMockChild({ stdin: loadTwoStdin, stderr: loadTwoStderr });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runPipeline(
      ['repos'],
      {
        ...baseOptions,
        destinations: [
          { name: 'warehouse', type: 'local', format: 'csv' },
          { name: 'archive', type: 'local', format: 'csv', table_prefix: 'archive__' },
        ],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.write('{"_v":1,"type":"STATE","stream":"repos","value":{"record_count":1}}\n');
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    loadOneStderr.write('{"level":"info","event":"repos: loaded 1 rows","loadMs":4}\n');
    loadOneStderr.end();
    loadTwoStderr.write('{"level":"info","event":"archive__repos: loaded 1 rows","loadMs":5}\n');
    loadTwoStderr.end();
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);

    await waitForSpawns(spawn, 4);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    const { manifestPath, manifest } = getManifestSnapshot();
    expect(fs.existsSync(path.dirname(manifestPath))).toBe(false);
    expect(manifest).toMatchObject({
      integration: 'github',
      commit_state: { status: 'success', exit_code: 0 },
      extractor_exit_code: 0,
      destinations: [
        {
          name: 'warehouse',
          status: 'success',
          exit_code: 0,
          rows_loaded: { repos: 1 },
        },
        {
          name: 'archive',
          status: 'success',
          exit_code: 0,
          rows_loaded: { repos: 1 },
        },
      ],
    });
    expect(manifestWrites).toHaveLength(4);
    const intermediateDestinations = getManifestSnapshot(1).manifest.destinations as Array<
      Record<string, unknown>
    >;
    expect(intermediateDestinations).toHaveLength(2);
    expect(intermediateDestinations.map((destination) => destination.name).sort()).toEqual([
      'archive',
      'warehouse',
    ]);
    expect(intermediateDestinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'success',
          exit_code: 0,
          rows_loaded: { repos: 1 },
        }),
        expect.objectContaining({
          status: 'pending',
        }),
      ])
    );
  });

  it('records skipped state commit when cancellation lands after loading but before commit', async () => {
    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const controller = new AbortController();

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
        signal: controller.signal,
        onStage(stage, status) {
          if (stage === 'load' && status === 'completed') controller.abort();
        },
      }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 2);
    loadChild.emit('close', 0);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const { manifestPath, manifest } = getManifestSnapshot();
    bobsledTempDir(path.dirname(manifestPath));
    expect(manifest).toMatchObject({ commit_state: { status: 'skipped' } });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('preserves the capture dir and records per-destination manifest status on partial failure', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const extractStdout = new PassThrough();
    const loadOneStdin = new PassThrough();
    const loadOneStderr = new PassThrough();
    const loadTwoStdin = new PassThrough();
    const loadTwoStderr = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneChild = createMockChild({ stdin: loadOneStdin, stderr: loadOneStderr });
    const loadTwoChild = createMockChild({ stdin: loadTwoStdin, stderr: loadTwoStderr });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [
          { name: 'warehouse', type: 'local', format: 'csv' },
          { name: 'archive', type: 'local', format: 'csv' },
        ],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    loadOneStderr.write('{"level":"info","event":"repos: loaded 1 rows","loadMs":4}\n');
    loadOneStderr.end();
    loadTwoStderr.write('{"level":"error","message":"archive load failed"}\n');
    loadTwoStderr.end();
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 7);

    await expect(promise).resolves.toBe(7);

    const { manifestPath, manifest } = getManifestSnapshot();
    const captureDir = bobsledTempDir(path.dirname(manifestPath));
    const output = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(fs.existsSync(captureDir)).toBe(true);
    expect(fs.statSync(captureDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(captureDir, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(manifest).toMatchObject({
      commit_state: { status: 'skipped' },
      extractor_exit_code: 0,
      destinations: [
        {
          name: 'warehouse',
          status: 'success',
          exit_code: 0,
          rows_loaded: { repos: 1 },
        },
        {
          name: 'archive',
          status: 'failed',
          exit_code: 7,
          error: 'archive load failed',
        },
      ],
    });
    expect(output).toContain(`Capture preserved at ${captureDir}`);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('records killed status in the manifest when a loader exits from SIGTERM', async () => {
    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 2);
    loadChild.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toBe(143);

    const { manifestPath, manifest } = getManifestSnapshot();
    bobsledTempDir(path.dirname(manifestPath));
    expect(manifest).toMatchObject({
      commit_state: { status: 'skipped' },
      destinations: [{ name: 'warehouse', status: 'killed', exit_code: 143 }],
    });
  });

  it('removes raw captures on fan-out failure when preservation is disabled', async () => {
    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        preserveCaptureOnFailure: false,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 2);
    loadChild.emit('close', 7);

    await expect(promise).resolves.toBe(7);
    const captureDir = path.dirname(getManifestSnapshot().manifestPath);
    expect(fs.existsSync(captureDir)).toBe(false);
  });

  it('records failed manifest status when a loader emits an error before close', async () => {
    const extractStdout = new PassThrough();
    const loadStdin = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout });
    const loadChild = createMockChild({ stdin: loadStdin });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 2);
    loadChild.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('spawn ENOENT');

    const { manifestPath, manifest } = getManifestSnapshot();
    const captureDir = bobsledTempDir(path.dirname(manifestPath));
    expect(fs.existsSync(captureDir)).toBe(true);
    expect(manifestWrites).toHaveLength(3);
    expect(getManifestSnapshot(1).manifest).toMatchObject({
      destinations: [{ name: 'warehouse', status: 'failed', exit_code: 1, error: 'spawn ENOENT' }],
    });
    expect(manifest).toMatchObject({
      commit_state: { status: 'skipped' },
      destinations: [{ name: 'warehouse', status: 'failed', exit_code: 1, error: 'spawn ENOENT' }],
    });
  });

  it('redacts workload identity tokens from enumerable string error codes', async () => {
    const sourceError = new Error('pipeline failed') as Error & { code?: string };
    sourceError.code = 'ERR_WIF_vercel-oidc-token';
    const spawn = vi.fn(() => {
      throw sourceError;
    }) as Mock;

    let returnedError: unknown;
    try {
      await runPipeline(
        ['repos'],
        {
          ...baseOptions,
          dest: 'snowflake',
          sfWorkloadIdentityToken: 'vercel-oidc-token',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      );
    } catch (error) {
      returnedError = error;
    }

    expect(returnedError).toBeInstanceOf(Error);
    expect(returnedError).not.toBe(sourceError);
    expect((returnedError as Error & { code?: string }).code).toBe('ERR_WIF_[REDACTED]');
    expect(JSON.stringify(returnedError)).not.toContain('vercel-oidc-token');
  });

  it('preserves ordinary string error codes during sanitization', async () => {
    const sourceError = new Error('pipeline failed') as Error & { code?: string };
    sourceError.code = 'ERR_CHILD_PROCESS';
    const spawn = vi.fn(() => {
      throw sourceError;
    }) as Mock;

    let returnedError: unknown;
    try {
      await runPipeline(
        ['repos'],
        {
          ...baseOptions,
          dest: 'snowflake',
          sfWorkloadIdentityToken: 'vercel-oidc-token',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      );
    } catch (error) {
      returnedError = error;
    }

    expect((returnedError as Error & { code?: string }).code).toBe('ERR_CHILD_PROCESS');
  });

  it('warns when extracted and loaded row counts diverge for a destination', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const getStderrOutput = () => stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    const extractStdout = new PassThrough();
    const extractStderr = new PassThrough();
    const loadStdin = new PassThrough();
    const loadStderr = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout, stderr: extractStderr });
    const loadChild = createMockChild({ stdin: loadStdin, stderr: loadStderr });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStderr.write(
      '{"_v":1,"type":"METRIC","stream":"repos","metrics":{"records_emitted":2,"api_calls":1,"duration_ms":5},"time":"2026-04-15T16:00:00.000Z"}\n'
    );
    await vi.waitFor(() => expect(getStderrOutput()).toContain('"records_emitted":2'));
    extractStderr.end();
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 2);
    loadStderr.write('{"level":"info","event":"repos: loaded 1 rows","loadMs":4}\n');
    await vi.waitFor(() => expect(getStderrOutput()).toContain('"event":"repos: loaded 1 rows"'));
    loadStderr.end();
    loadChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);

    const output = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain(
      'Destination \\"warehouse\\" loaded 1 rows for stream \\"repos\\" after extracting 2 records.'
    );
  });

  it('counts extracted records in a quiet fan-out run without showing extractor telemetry', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const getStderrOutput = () => stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    const extractStdout = new PassThrough();
    const extractStderr = new PassThrough();
    const loadOneStderr = new PassThrough();
    const loadTwoStderr = new PassThrough();

    const extractChild = createMockChild({ stdout: extractStdout, stderr: extractStderr });
    const loadOneChild = createMockChild({ stdin: new PassThrough(), stderr: loadOneStderr });
    const loadTwoChild = createMockChild({ stdin: new PassThrough(), stderr: loadTwoStderr });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runPipeline(
      ['orders'],
      {
        ...baseOptions,
        quiet: true,
        destinations: [
          { name: 'warehouse', type: 'local', format: 'csv' },
          { name: 'archive', type: 'local', format: 'jsonl' },
        ],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    expect(spawn.mock.calls[0]?.[1]).not.toContain('--quiet');
    extractStderr.write(
      '{"_v":1,"type":"LOG","level":"info","message":"Starting extraction: local_files/orders","time":"2026-04-15T16:00:00.000Z"}\n'
    );
    extractStderr.write(
      '{"_v":1,"type":"METRIC","stream":"orders","metrics":{"files_processed":1,"records_emitted":5},"time":"2026-04-15T16:00:00.000Z"}\n'
    );
    extractStderr.write(
      '{"_v":1,"type":"LOG","level":"error","message":"extractor error shown in quiet mode","time":"2026-04-15T16:00:00.000Z"}\n'
    );
    await vi.waitFor(() =>
      expect(getStderrOutput()).toContain('extractor error shown in quiet mode')
    );
    extractStderr.end();
    extractStdout.end();
    extractChild.emit('close', 0);

    await waitForSpawns(spawn, 3);
    loadOneStderr.write(
      '{"stream":"orders","rowsAffected":5,"loadMs":2,"level":"info","event":"orders: loaded 5 rows"}\n'
    );
    loadTwoStderr.write(
      '{"stream":"orders","rowsAffected":5,"loadMs":1,"level":"info","event":"orders: loaded 5 rows"}\n'
    );
    loadOneStderr.end();
    loadTwoStderr.end();
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);

    await waitForSpawns(spawn, 4);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toBe(0);
    bobsledTempDir(path.dirname(getManifestSnapshot().manifestPath));

    const output = getStderrOutput();
    expect(output).not.toContain('Starting extraction');
    expect(output).not.toContain('"type":"METRIC"');
    const summaryLine = output.split('\n').find((line) => line.includes('"PIPELINE_SUMMARY"'));
    expect(JSON.parse(summaryLine ?? '{}')).toMatchObject({
      total_records_extracted: 5,
      total_rows_loaded: 10,
      streams: { orders: { records_extracted: 5, rows_loaded: 10 } },
    });
    stderrWrite.mockRestore();
  });

  it('preserves the capture dir and manifest when extraction fails before fan-out starts', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const spawn = vi.fn().mockReturnValueOnce(extractChild) as Mock;

    const promise = runPipeline(
      [],
      {
        ...baseOptions,
        destinations: [{ name: 'warehouse', type: 'local', format: 'csv' }],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end();
    extractChild.emit('close', 4);

    await expect(promise).resolves.toBe(4);

    const { manifestPath, manifest } = getManifestSnapshot();
    const captureDir = bobsledTempDir(path.dirname(manifestPath));
    const output = stderrWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(manifest).toMatchObject({
      extractor_exit_code: 4,
      commit_state: { status: 'skipped' },
      destinations: [{ name: 'warehouse', status: 'pending' }],
    });
    expect(output).toContain(`Capture preserved at ${captureDir}`);
  });

  it('throws CommandError before spawning extractor when merge is used on a file destination', async () => {
    const spawn = vi.fn() as Mock;

    try {
      await runPipeline(
        [],
        {
          ...baseOptions,
          destinations: [
            { name: 'warehouse', type: 'local', format: 'csv', load_strategy: 'merge' },
          ],
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      );
      throw new Error('expected merge validation error');
    } catch (error) {
      expect((error as Error).message).toContain('does not support merge');
    }

    expect(spawn).not.toHaveBeenCalled();
  });
});
