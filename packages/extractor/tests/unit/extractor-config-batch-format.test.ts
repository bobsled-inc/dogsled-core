import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadExtractorConfig, resolveExtractorConfig } from '../../src/config.js';

describe('extractor config — batch format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads default_batch_format from extractor.yml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'extractor.yml'),
      ['default_batch_format: parquet', 'default_output: stdout'].join('\n'),
      'utf-8'
    );

    const config = loadExtractorConfig(tmpDir);

    expect(config?.default_batch_format).toBe('parquet');
  });

  it('normalizes camelCase defaultBatchFormat in extractor.yml', () => {
    fs.writeFileSync(path.join(tmpDir, 'extractor.yml'), 'defaultBatchFormat: parquet\n', 'utf-8');

    const config = loadExtractorConfig(tmpDir);

    expect(config?.default_batch_format).toBe('parquet');
  });

  it('resolves missing default_batch_format to jsonl', () => {
    const config = resolveExtractorConfig(loadExtractorConfig(tmpDir));

    expect(config.default_batch_format).toBe('jsonl');
  });

  it('refuses an extractor.yml over the file limit instead of ignoring it', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'extractor.yml'),
      `default_output: stdout\n# ${'x'.repeat(1_100_000)}\n`,
      'utf-8'
    );

    expect(() => loadExtractorConfig(tmpDir)).toThrow(
      /extractor\.yml: The file is \d+ bytes; the limit is 1048576\./
    );
  });

  it('has no configuration for a directory that does not exist', () => {
    expect(loadExtractorConfig(path.join(tmpDir, 'missing'))).toBeNull();
  });
});
