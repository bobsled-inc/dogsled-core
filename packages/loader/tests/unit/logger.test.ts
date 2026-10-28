import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/runtime/logger.js';

describe('createLogger', () => {
  it('text format: info outputs [loader] prefix', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr, 'text');
    logger.info('loaded 5 rows');

    const output = stderr.read()?.toString() ?? '';
    expect(output).toBe('[loader] loaded 5 rows\n');
  });

  it('text format: warn outputs [loader] WARN prefix', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr, 'text');
    logger.warn('something bad');

    const output = stderr.read()?.toString() ?? '';
    expect(output).toBe('[loader] WARN something bad\n');
  });

  it('text format: error outputs [loader] ERROR prefix', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr, 'text');
    logger.error('fatal issue');

    const output = stderr.read()?.toString() ?? '';
    expect(output).toBe('[loader] ERROR fatal issue\n');
  });

  it('text format: includes fields as key=value pairs', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr, 'text');
    logger.info('stream loaded', { stream: 'issues', rows: 42 });

    const output = stderr.read()?.toString() ?? '';
    expect(output).toBe('[loader] stream loaded stream=issues rows=42\n');
  });

  it('json format: outputs valid JSON with level, event, ts', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr, 'json');
    logger.info('test', { count: 5 });

    const output = stderr.read()?.toString() ?? '';
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('test');
    expect(parsed.count).toBe(5);
    expect(typeof parsed.ts).toBe('string');
    // ts should be a valid ISO date
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it('json format: warn includes level=warn', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr, 'json');
    logger.warn('rate limited');

    const output = stderr.read()?.toString() ?? '';
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('warn');
    expect(parsed.event).toBe('rate limited');
  });

  it('defaults to text format', () => {
    const stderr = new PassThrough();
    const logger = createLogger(stderr);
    logger.info('hello');

    const output = stderr.read()?.toString() ?? '';
    expect(output).toBe('[loader] hello\n');
  });
});
