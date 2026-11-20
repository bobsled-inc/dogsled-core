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
  it.each(fileDestinations)('accepts stream_subfolder on a $type destination', (destination) => {
    const result = DogsledConfigSchema.safeParse({
      destinations: {
        warehouse: {
          ...destination,
          stream_subfolder: 'data/20261120T050007Z-9f3a1c2b',
        },
      },
      pipelines,
    });
    expect(result.success).toBe(true);
  });

  it.each(fileDestinations)('accepts the named form of a $type destination', (destination) => {
    const result = NamedDestinationSchema.safeParse({
      name: 'landing',
      ...destination,
      stream_subfolder: 'data/run-1',
    });
    expect(result.success).toBe(true);
  });

  it.each(fileDestinations)(
    'still accepts a $type destination without the option',
    (destination) => {
      expect(DestinationSchema.safeParse(destination).success).toBe(true);
    }
  );

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

  it('rejects the option on a destination that is not a file destination', () => {
    expect(
      DestinationSchema.safeParse({
        type: 'postgres',
        host: 'db.example.com',
        database: 'analytics',
        username: 'loader',
        password: '$PG_PASSWORD',
        auth_env_vars: ['PG_PASSWORD'],
        stream_subfolder: 'data',
      }).success
    ).toBe(false);
  });
});

describe('object_metadata in dogsled.yml', () => {
  const objectStores = [fileDestinations[1], fileDestinations[2]];
  const parse = (destination: Record<string, unknown>) =>
    DogsledConfigSchema.safeParse({ destinations: { warehouse: destination }, pipelines });

  it.each(objectStores)('accepts object_metadata on a $type destination', (destination) => {
    const metadata = { team: 'data', 'cost-center': '4021' };

    expect(parse({ ...destination, object_metadata: metadata }).success).toBe(true);
    expect(
      NamedDestinationSchema.safeParse({
        name: 'landing',
        ...destination,
        object_metadata: metadata,
      }).success
    ).toBe(true);
  });

  it('takes a value that looks like an environment reference as plain text', () => {
    const object_metadata = { owner: '$OWNER', note: '${{ env.NAME }}', price: '$5' };

    expect(parse({ ...fileDestinations[2], object_metadata }).success).toBe(true);
  });

  it('does not take object_metadata on a local destination, which keeps none', () => {
    expect(parse({ ...fileDestinations[0], object_metadata: { team: 'data' } }).success).toBe(
      false
    );
  });

  it.each([
    ['an upper-case key', { Team: 'data' }],
    ['a key a copy sets', { 'dogsled-source-modified': 'x' }],
    ['a value that is not text', { team: 7 }],
    ['more than S3 keeps on one object', { note: 'x'.repeat(2000) }],
  ])('refuses %s', (_label, object_metadata) => {
    expect(parse({ ...fileDestinations[2], object_metadata }).success).toBe(false);
  });
});
