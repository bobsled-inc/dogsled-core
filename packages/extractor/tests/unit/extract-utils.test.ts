import { describe, expect, it } from 'vitest';

import { routePaginationParams, setNestedValue } from '../../src/commands/extract-utils.js';

describe('setNestedValue', () => {
  it('sets a top-level property', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'key', 42);
    expect(obj).toEqual({ key: 42 });
  });

  it('creates nested structure for dotted key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b', 'hello');
    expect(obj).toEqual({ a: { b: 'hello' } });
  });

  it('handles deep nesting', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b.c.d', true);
    expect(obj).toEqual({ a: { b: { c: { d: true } } } });
  });

  it('does not overwrite sibling keys in existing nested object', () => {
    const obj: Record<string, unknown> = { a: { existing: 1 } };
    setNestedValue(obj, 'a.added', 2);
    expect(obj).toEqual({ a: { existing: 1, added: 2 } });
  });

  it('aborts on __proto__ key to prevent prototype pollution', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, '__proto__', 'bad');
    expect(obj).toEqual({});
  });

  it('aborts when constructor appears in path', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'constructor.polluted', true);
    expect(obj).toEqual({});
  });

  it('aborts when prototype appears in path', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.prototype', 'bad');
    expect(obj).toEqual({});
  });

  it('overwrites non-object intermediate values', () => {
    const obj: Record<string, unknown> = { a: 'string' };
    setNestedValue(obj, 'a.b', 99);
    expect(obj).toEqual({ a: { b: 99 } });
  });
});

describe('routePaginationParams', () => {
  it('GET: all params go to urlQueryParams', () => {
    const result = routePaginationParams({ page: 1, limit: 10 }, 'GET', false);
    expect(result.urlQueryParams).toEqual({ page: 1, limit: 10 });
    expect(result.bodyOverrides).toEqual({});
  });

  it('GET with no request body: params stay in urlQueryParams', () => {
    const result = routePaginationParams({ offset: 0 }, 'get', false);
    expect(result.urlQueryParams).toEqual({ offset: 0 });
    expect(result.bodyOverrides).toEqual({});
  });

  it('POST with request_body: all params go to bodyOverrides', () => {
    const result = routePaginationParams({ cursor: 'abc', limit: 50 }, 'POST', true);
    expect(result.bodyOverrides).toEqual({ cursor: 'abc', limit: 50 });
    expect(result.urlQueryParams).toEqual({});
  });

  it('POST without request_body: params go to urlQueryParams', () => {
    const result = routePaginationParams({ page: 2 }, 'POST', false);
    expect(result.urlQueryParams).toEqual({ page: 2 });
    expect(result.bodyOverrides).toEqual({});
  });

  it('dotted key with request_body on GET: dotted param goes to bodyOverrides', () => {
    const result = routePaginationParams(
      { 'variables.after': 'cursor123', limit: 10 },
      'GET',
      true
    );
    expect(result.bodyOverrides).toEqual({ 'variables.after': 'cursor123' });
    expect(result.urlQueryParams).toEqual({ limit: 10 });
  });

  it('dotted key without request_body on GET: stays in urlQueryParams', () => {
    const result = routePaginationParams({ 'variables.after': 'cursor123' }, 'GET', false);
    expect(result.urlQueryParams).toEqual({ 'variables.after': 'cursor123' });
    expect(result.bodyOverrides).toEqual({});
  });

  it('handles empty params', () => {
    const result = routePaginationParams({}, 'POST', true);
    expect(result.bodyOverrides).toEqual({});
    expect(result.urlQueryParams).toEqual({});
  });

  it('case-insensitive method matching', () => {
    const result = routePaginationParams({ key: 'val' }, 'post', true);
    expect(result.bodyOverrides).toEqual({ key: 'val' });
    expect(result.urlQueryParams).toEqual({});
  });

  it('mixed dotted and plain keys with request_body on GET', () => {
    const result = routePaginationParams(
      { 'body.cursor': 'next', page: 1, 'body.limit': 20 },
      'GET',
      true
    );
    expect(result.bodyOverrides).toEqual({ 'body.cursor': 'next', 'body.limit': 20 });
    expect(result.urlQueryParams).toEqual({ page: 1 });
  });
});
