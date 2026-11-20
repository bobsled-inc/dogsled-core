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
  ])('emits the flag for a %s destination', (_name, destination, location) => {
    expect(
      buildDestinationCliArgs({
        ...destination,
        format: 'parquet',
        stream_subfolder: 'data/20261120T050007Z-9f3a1c2b',
      })
    ).toEqual([
      '--dest',
      destination.type,
      '--format',
      'parquet',
      ...location,
      '--stream-subfolder',
      'data/20261120T050007Z-9f3a1c2b',
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

describe('buildDestinationCliArgs: object metadata', () => {
  it.each(['s3', 'gcs'] as const)(
    'emits --object-metadata for a %s destination as JSON, in key order, with values as written',
    (type) => {
      const args = buildDestinationCliArgs(
        {
          type,
          bucket: 'example-bucket',
          format: 'parquet',
          object_metadata: { team: 'data', 'run-id': 'a1' },
        },
        { valueResolver: (value) => value }
      );

      expect(args.slice(args.indexOf('--object-metadata'))).toEqual([
        '--object-metadata',
        '{"run-id":"a1","team":"data"}',
      ]);
    }
  );

  it.each(['s3', 'gcs'] as const)(
    'sends the metadata of a %s destination as text: no value is resolved or needs declaring',
    (type) => {
      // The resolver stands in for the environment. If it were asked about a metadata value,
      // it would put a secret on the object. The destination declares no auth_env_vars.
      const leaky = (value: string) => (/\$/.test(value) ? 'leaked-secret' : value);

      const args = buildDestinationCliArgs(
        {
          type,
          bucket: 'example-bucket',
          format: 'parquet',
          object_metadata: { owner: '$OWNER', price: '$5', note: '${{ env.NAME }}' },
        },
        { valueResolver: leaky }
      );

      expect(args.slice(args.indexOf('--object-metadata'))).toEqual([
        '--object-metadata',
        '{"note":"${{ env.NAME }}","owner":"$OWNER","price":"$5"}',
      ]);
      expect(args.join(' ')).not.toContain('leaked-secret');
    }
  );

  it('adds no argument when there is no metadata, or an empty object', () => {
    for (const object_metadata of [undefined, {}]) {
      expect(
        buildDestinationCliArgs({
          type: 's3',
          bucket: 'example-bucket',
          format: 'parquet',
          object_metadata,
        })
      ).not.toContain('--object-metadata');
    }
  });
});
