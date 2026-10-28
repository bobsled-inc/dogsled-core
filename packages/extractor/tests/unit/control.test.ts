import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlLogger } from '../../src/runtime/control.js';

import type { Writable } from 'node:stream';

class FakeWritable extends EventEmitter {
  readonly chunks: string[] = [];
  private shouldBackpressure = false;

  blockNextWrite(): void {
    this.shouldBackpressure = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (!this.shouldBackpressure) {
      return true;
    }

    this.shouldBackpressure = false;
    setTimeout(() => this.emit('drain'), 0);
    return false;
  }
}

describe('ControlLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits JSON LOG and METRIC messages by default', async () => {
    const stream = new FakeWritable();
    const logger = new ControlLogger({ logFormat: 'json', stream: stream as unknown as Writable });

    await logger.info('started');
    await logger.progress('resource_start', 'issues', { configured_limit: 10 });
    await logger.metric('issues', {
      records_emitted: 3,
      api_calls: 1,
      duration_ms: 25,
    });

    const messages = stream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages.map((message) => message.type)).toEqual(['LOG', 'LOG', 'METRIC']);
    expect(messages[1]).toMatchObject({
      event: 'progress.resource_start',
      attributes: {
        progress_event: 'resource_start',
        resource: 'issues',
        configured_limit: 10,
      },
    });
  });

  it('suppresses debug logs unless verbose is enabled', async () => {
    const quietStream = new FakeWritable();
    const quietLogger = new ControlLogger({
      logFormat: 'json',
      stream: quietStream as unknown as Writable,
    });
    await quietLogger.debug('hidden');

    const verboseStream = new FakeWritable();
    const verboseLogger = new ControlLogger({
      logFormat: 'json',
      verbose: true,
      stream: verboseStream as unknown as Writable,
    });
    await verboseLogger.debug('shown');

    expect(quietStream.chunks).toHaveLength(0);
    expect(JSON.parse(verboseStream.chunks[0]!).level).toBe('debug');
  });

  it('suppresses non-error logs and metrics in quiet mode', async () => {
    const stream = new FakeWritable();
    const logger = new ControlLogger({
      format: 'json',
      quiet: true,
      verbose: true,
      stream: stream as unknown as Writable,
    });

    await logger.info('hidden');
    await logger.debug('hidden');
    await logger.metric('issues', {
      records_emitted: 1,
      api_calls: 1,
      duration_ms: 1,
    });
    await logger.error('visible');

    expect(stream.chunks).toHaveLength(1);
    expect(JSON.parse(stream.chunks[0]!).level).toBe('error');
  });

  it('renders pretty log lines when requested', async () => {
    const stream = new FakeWritable();
    const logger = new ControlLogger({
      logFormat: 'pretty',
      stream: stream as unknown as Writable,
    });

    await logger.warn('heads up');

    expect(stream.chunks[0]).toContain('[warn] heads up');
  });

  it('waits for stderr backpressure before continuing', async () => {
    const stream = new FakeWritable();
    stream.blockNextWrite();
    const logger = new ControlLogger({ logFormat: 'json', stream: stream as unknown as Writable });

    const first = logger.info('first');
    const second = logger.info('second');

    await Promise.all([first, second]);

    expect(stream.chunks).toHaveLength(2);
    expect(stream.chunks.map((chunk) => JSON.parse(chunk).message)).toEqual(['first', 'second']);
  });
});
