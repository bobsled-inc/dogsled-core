import { normalizeAgenticInputValue } from '../../../src/runtime/agentic-input.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentExecutor } from '../../../src/runtime/cli-agentic-host.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function moduleFile(contents: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bobsled-executor-'));
  directories.push(directory);
  const file = path.join(directory, 'executor.mjs');
  await writeFile(file, contents);
  return file;
}
describe('local agent executor modules', () => {
  it('loads the named contract without running an assignment', async () => {
    const executor = await loadAgentExecutor(
      await moduleFile('export async function executeAgent(request) { return request; }')
    );
    expect(typeof executor).toBe('function');
  });
  it('rejects a default-only export', async () => {
    await expect(
      loadAgentExecutor(await moduleFile('export default async function() {}'))
    ).rejects.toThrow('must export an executeAgent');
  });
  it('does not expose module error secrets', async () => {
    await expect(
      loadAgentExecutor(await moduleFile('throw new Error("secret-provider-key");'))
    ).rejects.toThrow('Failed to load agent executor: executor.mjs');
  });
  it('rejects a remote URL as a missing local file', async () => {
    await expect(loadAgentExecutor('https://example.invalid/executor.mjs')).rejects.toThrow(
      'not found'
    );
  });
});

describe('driver input normalization', () => {
  it('handles typed JSON, dates, bigint, and numeric boolean values', () => {
    expect(normalizeAgenticInputValue('[1]', 'array')).toEqual([1]);
    expect(normalizeAgenticInputValue('{"a":1}', 'object')).toEqual({ a: 1 });
    expect(normalizeAgenticInputValue(new Date('2026-01-01T00:00:00Z'), 'date')).toBe('2026-01-01');
    expect(normalizeAgenticInputValue(12n, 'integer')).toBe(12);
    expect(normalizeAgenticInputValue(0, 'boolean')).toBe(false);
    expect(normalizeAgenticInputValue('12.5', 'number')).toBe(12.5);
    expect(normalizeAgenticInputValue('  ', 'number')).toBe('  ');
  });
});

describe('warehouse temporal values', () => {
  it('normalizes native DuckDB epoch wrappers without losing fractional precision', () => {
    expect(normalizeAgenticInputValue({ micros: 1_789_689_600_123456n }, 'timestamp')).toBe(
      '2026-09-18T00:00:00.123456Z'
    );
    expect(normalizeAgenticInputValue({ nanos: -1n }, 'timestamp')).toBe(
      '1969-12-31T23:59:59.999999999Z'
    );
    expect(normalizeAgenticInputValue({ millis: 1234n }, 'timestamp')).toBe(
      '1970-01-01T00:00:01.234Z'
    );
    expect(normalizeAgenticInputValue({ seconds: 1n }, 'timestamp')).toBe('1970-01-01T00:00:01Z');
    expect(normalizeAgenticInputValue({ days: 1 }, 'date')).toBe('1970-01-02');
    const business = { micros: 1n };
    expect(normalizeAgenticInputValue(business, 'object')).toBe(business);
    expect(() => normalizeAgenticInputValue({ micros: 2n ** 63n - 1n }, 'timestamp')).toThrow();
  });

  it('unwraps BigQuery DATE and TIMESTAMP values without losing precision', () => {
    expect(normalizeAgenticInputValue({ value: '2026-01-01' }, 'date')).toBe('2026-01-01');
    expect(normalizeAgenticInputValue({ value: '2026-01-01T12:34:56.123456Z' }, 'timestamp')).toBe(
      '2026-01-01T12:34:56.123456Z'
    );
  });
  it('normalizes only timestamp strings with an explicit zone', () => {
    expect(normalizeAgenticInputValue('2026-01-01 12:34:56 UTC', 'timestamp')).toBe(
      '2026-01-01T12:34:56Z'
    );
    expect(normalizeAgenticInputValue('2026-01-01 12:34:56+02:00', 'timestamp')).toBe(
      '2026-01-01T12:34:56+02:00'
    );
    expect(normalizeAgenticInputValue('2026-01-01 12:34:56', 'timestamp')).toBe(
      '2026-01-01 12:34:56'
    );
  });
  it('does not unwrap business objects or oversized wrappers', () => {
    const object = { value: '2026-01-01' };
    expect(normalizeAgenticInputValue(object, 'object')).toBe(object);
    const oversized = { value: 'x'.repeat(65) };
    expect(normalizeAgenticInputValue(oversized, 'timestamp')).toBe(oversized);
  });
});
