import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetDnsLookupForTests, setDnsLookupForTests } from '../../src/framework/core/ssrf.js';
import { IcebergCatalogClient } from '../../src/runtime/iceberg-catalog.js';

afterEach(() => {
  resetDnsLookupForTests();
  vi.unstubAllGlobals();
});

describe('Iceberg catalog network security', () => {
  it('rejects redirects and applies a timeout to catalog requests', async () => {
    setDnsLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ defaults: {}, overrides: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await IcebergCatalogClient.create({
      catalogUrl: 'https://catalog.example.com',
      auth: { type: 'token', token: 'secret' },
    });

    await expect(catalog.getConfig()).resolves.toEqual({ defaults: {}, overrides: {} });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://catalog.example.com/v1/config',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );
  });
});
