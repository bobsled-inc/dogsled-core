import { describe, expect, it } from 'vitest';

import { runMockVerification } from '../../src/commands/verify-mock.js';
import { listFixtures } from '../../src/commands/verify-mock-fixtures.js';
import { clampMockPageSize } from '../../src/commands/verify-mock-server.js';
import { resolveMockFilterOverrides } from '../../src/commands/verify-shared.js';
import { makeConnection, makeResource } from '../helpers/fixtures.js';
import type { SourceSpec } from '../../src/types/index.js';

describe('runMockVerification', () => {
  it('executes fixture-backed mock extraction for paginated resources', async () => {
    const integration = makeConnection('https://api.example.com', {
      name: 'mock_api',
      auth_env_vars: ['MOCK_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'],
      transport: {
        type: 'http',
        base_url: 'https://api.example.com',
        auth: {
          type: 'bearer',
          token: '${{ env.MOCK_TOKEN }}',
        },
      },
    });
    const resource = makeResource({
      name: 'items',
      integration: 'mock_api',
      extract: {
        record_path: '$.items',
        pagination: {
          type: 'cursor',
          cursor_param: 'cursor',
          cursor_path: '$.next_cursor',
        },
        table: {
          primary_key: ['id'],
        },
      },
      test: {
        fixtures: [
          {
            name: 'items_fixture',
            input: {},
          },
        ],
      },
    });

    const result = await runMockVerification('mock_api', integration, [resource]);

    expect(result.resourcesChecked).toBe(1);
    expect(result.fixturesChecked).toBe(1);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('serves JSONL fixtures for opt-in JSONL resources', async () => {
    const integration = makeConnection('https://api.example.com', {
      name: 'mock_jsonl',
      transport: {
        type: 'http',
        base_url: 'https://api.example.com',
        auth: { type: 'none' },
      },
    });
    const resource = makeResource({
      name: 'charges',
      integration: 'mock_jsonl',
      api: {
        endpoint: '/charges',
        method: 'GET',
        response_format: 'jsonl',
      },
      extract: {
        record_path: '$',
        pagination: { type: 'none' },
        table: { primary_key: ['id'] },
      },
      test: { fixtures: [{ name: 'jsonl_fixture', input: {} }] },
    });

    const result = await runMockVerification('mock_jsonl', integration, [resource]);

    expect(result.resourcesChecked).toBe(1);
    expect(result.fixturesChecked).toBe(1);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('synthesizes fixture inputs when no test fixtures are declared', async () => {
    const integration = makeConnection('https://api.example.com', {
      name: 'mock_api',
    });
    const resource = makeResource({
      name: 'item_detail',
      integration: 'mock_api',
      api: {
        endpoint: '/items/${{ input.item_id }}',
        method: 'GET',
      },
      input: {
        item_id: { type: 'string', required: true },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
        },
      },
    });

    const result = await runMockVerification('mock_api', integration, [resource]);

    expect(result.resourcesChecked).toBe(1);
    expect(result.fixturesChecked).toBe(1);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('resolves bundled source transports before running mock extraction', async () => {
    const source: SourceSpec = {
      spec_version: '2',
      type: 'source',
      name: 'mock_source',
      default_transport: 'default',
      transports: [
        {
          id: 'default',
          type: 'http',
          base_url: 'https://api.example.com',
          auth: { type: 'none' },
        },
      ],
    };
    const resource = makeResource({
      name: 'items',
      integration: 'mock_source',
      test: { fixtures: [{ name: 'items_fixture', input: {} }] },
    });

    const result = await runMockVerification('mock_source', source, [resource]);

    expect(result.resourcesChecked).toBe(1);
    expect(result.fixturesChecked).toBe(1);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('caps synthetic page sizes for paginated resources', () => {
    const resource = makeResource({
      name: 'items',
      integration: 'mock_api',
      input: {
        page: { type: 'integer', default: 1 },
        limit: { type: 'integer', default: 1000 },
      },
      api: {
        endpoint: '/items',
        method: 'GET',
        query_params: {
          page: '${{ input.page }}',
          limit: '${{ input.limit }}',
        },
      },
      extract: {
        record_path: '$.items',
        pagination: {
          type: 'page_number',
          page_param: 'page',
          per_page_param: 'limit',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(listFixtures(resource)).toEqual([
      {
        name: 'synthetic_fixture',
        input: {
          page: 1,
          limit: 2,
        },
      },
    ]);
  });

  it('caps synthetic page sizes for offset pagination resources', () => {
    const resource = makeResource({
      name: 'items_offset',
      integration: 'mock_api',
      input: {
        offset: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 500 },
      },
      api: {
        endpoint: '/items',
        method: 'GET',
        query_params: {
          offset: '${{ input.offset }}',
          limit: '${{ input.limit }}',
        },
      },
      extract: {
        record_path: '$.items',
        pagination: {
          type: 'offset',
          offset_param: 'offset',
          limit_param: 'limit',
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(listFixtures(resource)).toEqual([
      {
        name: 'synthetic_fixture',
        input: {
          offset: 0,
          limit: 2,
        },
      },
    ]);
  });

  it('caps mock server page sizes for paginated responses', () => {
    expect(clampMockPageSize(5000)).toBe(2);
    expect(clampMockPageSize(1000)).toBe(2);
    expect(clampMockPageSize(1)).toBe(1);
    expect(clampMockPageSize(Number.NaN)).toBe(2);
  });

  it('bounds synthetic filter-incremental windows to a single mock window', () => {
    const now = new Date('2026-04-09T12:00:00.000Z');
    const resource = makeResource({
      name: 'anomaly_alerts',
      integration: 'mock_api',
      input: {
        start_date: { type: 'timestamp' },
        end_date: { type: 'timestamp' },
      },
      output: {
        id: { type: 'string', path: '$.id', description: 'ID' },
        created_at: {
          type: 'timestamp',
          path: '$.created_at',
          description: 'Creation timestamp',
        },
      },
      extract: {
        record_path: '$.items',
        incremental: {
          strategy: 'filter',
          cursor_field: 'created_at',
          cursor_type: 'timestamp',
          since_argument: 'start_date',
          until_argument: 'end_date',
          value_format: 'date',
          initial_lookback_seconds: 2_592_000,
          window_size_seconds: 86_400,
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(resolveMockFilterOverrides(resource, {}, now)).toEqual({
      sinceOverride: '2026-04-08',
      untilOverride: '2026-04-09',
    });
  });

  it('stabilizes unix-second filter incremental fixtures without explicit inputs', () => {
    const now = new Date('2026-04-09T12:00:00.000Z');
    const resource = makeResource({
      name: 'checkout_sessions',
      integration: 'mock_api',
      input: {
        created_gte: { type: 'integer' },
      },
      output: {
        id: { type: 'string', path: '$.id', description: 'ID' },
        created: {
          type: 'integer',
          path: '$.created',
          description: 'Creation timestamp',
        },
      },
      extract: {
        record_path: '$.items',
        incremental: {
          strategy: 'filter',
          cursor_field: 'created',
          cursor_type: 'integer',
          since_argument: 'created_gte',
          value_format: 'unix_seconds',
          initial_lookback_seconds: 2_592_000,
          lookback_seconds: 86_400,
        },
        table: {
          primary_key: ['id'],
        },
      },
    });

    expect(resolveMockFilterOverrides(resource, {}, now)).toEqual({
      sinceOverride: '1773144000',
    });
  });

  it('verifies oauth2 auth contracts against the mock auth endpoint', async () => {
    const integration = makeConnection('https://api.example.com', {
      name: 'mock_api',
      auth_env_vars: ['MOCK_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'],
      transport: {
        type: 'http',
        base_url: 'https://api.example.com',
        auth: {
          type: 'oauth2',
          grant_type: 'client_credentials',
          token_url: 'https://api.example.com/token',
          client_id: '${{ env.CLIENT_ID }}',
          client_secret: '${{ env.CLIENT_SECRET }}',
        },
      },
    });
    const resource = makeResource({
      name: 'items',
      integration: 'mock_api',
      test: {
        fixtures: [
          {
            name: 'items_fixture',
            input: {},
          },
        ],
      },
    });

    const result = await runMockVerification('mock_api', integration, [resource]);

    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(result.findings.some((finding) => finding.code === 'MOCK_AUTH_SIMULATED')).toBe(false);
  });

  it('checks POST request-body contracts and keeps pagination cursors in the body', async () => {
    const integration = makeConnection('https://api.example.com', {
      name: 'mock_api',
    });
    const resource = makeResource({
      name: 'search_items',
      integration: 'mock_api',
      api: {
        endpoint: '/items/search',
        method: 'POST',
        request_body: {
          limit: 100,
          filter: {
            field: 'created_at',
            operator: 'time_is_after',
            value: '2000-01-01T00:00:00Z',
          },
        },
      },
      extract: {
        record_path: '$.items',
        pagination: {
          type: 'cursor',
          cursor_param: 'cursor',
          cursor_path: '$.next_cursor',
        },
        table: {
          primary_key: ['id'],
        },
      },
      test: {
        fixtures: [
          {
            name: 'search_fixture',
            input: {},
          },
        ],
      },
    });

    const result = await runMockVerification('mock_api', integration, [resource]);

    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });
});
