import { describe, expect, it } from 'vitest';

import { LoaderConfigSchema } from '../../src/schemas/config.js';

const fileDestinations = [
  { dest: 'local', outputDir: './out' },
  { dest: 'gcs', gcsBucket: 'example-bucket', gcsPrefix: 'landing/' },
  { dest: 's3', s3Bucket: 'example-bucket', s3Prefix: 'landing/' },
] as const;

const parse = (value: Record<string, unknown>) => LoaderConfigSchema.safeParse(value);

describe('file destination options: stream subfolder', () => {
  it.each(fileDestinations)('accepts a stream subfolder for the $dest destination', (dest) => {
    const result = parse({
      ...dest,
      format: 'parquet',
      streamSubfolder: 'data/20261120T050007Z-9f3a1c2b',
    });
    expect(result.success).toBe(true);
    expect(result.success && 'streamSubfolder' in result.data && result.data.streamSubfolder).toBe(
      'data/20261120T050007Z-9f3a1c2b'
    );
  });

  it('removes trailing slashes from the subfolder', () => {
    const result = parse({
      ...fileDestinations[2],
      format: 'parquet',
      streamSubfolder: 'data/20261120T050007Z-9f3a1c2b//',
    });
    expect(result.success && 'streamSubfolder' in result.data && result.data.streamSubfolder).toBe(
      'data/20261120T050007Z-9f3a1c2b'
    );
  });

  it.each([
    '..',
    '../escape',
    'data/../escape',
    '/absolute',
    'data//twice',
    'data\\windows',
    '.',
    'data/./dot',
    'has space',
    'data/20261120T050007Z-9f3a1c2b?query',
    'a'.repeat(257),
  ])('rejects the unsafe subfolder %j', (streamSubfolder) => {
    expect(parse({ ...fileDestinations[2], format: 'parquet', streamSubfolder }).success).toBe(
      false
    );
  });

  it('accepts Hive-style folders with equals signs', () => {
    expect(
      parse({ ...fileDestinations[1], format: 'parquet', streamSubfolder: 'date=2026-11-20' })
        .success
    ).toBe(true);
  });

  it.each(fileDestinations)('adds no key to the $dest config when the option is absent', (dest) => {
    const result = parse({ ...dest, format: 'parquet' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect('streamSubfolder' in result.data).toBe(false);
  });
});
