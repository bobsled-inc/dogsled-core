import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandError,
  loadRunnerModule,
  parseConfidenceOption,
  parsePositiveIntOption,
} from '../../../src/commands/common.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadRunnerModule', () => {
  it('does not leak absolute paths when the runner file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogsled-model-spec-runner-'));
    tempDirs.push(dir);

    const runnerPath = join(dir, 'missing-runner.mjs');

    try {
      await loadRunnerModule(runnerPath);
      throw new Error('Expected loadRunnerModule to throw for a missing runner.');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('Runner module not found: missing-runner.mjs');
      expect(message).not.toContain(dir);
    }
  });

  it('sanitizes absolute paths from runner import failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogsled-model-spec-runner-'));
    tempDirs.push(dir);

    const runnerPath = join(dir, 'broken-runner.mjs');
    writeFileSync(
      runnerPath,
      `import './missing-dependency.mjs';
export default async function run(sql) {
  return { rowCount: 1 };
}
`,
      'utf-8'
    );

    try {
      await loadRunnerModule(runnerPath);
      throw new Error('Expected loadRunnerModule to throw for an invalid runner.');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Failed to load runner "broken-runner.mjs":');
      expect(message).not.toContain(dir);
      expect(message).not.toContain('file://');
      expect(message).toContain('<runner>');
    }
  });

  it('preserves optional close hooks from runner modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogsled-model-spec-runner-'));
    tempDirs.push(dir);

    const runnerPath = join(dir, 'closable-runner.mjs');
    writeFileSync(
      runnerPath,
      `export async function run() { return { rowCount: 1 }; }
export async function close() { return undefined; }
`,
      'utf-8'
    );

    const runner = await loadRunnerModule(runnerPath);
    expect(typeof runner.close).toBe('function');
  });
});

describe('parsePositiveIntOption', () => {
  it('accepts zero', () => {
    expect(parsePositiveIntOption('0')).toBe(0);
  });

  it('accepts safe integers', () => {
    expect(parsePositiveIntOption(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects integers above the safe range', () => {
    expect(() => parsePositiveIntOption(String(BigInt(Number.MAX_SAFE_INTEGER) + 1n))).toThrow(
      'must be a non-negative integer within safe integer range'
    );
  });

  it('rejects negative integers', () => {
    expect(() => parsePositiveIntOption('-1')).toThrow('must be a non-negative integer');
  });

  it('rejects non-numeric strings', () => {
    expect(() => parsePositiveIntOption('abc')).toThrow('must be a non-negative integer');
  });

  it('rejects decimals', () => {
    expect(() => parsePositiveIntOption('1.5')).toThrow('must be a non-negative integer');
  });

  it('rejects empty strings', () => {
    expect(() => parsePositiveIntOption('')).toThrow('must be a non-negative integer');
  });

  it('rejects leading zeros', () => {
    expect(() => parsePositiveIntOption('007')).toThrow('must be a non-negative integer');
  });
});

describe('parseConfidenceOption', () => {
  it('accepts confidence thresholds in range', () => {
    expect(parseConfidenceOption('0')).toBe(0);
    expect(parseConfidenceOption('.5')).toBe(0.5);
    expect(parseConfidenceOption('0.9')).toBe(0.9);
    expect(parseConfidenceOption('1')).toBe(1);
    expect(parseConfidenceOption('1.0')).toBe(1);
    expect(parseConfidenceOption('  0.75  ')).toBe(0.75);
    expect(parseConfidenceOption('\t1\n')).toBe(1);
  });

  it('rejects values outside the confidence range', () => {
    expect(() => parseConfidenceOption('-0.1')).toThrow('must be a number between 0 and 1');
    expect(() => parseConfidenceOption('1.1')).toThrow('must be a number between 0 and 1');
    expect(() => parseConfidenceOption('')).toThrow('must be a number between 0 and 1');
    expect(() => parseConfidenceOption('   ')).toThrow('must be a number between 0 and 1');
    expect(() => parseConfidenceOption('\n\t')).toThrow('must be a number between 0 and 1');
    expect(() => parseConfidenceOption('abc')).toThrow('must be a number between 0 and 1');
  });
});
