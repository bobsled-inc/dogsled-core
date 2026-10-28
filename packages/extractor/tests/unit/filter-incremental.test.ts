import { describe, expect, it } from 'vitest';

import {
  buildFilterWindows,
  compileServerFilterMcpWindowParams,
  compileServerFilterWindowParams,
} from '../../src/runtime/filter-incremental.js';

import type { ApiResourceSpec } from '../../src/types/index.js';

describe('buildFilterWindows', () => {
  const now = new Date('2026-04-09T02:00:00.000Z');

  describe('value_format: unix_seconds', () => {
    it('formats since params as unix seconds and bookmark as string for integer cursors', () => {
      const windows = buildFilterWindows({
        config: {
          strategy: 'filter',
          cursor_field: 'created',
          cursor_type: 'integer',
          since_argument: 'created_gte',
          value_format: 'unix_seconds',
          initial_lookback_seconds: 86400,
          lookback_seconds: 3600,
        },
        cursorKind: 'integer',
        now,
      });

      const nowUnix = Math.floor(now.getTime() / 1000);
      expect(windows).toHaveLength(1);
      expect(windows[0]!.params.created_gte).toBe(nowUnix - 86400);
      expect(windows[0]!.upperBoundCursorValue).toBe(String(nowUnix));
    });

    it('applies lookback when an existing bookmark is present', () => {
      const bookmarkUnix = Math.floor(now.getTime() / 1000) - 7200; // 2 hours ago
      const windows = buildFilterWindows({
        config: {
          strategy: 'filter',
          cursor_field: 'created',
          cursor_type: 'integer',
          since_argument: 'created_gte',
          value_format: 'unix_seconds',
          initial_lookback_seconds: 86400,
          lookback_seconds: 3600,
        },
        cursorKind: 'integer',
        existingBookmarkValue: String(bookmarkUnix),
        now,
      });

      const nowUnix = Math.floor(now.getTime() / 1000);
      expect(windows).toHaveLength(1);
      // bookmark minus lookback
      expect(windows[0]!.params.created_gte).toBe(bookmarkUnix - 3600);
      expect(windows[0]!.upperBoundCursorValue).toBe(String(nowUnix));
    });
  });

  describe('value_format: date', () => {
    it('stores upperBoundCursorValue as a date string, not a full ISO timestamp', () => {
      const windows = buildFilterWindows({
        config: {
          strategy: 'filter',
          cursor_field: 'date',
          cursor_type: 'timestamp',
          since_argument: 'start_date',
          until_argument: 'end_date',
          value_format: 'date',
          initial_lookback_seconds: 3 * 86400,
          window_size_seconds: 86400,
          lookback_seconds: 86400,
        },
        cursorKind: 'timestamp',
        now,
      });

      expect(windows.length).toBe(3);
      // Every window's cursor value should be a YYYY-MM-DD date, not an ISO timestamp
      for (const w of windows) {
        expect(w.upperBoundCursorValue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(windows[0]!.params).toEqual({
        start_date: '2026-04-06',
        end_date: '2026-04-07',
      });
      expect(windows[0]!.upperBoundCursorValue).toBe('2026-04-07');
      expect(windows[windows.length - 1]!.upperBoundCursorValue).toBe('2026-04-09');
    });

    it('uses existing bookmark as a date string for the since boundary', () => {
      const windows = buildFilterWindows({
        config: {
          strategy: 'filter',
          cursor_field: 'date',
          cursor_type: 'timestamp',
          since_argument: 'start_date',
          until_argument: 'end_date',
          value_format: 'date',
          initial_lookback_seconds: 30 * 86400,
          window_size_seconds: 86400,
          lookback_seconds: 86400,
        },
        cursorKind: 'timestamp',
        existingBookmarkValue: '2026-04-07',
        now,
      });

      // With bookmark=2026-04-07 and lookback=1 day, since should be 2026-04-06
      expect(windows[0]!.params.start_date).toBe('2026-04-06');
      // Last window should reach "now" as a date
      expect(windows[windows.length - 1]!.upperBoundCursorValue).toBe('2026-04-09');
    });
  });

  describe('value_format: iso8601', () => {
    it('stores upperBoundCursorValue as a full ISO timestamp', () => {
      const windows = buildFilterWindows({
        config: {
          strategy: 'filter',
          cursor_field: 'created_at',
          cursor_type: 'timestamp',
          since_argument: 'since',
          value_format: 'iso8601',
          initial_lookback_seconds: 86400,
          window_size_seconds: 86400,
          lookback_seconds: 0,
        },
        cursorKind: 'timestamp',
        now,
      });

      expect(windows.length).toBe(1);
      expect(windows[0]!.upperBoundCursorValue).toBe('2026-04-09T02:00:00.000Z');
    });
  });

  describe('no window_size_seconds', () => {
    it('returns a single window spanning the full range', () => {
      const windows = buildFilterWindows({
        config: {
          strategy: 'filter',
          cursor_field: 'date',
          cursor_type: 'timestamp',
          since_argument: 'start_date',
          until_argument: 'end_date',
          value_format: 'date',
          initial_lookback_seconds: 7 * 86400,
          lookback_seconds: 86400,
        },
        cursorKind: 'timestamp',
        now,
      });

      expect(windows.length).toBe(1);
      expect(windows[0]!.params).toEqual({
        start_date: '2026-04-02',
        end_date: '2026-04-09',
      });
      expect(windows[0]!.upperBoundCursorValue).toBe('2026-04-09');
    });
  });
});

describe('compileServerFilterWindowParams', () => {
  it('uses http_query param names instead of bound input names', () => {
    const resource = {
      query: {
        filters: {
          created: {
            operators: ['gte'],
            bind: {
              gte: { input: 'created_gte' },
            },
            compile: {
              gte: {
                mode: 'http_query',
                param: 'created[gte]',
              },
            },
          },
        },
      },
    } as unknown as ApiResourceSpec;

    const params = compileServerFilterWindowParams(
      resource,
      {
        strategy: 'server_filter',
        cursor_field: 'created',
        since_argument: 'created[gte]',
      },
      { 'created[gte]': 1_711_929_600 }
    );

    expect(params).toEqual({ 'created[gte]': 1_711_929_600 });
    expect(params).not.toHaveProperty('created_gte');
  });

  it('uses direct_arg argument names for MCP tool windows', () => {
    const resource = {
      query: {
        filters: {
          updated_at: {
            operators: ['gte'],
            bind: {
              gte: { input: 'since_input' },
            },
            compile: {
              gte: {
                mode: 'direct_arg',
                argument: 'since',
              },
            },
          },
        },
      },
    } as unknown as ApiResourceSpec;

    const params = compileServerFilterWindowParams(
      resource,
      {
        strategy: 'server_filter',
        cursor_field: 'updated_at',
        since_argument: 'since',
      },
      { since: '2026-04-01T00:00:00.000Z' }
    );

    expect(params).toEqual({ since: '2026-04-01T00:00:00.000Z' });
  });

  it('falls back to translated bind inputs when no compile config matches', () => {
    const resource = {
      query: {
        filters: {
          created: {
            operators: ['gte'],
            bind: {
              gte: { input: 'created_gte' },
            },
          },
        },
      },
    } as unknown as ApiResourceSpec;

    const params = compileServerFilterWindowParams(
      resource,
      {
        strategy: 'server_filter',
        cursor_field: 'created',
        since_argument: 'created_gte',
      },
      { created_gte: 1_711_929_600 }
    );

    expect(params).toEqual({ created_gte: 1_711_929_600 });
  });

  it('compiles both since and until HTTP query params', () => {
    const resource = {
      query: {
        filters: {
          created: {
            operators: ['gte', 'lte'],
            bind: {
              gte: { input: 'since_input' },
              lte: { input: 'until_input' },
            },
            compile: {
              gte: {
                mode: 'http_query',
                param: 'created_after',
              },
              lte: {
                mode: 'http_query',
                param: 'created_before',
              },
            },
          },
        },
      },
    } as unknown as ApiResourceSpec;

    const params = compileServerFilterWindowParams(
      resource,
      {
        strategy: 'server_filter',
        cursor_field: 'created',
        since_argument: 'created_after',
        until_argument: 'created_before',
      },
      { created_after: 1_711_929_600, created_before: 1_712_016_000 }
    );

    expect(params).toEqual({
      created_after: 1_711_929_600,
      created_before: 1_712_016_000,
    });
  });

  it('merges compiled bounds with translated bind fallback bounds', () => {
    const resource = {
      name: 'events',
      query: {
        filters: {
          created: {
            operators: ['gte', 'lte'],
            bind: {
              gte: { input: 'created_gte' },
              lte: { input: 'created_lte' },
            },
            compile: {
              gte: {
                mode: 'http_query',
                param: 'created[gte]',
              },
            },
          },
        },
      },
    } as unknown as ApiResourceSpec;

    const params = compileServerFilterWindowParams(
      resource,
      {
        strategy: 'server_filter',
        cursor_field: 'created',
        since_argument: 'created[gte]',
        until_argument: 'created_lte',
      },
      { 'created[gte]': 1_711_929_600, created_lte: 1_712_016_000 }
    );

    expect(params).toEqual({
      'created[gte]': 1_711_929_600,
      created_lte: 1_712_016_000,
    });
  });

  it('fails fast when the incremental cursor field is missing from query filters', () => {
    const resource = {
      name: 'events',
      query: {
        filters: {},
      },
    } as unknown as ApiResourceSpec;

    expect(() =>
      compileServerFilterWindowParams(
        resource,
        {
          strategy: 'server_filter',
          cursor_field: 'created',
          since_argument: 'created_gte',
        },
        { created_gte: 1_711_929_600 }
      )
    ).toThrow('cursor field "created" is not declared in query.filters');
  });

  it('preserves JSON-shaped filter_dsl output for MCP tool windows', () => {
    const resource = {
      type: 'resource',
      name: 'contacts',
      tool: { tool_name: 'search_contacts' },
      input: {},
      output: {
        updated_at: { type: 'timestamp', path: '$.updatedAt' },
      },
      extract: { record_path: '$.items' },
      query: {
        filters: {
          updated_at: {
            operators: ['gte', 'lte'],
            bind: {
              gte: { input: 'since' },
              lte: { input: 'until' },
            },
          },
        },
        compile: {
          mode: 'filter_dsl',
          builder: 'hubspot/crm-search',
          field_map: {
            updated_at: 'hs_lastmodifieddate',
          },
        },
      },
    } as unknown as ApiResourceSpec;

    const params = compileServerFilterMcpWindowParams(
      resource,
      {
        strategy: 'server_filter',
        cursor_field: 'updated_at',
        since_argument: 'since',
        until_argument: 'until',
      },
      {
        since: '2026-04-01T00:00:00.000Z',
        until: '2026-04-02T00:00:00.000Z',
      }
    );

    expect(params).toEqual({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hs_lastmodifieddate',
              operator: 'GTE',
              value: '2026-04-01T00:00:00.000Z',
            },
            {
              propertyName: 'hs_lastmodifieddate',
              operator: 'LTE',
              value: '2026-04-02T00:00:00.000Z',
            },
          ],
        },
      ],
    });
  });
});
