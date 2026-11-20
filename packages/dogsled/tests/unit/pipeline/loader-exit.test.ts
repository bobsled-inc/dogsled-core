import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopStagesAfterLoaderExit } from '../../../src/commands/pipeline-control.js';
import { runProjectPipeline } from '../../../src/pipeline/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-loader-exit-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'integrations'));
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(
    path.join(root, 'integrations/files.yml'),
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
  fs.writeFileSync(
    path.join(root, 'resources/drops.yml'),
    `spec_version: '1'
type: resource
name: drops
integration: files
source:
  kind: copy
  path: incoming/**/*
replication:
  method: incremental_append
  cursor: { field: last_modified }
`
  );
  fs.writeFileSync(
    path.join(root, 'dogsled.yml'),
    `destinations:
  landing:
    type: s3
    bucket: example-bucket
    prefix: landing/
    format: parquet
pipelines:
  drops:
    schedule: manual
    source: files
    destination: landing
    resources: [drops]
`
  );
  return root;
}

type LiveChild = ChildProcess & { signals: string[] };

/** A child process that is still running. */
function liveChild(): LiveChild {
  const child = new EventEmitter() as LiveChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(String(signal));
    child.killed = true;
    return true;
  };
  return child;
}

function exit(child: LiveChild, code: number | null, signal: NodeJS.Signals | null = null): void {
  child.exitCode = code;
  child.signalCode = signal;
  (child.stdout as PassThrough).end();
  (child.stderr as PassThrough).end();
  child.emit('close', code, signal);
}

/** Runs the pipeline. The loader exits with code 2 as soon as the pipeline has started it. */
async function runWith(extractor: LiveChild, loader: LiveChild) {
  return runProjectPipeline(
    { projectRoot: makeProject(), pipelineName: 'drops', quiet: true },
    {
      spawn: (_command, args) => {
        if (args.includes('--integration')) return extractor;
        setImmediate(() => {
          // As for a real process, the loader's input closes, which stops the pipe from the
          // extractor, before the process itself is reported closed.
          const input = loader.stdin as PassThrough;
          input.once('close', () => exit(loader, 2));
          input.destroy();
        });
        return loader;
      },
    }
  );
}

/**
 * An extractor that keeps writing to its output, so its output pipe fills while the loader is
 * stuck. Like a real one, it acts on SIGTERM only when its pending write has finished.
 */
function writingExtractor(): LiveChild {
  const extractor = liveChild();
  const output = extractor.stdout as PassThrough;
  let blocked = false;
  let stopped = false;
  let terminated = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    setImmediate(() => exit(extractor, 1));
  };
  const pump = (): void => {
    for (let chunk = 0; chunk < 2000 && !stopped; chunk += 1) {
      if (!output.write('x'.repeat(1024))) {
        blocked = true;
        output.once('drain', () => {
          blocked = false;
          if (terminated) stop();
          else pump();
        });
        return;
      }
    }
  };
  extractor.kill = (signal) => {
    extractor.signals.push(String(signal));
    extractor.killed = true;
    if (signal === 'SIGKILL') {
      stopped = true;
      setImmediate(() => exit(extractor, null, 'SIGKILL'));
    } else {
      terminated = true;
      if (!blocked) stop();
    }
    return true;
  };
  setImmediate(pump);
  return extractor;
}

describe('a pipeline whose loader stops before the extractor is done', () => {
  it('reads and drops the extractor output, so an extractor blocked on a write can stop', async () => {
    const extractor = writingExtractor();
    const loader = liveChild();

    const result = await runWith(extractor, loader);

    // Without the drain it would stay blocked until the forced kill.
    expect(extractor.signals).toEqual(['SIGTERM']);
    expect(result.exitCode).not.toBe(0);
  });

  it('kills an extractor that is still running after a grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const extractor = liveChild();
    const loader = liveChild();
    const termed = new Promise<void>((resolve) => {
      extractor.kill = (signal) => {
        extractor.signals.push(String(signal));
        extractor.killed = true;
        if (signal === 'SIGTERM') resolve();
        if (signal === 'SIGKILL') setImmediate(() => exit(extractor, null, 'SIGKILL'));
        return true;
      };
    });

    const pending = runWith(extractor, loader);
    await termed;
    expect(extractor.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(extractor.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('stopStagesAfterLoaderExit', () => {
  it('drains a stage whose output goes to another stage that has stalled', async () => {
    const extractor = liveChild();
    const embedder = liveChild();
    // The embedder reads nothing, as one does when its own output has stopped.
    (extractor.stdout as PassThrough).pipe(embedder.stdin as PassThrough);
    const output = extractor.stdout as PassThrough;
    const pumpUntilStalled = async (): Promise<void> => {
      for (;;) {
        if (output.write(Buffer.alloc(4096))) continue;
        const drained = await Promise.race([
          once(output, 'drain').then(() => true),
          sleep(50).then(() => false),
        ]);
        if (!drained) return;
      }
    };
    await pumpUntilStalled();

    stopStagesAfterLoaderExit([extractor, embedder]);

    await expect(
      Promise.race([once(output, 'drain').then(() => 'drained'), sleep(1000).then(() => 'stuck')])
    ).resolves.toBe('drained');
    expect(extractor.signals).toEqual(['SIGTERM']);
    expect(embedder.signals).toEqual(['SIGTERM']);
  });

  it('is not paused again when the closed input of the loader unpipes after the call', async () => {
    const extractor = liveChild();
    const loaderInput = new PassThrough();
    (extractor.stdout as PassThrough).pipe(loaderInput);

    stopStagesAfterLoaderExit([extractor]);
    loaderInput.destroy(); // its close arrives after the loader's process is reported closed
    await sleep(10);

    expect((extractor.stdout as PassThrough).readableFlowing).toBe(true);
  });
});
