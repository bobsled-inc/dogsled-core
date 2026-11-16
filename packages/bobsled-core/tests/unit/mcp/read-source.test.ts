import { describe, it, expect, vi } from 'vitest';

import { BobsledMcpServer, readSource } from '../../../src/mcp/index.js';
import type { PrincipalContext } from '../../../src/mcp/server.js';

const PRINCIPAL: PrincipalContext = { principal_id: 'user-1' };

describe('BobsledMcpServer fail-closed default', () => {
  it('rejects --allow-unfiltered without env var', () => {
    expect(
      () =>
        new BobsledMcpServer({
          allowUnfiltered: true,
          env: {},
        })
    ).toThrow(/DOGSLED_MCP_ALLOW_UNFILTERED=1 is not set/);
  });

  it('rejects env var without --allow-unfiltered', () => {
    expect(
      () =>
        new BobsledMcpServer({
          allowUnfiltered: false,
          env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
        })
    ).toThrow(/--allow-unfiltered flag is missing/);
  });

  it('accepts both flag AND env var together', () => {
    expect(
      () =>
        new BobsledMcpServer({
          allowUnfiltered: true,
          env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
        })
    ).not.toThrow();
  });

  it('throws PermissionsNotConfigured when no principal in fail-closed mode', () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    expect(() => server.requirePrincipal(null)).toThrow(/PermissionsNotConfigured/);
  });

  it('treats empty / whitespace principal_id as missing in fail-closed mode', () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    expect(() => server.requirePrincipal({ principal_id: '' })).toThrow(/PermissionsNotConfigured/);
    expect(() => server.requirePrincipal({ principal_id: '   ' })).toThrow(
      /PermissionsNotConfigured/
    );
  });

  it('returns the supplied principal verbatim in unfiltered mode (including empty principal_id)', () => {
    const server = new BobsledMcpServer({
      allowUnfiltered: true,
      env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
    });
    expect(server.requirePrincipal(null)).toBeNull();
    expect(server.requirePrincipal({ principal_id: '' })).toEqual({ principal_id: '' });
  });
});

describe('readSource MCP tool', () => {
  it('attaches citations for __documents tables', async () => {
    const server = new BobsledMcpServer({
      env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
      allowUnfiltered: true,
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const result = await readSource(
      {
        server,
        principal: PRINCIPAL,
        fetcher: async () => ({
          rows: [
            {
              document_id: 'doc-1',
              document_version_id: 'doc-1@v1',
              source_uri: 's3://bucket/file.pdf',
              title: 'Acme Annual Report',
            },
          ],
        }),
      },
      { source_table: 'support__documents' }
    );
    expect(result.result.rows).toHaveLength(1);
    expect(result.result.rows[0]?.citation?.document_id).toBe('doc-1');
    expect(result.result.rows[0]?.citation?.title).toBe('Acme Annual Report');
    expect(result.permissions).toEqual({
      enforced: false,
      reason: 'no_adapter_registered',
    });
    expect(result.routing_metadata?.resolved_via).toBe('direct');
  });

  it('attaches citations including chunk_id for __chunks tables', async () => {
    const server = new BobsledMcpServer({
      env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
      allowUnfiltered: true,
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const result = await readSource(
      {
        server,
        principal: PRINCIPAL,
        fetcher: async () => ({
          rows: [
            {
              document_id: 'doc-1',
              document_version_id: 'doc-1@v1',
              source_uri: 's3://bucket/f.pdf',
              chunk_id: 'chunk-42',
              chunk_index: 42,
            },
          ],
        }),
      },
      { source_table: 'support__chunks' }
    );
    expect(result.result.rows[0]?.citation?.chunk_id).toBe('chunk-42');
    expect(result.result.rows[0]?.citation?.chunk_index).toBe(42);
  });

  it('does not attach citations for structured tables', async () => {
    const server = new BobsledMcpServer({
      env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
      allowUnfiltered: true,
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const result = await readSource(
      {
        server,
        principal: PRINCIPAL,
        fetcher: async () => ({ rows: [{ id: 1, name: 'Acme' }] }),
      },
      { source_table: 'crm.customers' }
    );
    expect(result.result.rows[0]?.citation).toBeUndefined();
  });

  it('filters rows and reports the matching adapter when one applies', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    server.registerPermissionAdapter({
      name: 'only-owned',
      appliesTo: ({ sourceTable }) => sourceTable === 'crm.customers',
      filter: async <R>(rows: R[], { principal }: { principal: PrincipalContext }) =>
        rows.filter(
          (row) =>
            typeof row === 'object' &&
            row !== null &&
            (row as { owner?: unknown }).owner === principal.principal_id
        ),
    });

    const result = await readSource(
      {
        server,
        principal: PRINCIPAL,
        fetcher: async () => ({
          rows: [
            { id: 1, owner: 'user-1' },
            { id: 2, owner: 'user-2' },
          ],
        }),
      },
      { source_table: 'crm.customers' }
    );

    expect(result.permissions).toEqual({ enforced: true, adapter: 'only-owned' });
    expect(result.result.rows.map((row) => row.data)).toEqual([{ id: 1, owner: 'user-1' }]);
  });

  it('reports adapter_does_not_apply when adapters exist but none matches', async () => {
    const server = new BobsledMcpServer({
      env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
      allowUnfiltered: true,
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    server.registerPermissionAdapter({
      name: 'docs-only',
      appliesTo: ({ sourceTable }) => sourceTable === 'support__documents',
      filter: async (rows: unknown[]) => rows,
    });

    const result = await readSource(
      {
        server,
        principal: PRINCIPAL,
        fetcher: async () => ({ rows: [{ id: 1, name: 'Acme' }] }),
      },
      { source_table: 'crm.customers' }
    );

    expect(result.permissions).toEqual({
      enforced: false,
      reason: 'adapter_does_not_apply',
    });
  });

  it('rejects calls without principal in fail-closed mode', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    await expect(
      readSource(
        {
          server,
          principal: null,
          fetcher: async () => ({ rows: [] }),
        },
        { source_table: 'support__documents' }
      )
    ).rejects.toThrow(/PermissionsNotConfigured/);
  });

  it('rejects unsafe source_table identifiers at the MCP boundary', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const fetcherCalled = vi.fn();
    const evilTable = "support__documents'; DROP TABLE x;--";
    await expect(
      readSource(
        {
          server,
          principal: PRINCIPAL,
          fetcher: async () => {
            fetcherCalled();
            return { rows: [] };
          },
        },
        { source_table: evilTable }
      )
    ).rejects.toThrow(/Invalid SQL identifier/);
    expect(fetcherCalled).not.toHaveBeenCalled();
  });

  it('rejects invalid limits before calling the fetcher', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const fetcherCalled = vi.fn();
    await expect(
      readSource(
        {
          server,
          principal: PRINCIPAL,
          fetcher: async () => {
            fetcherCalled();
            return { rows: [] };
          },
        },
        { source_table: 'support__documents', limit: 10_000 }
      )
    ).rejects.toThrow(/read_source\.limit/);
    expect(fetcherCalled).not.toHaveBeenCalled();
  });

  it('rejects non-string cursors before calling the fetcher', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const fetcherCalled = vi.fn();
    await expect(
      readSource(
        {
          server,
          principal: PRINCIPAL,
          fetcher: async () => {
            fetcherCalled();
            return { rows: [] };
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { source_table: 'support__documents', cursor: { evil: true } as any }
      )
    ).rejects.toThrow(/read_source\.cursor must be a string/);
    expect(fetcherCalled).not.toHaveBeenCalled();
  });

  it('rejects oversized cursors before calling the fetcher', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const fetcherCalled = vi.fn();
    await expect(
      readSource(
        {
          server,
          principal: PRINCIPAL,
          fetcher: async () => {
            fetcherCalled();
            return { rows: [] };
          },
        },
        { source_table: 'support__documents', cursor: 'x'.repeat(4_097) }
      )
    ).rejects.toThrow(/exceeds 4096 bytes/);
    expect(fetcherCalled).not.toHaveBeenCalled();
  });

  it('rejects cursors with control characters before calling the fetcher', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents', 'support__chunks', 'crm.customers']),
    });
    const fetcherCalled = vi.fn();
    await expect(
      readSource(
        {
          server,
          principal: PRINCIPAL,
          fetcher: async () => {
            fetcherCalled();
            return { rows: [] };
          },
        },
        { source_table: 'support__documents', cursor: 'page\x00two' }
      )
    ).rejects.toThrow(/control characters/);
    expect(fetcherCalled).not.toHaveBeenCalled();
  });
});

describe('MCP source authorization before fetch', () => {
  it('denies a declared source without an adapter despite a supplied principal', async () => {
    const server = new BobsledMcpServer({
      env: {},
      allowedSourceTables: new Set(['support__documents']),
    });
    const fetcher = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      readSource({ server, principal: PRINCIPAL, fetcher }, { source_table: 'support__documents' })
    ).rejects.toThrow(/permission adapter/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['other.secret', 'db.schema.secret', 'other__documents'])(
    'denies undeclared %s even with the explicit unfiltered opt-in',
    async (source_table) => {
      const server = new BobsledMcpServer({
        allowUnfiltered: true,
        env: { DOGSLED_MCP_ALLOW_UNFILTERED: '1' },
        allowedSourceTables: new Set(['support__documents']),
      });
      const fetcher = vi.fn().mockResolvedValue({ rows: [] });
      await expect(
        readSource({ server, principal: null, fetcher }, { source_table })
      ).rejects.toThrow(/not declared/);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
  it('denies sources when no project allowlist was supplied', async () => {
    const server = new BobsledMcpServer({ env: {} });
    const fetcher = vi.fn().mockResolvedValue({ rows: [] });
    await expect(
      readSource({ server, principal: PRINCIPAL, fetcher }, { source_table: 'support__documents' })
    ).rejects.toThrow(/not declared/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
