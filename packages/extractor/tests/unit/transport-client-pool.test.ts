import { afterEach, describe, expect, it } from 'vitest';

import { ExtractorConfigError } from '../../src/runtime/errors.js';
import {
  TransportClientPool,
  resolveApiTransport,
} from '../../src/runtime/transport-client-pool.js';

import type { ApiResourceSpec, SourceSpec } from '../../src/types/index.js';

const source = {
  spec_version: '2',
  type: 'source',
  name: 'multi_api',
  default_transport: 'primary',
  transports: [
    {
      id: 'primary',
      type: 'http',
      base_url: 'https://primary.example.com',
    },
    {
      id: 'secondary',
      type: 'http',
      base_url: 'https://secondary.example.com',
    },
    {
      id: 'warehouse',
      type: 'sql_bigquery',
      connection: { project_id: 'project', dataset: 'dataset' },
      auth: { type: 'adc' },
    },
  ],
} satisfies SourceSpec;

const resource = {
  type: 'resource',
  name: 'items',
  via: 'secondary',
  api: { endpoint: '/items', method: 'GET' },
  input: {},
  output: { id: { type: 'string', path: '$.id' } },
  extract: { record_path: '$.items' },
} as ApiResourceSpec;

describe('TransportClientPool', () => {
  let pool: TransportClientPool | undefined;

  afterEach(async () => {
    await pool?.closeAll();
    pool = undefined;
  });

  it('resolves per-resource source transports and lazily creates HTTP clients', async () => {
    pool = new TransportClientPool({
      integration: source,
      stateDir: '/tmp/dogsled-test-state',
    });

    const first = await pool.getForResource(resource);
    const second = await pool.getForResource(resource);

    expect(first.transportId).toBe('secondary');
    expect(first.integration.transport).toMatchObject({
      type: 'http',
      base_url: 'https://secondary.example.com',
    });
    expect(second.client).toBe(first.client);
  });

  it('deduplicates concurrent client creation for the same transport', async () => {
    pool = new TransportClientPool({
      integration: source,
      stateDir: '/tmp/dogsled-test-state',
    });

    const [first, second] = await Promise.all([
      pool.getForResource(resource),
      pool.getForResource(resource),
    ]);

    expect(second.client).toBe(first.client);
  });

  it('rejects resources that resolve via SQL transports', () => {
    expect(() =>
      resolveApiTransport(source, {
        ...resource,
        via: 'warehouse',
      })
    ).toThrow(ExtractorConfigError);
  });
});
