import { describe, expect, it } from 'vitest';

import { buildDestinationCliArgs } from '../../../../src/runner/commands/destination-args.js';

describe('buildDestinationCliArgs: file destination options', () => {
  it('keeps the arguments of existing file destinations exactly as they were', () => {
    expect(
      buildDestinationCliArgs({
        type: 's3',
        bucket: 'example-bucket',
        prefix: 'landing/',
        format: 'parquet',
      })
    ).toEqual([
      '--dest',
      's3',
      '--format',
      'parquet',
      '--s3-bucket',
      'example-bucket',
      '--s3-prefix',
      'landing/',
    ]);
    expect(
      buildDestinationCliArgs({
        type: 'gcs',
        bucket: 'example-bucket',
        prefix: 'landing/',
        format: 'parquet',
      })
    ).toEqual([
      '--dest',
      'gcs',
      '--format',
      'parquet',
      '--gcs-bucket',
      'example-bucket',
      '--gcs-prefix',
      'landing/',
    ]);
    expect(buildDestinationCliArgs({ type: 'local', format: 'jsonl' })).toEqual([
      '--dest',
      'local',
      '--format',
      'jsonl',
    ]);
  });

  it('emits no new flag when utc_timestamps is false', () => {
    expect(
      buildDestinationCliArgs({
        type: 's3',
        bucket: 'example-bucket',
        format: 'parquet',
        utc_timestamps: false,
      })
    ).toEqual(['--dest', 's3', '--format', 'parquet', '--s3-bucket', 'example-bucket']);
  });

  it.each([
    [
      's3',
      { type: 's3' as const, bucket: 'example-bucket', prefix: 'landing/' },
      ['--s3-bucket', 'example-bucket', '--s3-prefix', 'landing/'],
    ],
    [
      'gcs',
      { type: 'gcs' as const, bucket: 'example-bucket', prefix: 'landing/' },
      ['--gcs-bucket', 'example-bucket', '--gcs-prefix', 'landing/'],
    ],
    ['local', { type: 'local' as const }, []],
  ])('emits both flags for a %s destination', (_name, destination, location) => {
    expect(
      buildDestinationCliArgs({
        ...destination,
        format: 'parquet',
        stream_subfolder: 'data/20261120T050007Z-9f3a1c2b',
        utc_timestamps: true,
      })
    ).toEqual([
      '--dest',
      destination.type,
      '--format',
      'parquet',
      ...location,
      '--stream-subfolder',
      'data/20261120T050007Z-9f3a1c2b',
      '--utc-timestamps',
    ]);
  });

  it('resolves placeholders in stream_subfolder like the other string fields', () => {
    expect(
      buildDestinationCliArgs(
        {
          auth_env_vars: ['RUN_FOLDER'],
          type: 'gcs',
          bucket: 'example-bucket',
          format: 'parquet',
          stream_subfolder: '$RUN_FOLDER',
        },
        { valueResolver: (value) => (value === '$RUN_FOLDER' ? 'data/run-7' : value) }
      )
    ).toContain('data/run-7');
  });
});
