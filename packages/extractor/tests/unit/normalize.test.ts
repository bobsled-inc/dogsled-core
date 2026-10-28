import { describe, expect, it } from 'vitest';

import { normalizeSpec } from '../../src/schemas/normalize.js';

describe('normalizeSpec', () => {
  it('renames camelCase keys to snake_case', () => {
    const input = {
      specVersion: '1',
      transport: {
        baseUrl: 'https://api.example.com',
        timeoutMs: 30_000,
        rateLimit: {
          requestsPerSecond: 10,
          burst: 20,
        },
      },
    };

    const { data, warnings } = normalizeSpec(input);

    expect(data).toEqual({
      spec_version: '1',
      transport: {
        base_url: 'https://api.example.com',
        timeout_ms: 30_000,
        rate_limit: {
          requests_per_second: 10,
          burst: 20,
        },
      },
    });
    expect(warnings).toHaveLength(5);
    expect(warnings).toContain('specVersion → spec_version');
    expect(warnings).toContain('transport.baseUrl → base_url');
    expect(warnings).toContain('transport.timeoutMs → timeout_ms');
    expect(warnings).toContain('transport.rateLimit → rate_limit');
    expect(warnings).toContain('transport.rate_limit.requestsPerSecond → requests_per_second');
  });

  it('passes through already-correct keys unchanged', () => {
    const input = {
      spec_version: '1',
      transport: {
        base_url: 'https://api.example.com',
      },
    };

    const { data, warnings } = normalizeSpec(input);

    expect(data).toEqual(input);
    expect(warnings).toHaveLength(0);
  });

  it('handles arrays', () => {
    const input = {
      extract: {
        table: {
          primaryKey: ['id'],
        },
      },
    };

    const { data, warnings } = normalizeSpec(input);

    expect(data).toEqual({
      extract: {
        table: {
          primary_key: ['id'],
        },
      },
    });
    expect(warnings).toHaveLength(1);
  });

  it('is idempotent', () => {
    const input = {
      specVersion: '1',
      transport: {
        baseUrl: 'https://api.example.com',
      },
    };

    const first = normalizeSpec(input);
    const second = normalizeSpec(first.data);

    expect(second.data).toEqual(first.data);
    expect(second.warnings).toHaveLength(0);
  });

  it('handles nested pagination and auth keys', () => {
    const input = {
      transport: {
        auth: {
          type: 'custom-token',
          tokenUrl: 'https://auth.example.com/token',
          tokenRequest: {
            requestBody: {
              grant_type: 'client_credentials',
            },
          },
        },
      },
      extract: {
        pagination: {
          type: 'page_number',
          pageParam: 'page',
          perPageParam: 'per_page',
          totalPagesPath: '$.meta.total_pages',
        },
      },
    };

    const { data, warnings } = normalizeSpec(input);
    const result = data as Record<string, unknown>;
    const transport = result['transport'] as Record<string, unknown>;
    const auth = transport['auth'] as Record<string, unknown>;
    const tokenRequest = auth['token_request'] as Record<string, unknown>;
    const extract = result['extract'] as Record<string, unknown>;
    const pagination = extract['pagination'] as Record<string, unknown>;

    expect(auth['token_url']).toBe('https://auth.example.com/token');
    expect(tokenRequest['request_body']).toEqual({ grant_type: 'client_credentials' });
    expect(pagination['page_param']).toBe('page');
    expect(pagination['per_page_param']).toBe('per_page');
    expect(pagination['total_pages_path']).toBe('$.meta.total_pages');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('passes through primitives and null', () => {
    expect(normalizeSpec(null)).toEqual({ data: null, warnings: [] });
    expect(normalizeSpec('hello')).toEqual({ data: 'hello', warnings: [] });
    expect(normalizeSpec(42)).toEqual({ data: 42, warnings: [] });
  });
});
