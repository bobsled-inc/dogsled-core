import { describe, expect, it } from 'vitest';

import {
  DestinationSchema,
  DogsledConfigSchema,
  NamedDestinationSchema,
} from '../../../../src/runner/config/schema.js';

const fileDestinations = [
  { type: 'local', format: 'parquet' },
  { type: 'gcs', bucket: 'example-bucket', prefix: 'landing/', format: 'parquet' },
  { type: 's3', bucket: 'example-bucket', prefix: 'landing/', format: 'parquet' },
] as const;

const pipelines = {
  stripe: {
    schedule: 'hourly',
    source: 'stripe',
    destination: 'warehouse',
    resources: ['charges'],
  },
};

describe('file destination options in dogsled.yml', () => {
  it.each(fileDestinations)(
    'accepts stream_subfolder and utc_timestamps on a $type destination',
    (destination) => {
      const result = DogsledConfigSchema.safeParse({
        destinations: {
          warehouse: {
            ...destination,
            stream_subfolder: 'data/20261120T050007Z-9f3a1c2b',
            utc_timestamps: true,
          },
        },
        pipelines,
      });
      expect(result.success).toBe(true);
    }
  );

  it.each(fileDestinations)('accepts the named form of a $type destination', (destination) => {
    const result = NamedDestinationSchema.safeParse({
      name: 'landing',
      ...destination,
      stream_subfolder: 'data/run-1',
      utc_timestamps: true,
    });
    expect(result.success).toBe(true);
  });

  it.each(fileDestinations)(
    'still accepts a $type destination without either option',
    (destination) => {
      expect(DestinationSchema.safeParse(destination).success).toBe(true);
    }
  );

  it.each(['jsonl', 'csv'])('rejects utc_timestamps for %s output', (format) => {
    const result = DestinationSchema.safeParse({
      type: 's3',
      bucket: 'example-bucket',
      format,
      utc_timestamps: true,
    });
    expect(result.success).toBe(false);
    expect(!result.success && JSON.stringify(result.error.issues)).toContain('parquet');
  });

  it.each(['jsonl', 'csv'])('rejects utc_timestamps for a named %s destination', (format) => {
    const result = NamedDestinationSchema.safeParse({
      name: 'landing',
      type: 's3',
      bucket: 'example-bucket',
      format,
      utc_timestamps: true,
    });
    expect(result.success).toBe(false);
    expect(!result.success && JSON.stringify(result.error.issues)).toContain('parquet');
  });

  it('accepts an explicit false for any format', () => {
    expect(
      DestinationSchema.safeParse({
        type: 's3',
        bucket: 'example-bucket',
        format: 'csv',
        utc_timestamps: false,
      }).success
    ).toBe(true);
  });

  it.each(['..', '../x', '/abs', 'a//b', 'a\\b', 'has space', '.', 'a/./b'])(
    'rejects the unsafe stream_subfolder %j',
    (stream_subfolder) => {
      expect(
        DestinationSchema.safeParse({
          type: 'gcs',
          bucket: 'example-bucket',
          format: 'parquet',
          stream_subfolder,
        }).success
      ).toBe(false);
    }
  );

  it('rejects both options on a destination that is not a file destination', () => {
    for (const extra of [{ stream_subfolder: 'data' }, { utc_timestamps: true }]) {
      expect(
        DestinationSchema.safeParse({
          type: 'postgres',
          host: 'db.example.com',
          database: 'analytics',
          username: 'loader',
          password: '$PG_PASSWORD',
          auth_env_vars: ['PG_PASSWORD'],
          ...extra,
        }).success
      ).toBe(false);
    }
  });
});
