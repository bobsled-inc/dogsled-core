import { describe, expect, it } from 'vitest';

import {
  extractJsonPath,
  mapOutput,
  mapResponse,
  extractRecords,
  withOutputContext,
} from '../../src/runtime/response-mapper.js';
import {
  EMPTY_FAN_OUT_CONTEXT,
  createFanOutContext,
  extendFanOutContext,
} from '../../src/runtime/for-each.js';
import { makeResource } from '../helpers/fixtures.js';

describe('extractJsonPath', () => {
  it('returns root with $', () => {
    const data = [1, 2, 3];
    expect(extractJsonPath(data, '$')).toEqual([1, 2, 3]);
  });

  it('extracts simple field', () => {
    expect(extractJsonPath({ name: 'Alice' }, '$.name')).toBe('Alice');
  });

  it('extracts nested field', () => {
    const data = { user: { login: 'alice' } };
    expect(extractJsonPath(data, '$.user.login')).toBe('alice');
  });

  it('extracts from array with wildcard', () => {
    const data = { items: [1, 2, 3] };
    expect(extractJsonPath(data, '$.items[*]')).toEqual([1, 2, 3]);
  });

  it('extracts array by index', () => {
    const data = { items: ['a', 'b', 'c'] };
    expect(extractJsonPath(data, '$.items[0]')).toBe('a');
  });

  it('extracts array by negative index', () => {
    const data = { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    expect(extractJsonPath(data, '$.items[-1].id')).toBe('c');
  });

  it('returns undefined for missing path', () => {
    expect(extractJsonPath({ a: 1 }, '$.b.c')).toBeUndefined();
  });

  it('handles null data', () => {
    expect(extractJsonPath(null, '$.field')).toBeUndefined();
  });
});

describe('mapOutput', () => {
  it('maps direct fields', () => {
    const output = {
      id: { type: 'integer' as const, path: '$.id' },
      title: { type: 'string' as const, path: '$.title' },
    };
    const raw = { id: 1, title: 'Hello', extra: 'ignored' };
    const result = mapOutput(raw, output);
    expect(result).toEqual({ id: 1, title: 'Hello' });
  });

  it('maps nested fields via path', () => {
    const output = {
      user_login: { type: 'string' as const, path: '$.user.login' },
    };
    const raw = { user: { login: 'alice' } };
    const result = mapOutput(raw, output);
    expect(result).toEqual({ user_login: 'alice' });
  });

  it('coerces types', () => {
    const output = {
      count: { type: 'integer' as const, path: '$.count' },
      active: { type: 'boolean' as const, path: '$.active' },
    };
    const raw = { count: '42', active: 1 };
    const result = mapOutput(raw, output);
    expect(result).toEqual({ count: 42, active: true });
  });

  it('handles null values', () => {
    const output = {
      field: { type: 'string' as const, path: '$.field' },
    };
    const raw = { field: null };
    const result = mapOutput(raw, output);
    expect(result).toEqual({ field: null });
  });

  it('maps bound input values from extraction context', () => {
    const output = {
      page_id: { type: 'string' as const, path: '$.__input__.page_id' },
      metric: { type: 'string' as const, path: '$.name' },
    };
    const raw = withOutputContext({ name: 'page_impressions' }, { page_id: '12345' });
    const result = mapOutput(raw, output);
    expect(result).toEqual({ page_id: '12345', metric: 'page_impressions' });
  });

  it('projects contextual values from mapped ancestor outputs authoritatively', () => {
    const output = {
      project_id: {
        type: 'integer' as const,
        from: { resource: 'projects', path: '$.identity.id' },
      },
      name: { type: 'string' as const, path: '$.name' },
    };
    const context = extendFanOutContext(EMPTY_FAN_OUT_CONTEXT, 'projects', {
      identity: { id: 42 },
    });

    expect(mapOutput({ project_id: 999, name: 'event' }, output, undefined, context)).toEqual({
      project_id: 42,
      name: 'event',
    });
  });

  it('fails clearly instead of omitting a contextual output without lineage', () => {
    expect(() =>
      mapOutput(
        { id: 'event-1' },
        {
          project_id: {
            type: 'integer',
            from: { resource: 'projects', path: '$.id' },
          },
        }
      )
    ).toThrow(/Missing fan-out context/);
  });

  it('normalizes non-plain objects to null in structured outputs', () => {
    const output = {
      payload: { type: 'object' as const, path: '$.payload' },
      events: { type: 'array' as const, path: '$.events' },
    };
    const raw = {
      payload: { occurred_at: new Date('2026-04-15T00:00:00.000Z') },
      events: [new Date('2026-04-15T00:00:00.000Z')],
    };

    const result = mapOutput(raw, output);

    expect(result).toEqual({
      payload: { occurred_at: null },
      events: [null],
    });
  });
});

describe('mapOutput field-match telemetry (B1)', () => {
  function makeCollector() {
    const coverage = new Map<string, { matched: number; total: number }>();
    return {
      coverage,
      collector: {
        record(field: string, matched: boolean) {
          const entry = coverage.get(field) ?? { matched: 0, total: 0 };
          entry.total += 1;
          if (matched) entry.matched += 1;
          coverage.set(field, entry);
        },
      },
    };
  }

  it('reports matched/total per field, including a field that matches zero records', () => {
    const output = {
      id: { type: 'string' as const, path: '$.id' },
      missing: { type: 'string' as const, path: '$.never_present', default: null },
    };
    const { coverage, collector } = makeCollector();
    const records = [{ id: 'a' }, { id: 'b' }, { other: true }];
    for (const raw of records) {
      mapOutput(raw, output, collector);
    }
    expect(coverage.get('id')).toEqual({ matched: 2, total: 3 });
    // A path that resolves nothing for any record: matched 0 — the instant
    // signal that replaces a deploy-extract probe.
    expect(coverage.get('missing')).toEqual({ matched: 0, total: 3 });
  });

  it('only records top-level fields, not nested object properties', () => {
    const output = {
      payload: {
        type: 'object' as const,
        path: '$.payload',
        properties: { inner: { type: 'string' as const, path: '$.inner' } },
      },
    };
    const { coverage, collector } = makeCollector();
    mapOutput({ payload: { inner: 'x' } }, output, collector);
    expect([...coverage.keys()]).toEqual(['payload']);
  });

  it('is a no-op when no collector is passed', () => {
    const output = { id: { type: 'string' as const, path: '$.id' } };
    expect(mapOutput({ id: 'a' }, output)).toEqual({ id: 'a' });
  });
});

describe('mapOutput ordered paths fallback (B2)', () => {
  it('uses path[1] when path[0] is absent, with scalar coercion and no array leak', () => {
    const output = {
      label: { type: 'string' as const, paths: ['$.a', '$.b'], default: null },
    };
    const raw = { b: 42 };
    const result = mapOutput(raw, output);
    expect(result).toEqual({ label: '42' });
    expect(Array.isArray((result as Record<string, unknown>)['label'])).toBe(false);
  });

  it('prefers the first path that resolves', () => {
    const output = {
      text: {
        type: 'string' as const,
        paths: ['$.heading_1.title', '$.paragraph.title'],
        default: null,
      },
    };
    expect(mapOutput({ heading_1: { title: 'H' }, paragraph: { title: 'P' } }, output)).toEqual({
      text: 'H',
    });
  });

  it('falls back to default when no path resolves', () => {
    const output = {
      label: { type: 'string' as const, paths: ['$.a', '$.b'], default: null },
    };
    expect(mapOutput({}, output)).toEqual({ label: null });
  });

  it('counts a telemetry match when any path resolves', () => {
    const coverage = new Map<string, { matched: number; total: number }>();
    const collector = {
      record(field: string, matched: boolean) {
        const entry = coverage.get(field) ?? { matched: 0, total: 0 };
        entry.total += 1;
        if (matched) entry.matched += 1;
        coverage.set(field, entry);
      },
    };
    const output = {
      label: { type: 'string' as const, paths: ['$.a', '$.b'], default: null },
    };
    mapOutput({ b: 'x' }, output, collector);
    mapOutput({}, output, collector);
    expect(coverage.get('label')).toEqual({ matched: 1, total: 2 });
  });
});

describe('extractRecords', () => {
  it('extracts from root array', () => {
    const data = [{ id: 1 }, { id: 2 }];
    const resource = makeResource({ extract: { record_path: '$' } });
    expect(extractRecords(data, resource)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('extracts from nested path', () => {
    const data = { results: [{ id: 1 }] };
    const resource = makeResource({ extract: { record_path: '$.results' } });
    expect(extractRecords(data, resource)).toEqual([{ id: 1 }]);
  });

  it('wraps single object in array', () => {
    const data = { results: { id: 1 } };
    const resource = makeResource({ extract: { record_path: '$.results' } });
    expect(extractRecords(data, resource)).toEqual([{ id: 1 }]);
  });

  it('filters out non-object items from arrays', () => {
    const data = [42, 'hello', null, { id: 1 }, [1, 2], { id: 2 }, true];
    const resource = makeResource({ extract: { record_path: '$' } });
    expect(extractRecords(data, resource)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns empty array for empty input', () => {
    const resource = makeResource({ extract: { record_path: '$' } });
    expect(extractRecords([], resource)).toEqual([]);
  });

  it('returns empty array when extracted value is a primitive', () => {
    const data = { count: 42 };
    const resource = makeResource({ extract: { record_path: '$.count' } });
    expect(extractRecords(data, resource)).toEqual([]);
  });
});

describe('mapResponse', () => {
  it('full pipeline: extract + map', () => {
    const data = [
      { id: 1, title: 'A', user: { login: 'alice' } },
      { id: 2, title: 'B', user: { login: 'bob' } },
    ];
    const resource = makeResource({
      extract: { record_path: '$' },
      output: {
        id: { type: 'integer', path: '$.id' },
        title: { type: 'string', path: '$.title' },
        user_login: { type: 'string', path: '$.user.login' },
      },
    });
    const result = mapResponse(data, resource);
    expect(result).toEqual([
      { id: 1, title: 'A', user_login: 'alice' },
      { id: 2, title: 'B', user_login: 'bob' },
    ]);
  });

  it('derives contextual output from exact targeted inputs', () => {
    const resource = makeResource({
      name: 'events',
      input: { project_id: { type: 'integer', required: true } },
      output: {
        id: { type: 'string', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
        legacy_project_id: { type: 'integer', path: '$.__input__.project_id' },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
    });

    expect(mapResponse([{ id: 'event-1' }], resource, { input: { project_id: 42 } })).toEqual([
      { id: 'event-1', project_id: 42, legacy_project_id: 42 },
    ]);
  });

  it('projects declared request inputs without requiring fan-out ancestry', () => {
    const resource = makeResource({
      name: 'events',
      input: { tour: { type: 'string', required: true } },
      output: {
        event_id: { type: 'string', path: '$.id' },
        requested_tour: { type: 'string', from: { input: 'tour' } },
      },
      extract: { record_path: '$' },
    });

    expect(mapResponse([{ id: 'event-1' }], resource, { input: { tour: 'pga' } })).toEqual([
      { event_id: 'event-1', requested_tour: 'pga' },
    ]);
  });

  it('accepts an explicit immutable context for proven nested ancestry', () => {
    const resource = makeResource({
      name: 'events',
      output: {
        id: { type: 'string', path: '$.id' },
        organization_id: {
          type: 'integer',
          from: { resource: 'organizations', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
    });
    const source = { id: 7 };
    const fanOutContext = createFanOutContext({ organizations: source });
    source.id = 999;

    expect(mapResponse([{ id: 'event-1' }], resource, { fanOutContext })).toEqual([
      { id: 'event-1', organization_id: 7 },
    ]);
  });

  it('rejects contextual mapping when targeted inputs cannot prove ancestry', () => {
    const resource = makeResource({
      name: 'events',
      input: { project_id: { type: 'integer', required: true } },
      output: {
        organization_id: {
          type: 'integer',
          from: { resource: 'organizations', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
    });

    expect(() => mapResponse([{}], resource, { input: { project_id: 42 } })).toThrow(
      /cannot prove fan-out context.*co-schedule its fan-out ancestors/
    );
  });
});
