import { DogsledRuntimeError } from '@bobsled-inc/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  ExtractorState,
  FileResourceSpec,
  IntegrationSpec,
} from '../../../src/types/index.js';

const mocks = vi.hoisted(() => ({
  extract: vi.fn(),
}));

vi.mock('../../../src/runtime/file-storage-extractor.js', () => ({
  extractFileStorageResource: mocks.extract,
}));

import { runFileStorageResourceExtraction } from '../../../src/commands/extract-file-storage.js';

function integration(): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'local_exports',
    source_type: 'local',
    connection: { base_directory: '/tmp' },
    auth: { type: 'none' },
  } as IntegrationSpec;
}

function resource(): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'customers',
    source: { path: '*.csv', format: 'csv' },
    replication: { method: 'full_refresh' },
    output: {},
  } as FileResourceSpec;
}

function commandArgs(state: ExtractorState) {
  return {
    integration: integration(),
    resource: resource(),
    integrationName: 'local_exports',
    emitter: {} as never,
    logger: {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      log: vi.fn().mockResolvedValue(undefined),
      progress: vi.fn().mockResolvedValue(undefined),
    } as never,
    state,
    stateStore: {} as never,
    advanceState: false,
    startedAt: Date.now(),
    circuitBreaker: {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    } as never,
  };
}

describe('runFileStorageResourceExtraction runtime errors', () => {
  it('reports the stable error code without raw provider text in public fields', async () => {
    mocks.extract.mockRejectedValueOnce(
      new DogsledRuntimeError({
        kind: 'provider',
        code: 'SFTP_CONNECTION_LOST',
        operation: 'extractor.sftp.download',
        retryable: true,
        cause: new Error('read ECONNRESET sftp.internal.example.com'),
      })
    );
    const args = commandArgs({ streams: {} });
    const result = await runFileStorageResourceExtraction(args);

    expect(result).toMatchObject({
      failed: true,
      resourceResult: {
        status: 'error',
        error: 'The provider could not complete the operation.',
        error_code: 'SFTP_CONNECTION_LOST',
        failure_reason: 'transient_error',
      },
    });
    const logger = args.logger as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(logger.log).toHaveBeenCalledWith(
      'error',
      'Failed: local_exports/customers: The provider could not complete the operation.',
      undefined,
      { error_code: 'SFTP_CONNECTION_LOST' }
    );
    const [, , progress] = logger.progress!.mock.calls[0]!;
    expect(progress).toMatchObject({
      error: 'The provider could not complete the operation.',
      error_code: 'SFTP_CONNECTION_LOST',
    });
    expect(JSON.stringify(result.resourceResult)).not.toContain('ECONNRESET');
  });
});

describe('runFileStorageResourceExtraction cancellation', () => {
  it('passes a scoped signal, reports cancellation as a failed resource, and removes listeners', async () => {
    const state: ExtractorState = { streams: {} };
    let receivedSignal: AbortSignal | undefined;
    mocks.extract.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          receivedSignal = signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          process.emit('SIGTERM');
        })
    );

    const sigintListenersBefore = process.listenerCount('SIGINT');
    const sigtermListenersBefore = process.listenerCount('SIGTERM');
    const result = await runFileStorageResourceExtraction(commandArgs(state));

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ failed: true, resourceResult: { status: 'error' } });
    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
  });
});

it.skipIf(process.platform === 'win32')(
  'finishes file cleanup after one group interrupt through the launcher and delegate',
  async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const tsx = require.resolve('tsx');
    const root = await mkdtemp(join(tmpdir(), 'dogsled-interrupt-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'dist'));
    await copyFile(
      new URL('../../../../dogsled/bin/cli.mjs', import.meta.url),
      join(root, 'bin/cli.mjs')
    );
    const command = new URL('../../../src/commands/extract-file-storage.ts', import.meta.url).href;
    const runtime = new URL('../../../../dogsled/src/runtime/process.ts', import.meta.url).href;
    const extractStub = `export async function extractFileStorageResource({signal}) {
    await new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      signal.addEventListener('abort', () => setTimeout(() => {
        clearInterval(keepAlive); process.stdout.write('cleanup done\\n'); reject(signal.reason);
      }, 150), {once:true});
      process.stdout.write('ready\\n');
    });
  }`;
    await writeFile(
      join(root, 'dist/index.js'),
      `
    const {spawn} = await import('node:child_process');
    const {forwardSignals, waitForProcess} = await import(${JSON.stringify(runtime)});
    const child = spawn(process.execPath, ['--import', ${JSON.stringify(tsx)}, ${JSON.stringify(join(root, 'delegate.mjs'))}], {stdio:'inherit'});
    // Delay forwarding so the group signal and forwarded copy cannot coalesce.
    process.on('SIGINT', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50));
    const stop = forwardSignals(child);
    process.exitCode = (await waitForProcess(child, 'extract')).exitCode;
    stop();
  `
    );
    await writeFile(
      join(root, 'delegate.mjs'),
      `
    import {registerHooks} from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('/file-storage-extractor.js')) return {url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(extractStub))}, shortCircuit:true};
      return next(specifier, context);
    }});
    const {runFileStorageResourceExtraction} = await import(${JSON.stringify(command)});
    const result = await runFileStorageResourceExtraction({
      integration: {}, resource: {name:'customers'}, integrationName:'local_exports',
      emitter:{}, logger:{info:async()=>{},error:async()=>{},log:async()=>{},progress:async()=>{}},
      state:{streams:{}},stateStore:{},advanceState:false,startedAt:Date.now(),
      circuitBreaker:{recordSuccess(){},recordFailure(){}}
    });
    process.stdout.write(JSON.stringify(result));
  `
    );
    const child = spawn(process.execPath, ['--import', tsx, join(root, 'bin/cli.mjs')], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import=${tsx}` },
    });
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, 10_000);
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('close', () => reject(new Error(errors || output)));
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('ready\n')) resolve();
        });
      });
      process.kill(-child.pid!, 'SIGINT');
      expect(await exited, errors).toBe(0);
      expect(output).toContain('cleanup done');
      expect(output).toContain('"failed":true');
    } finally {
      clearTimeout(timeout);
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);

describe('runFileStorageResourceExtraction copy Resources', () => {
  it('refuses a copy that runs with --no-state-write and reads nothing', async () => {
    mocks.extract.mockClear();
    const args = commandArgs({ streams: {} });
    const result = await runFileStorageResourceExtraction({
      ...args,
      resource: {
        spec_version: '1',
        type: 'resource',
        name: 'drops',
        source: { kind: 'copy', path: 'incoming/**/*' },
        replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
      } as never,
      stateWriteDisabled: true,
    });

    expect(result).toMatchObject({
      failed: true,
      resourceResult: {
        status: 'error',
        error: expect.stringContaining('copies files, so it cannot run with --no-state-write'),
      },
    });
    expect(mocks.extract).not.toHaveBeenCalled();
  });
});
