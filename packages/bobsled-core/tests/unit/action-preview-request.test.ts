import { describe, expect, it } from 'vitest';

import { describeActionRequest } from '../../src/lib/action-preview-request.js';

describe('describeActionRequest', () => {
  it('drops the origin and query string of an absolute endpoint template', () => {
    expect(
      describeActionRequest({
        method: 'GET',
        endpoint:
          'https://api.example.com/v1/items/${{ input.id }}/${{ secrets.TENANT }}?q=${{ input.q }}',
        references: [],
        inputs: { id: '1', q: 'x' },
      }).path_template
    ).toBe('/v1/items/{id}/{secrets.TENANT}');
  });

  it('reads a backslash in an absolute endpoint the way URL parsing does', () => {
    expect(
      describeActionRequest({
        method: 'POST',
        endpoint: 'https://api.example.test\\admin/${{ input.id }}',
        references: [],
        inputs: { id: '7' },
      }).path_template
    ).toBe('/admin/{id}');
  });

  it.each([
    ['a base path', 'https://api.example.test/v1', '/items/${{ input.id }}', '/v1/items/{id}'],
    [
      'a templated base path',
      'https://graph.example.test/${{ env.VERSION }}/',
      '/items',
      '/{env.VERSION}/items',
    ],
    ['dot segments', 'https://api.example.test/v1', '/../admin/${{ input.id }}', '/admin/{id}'],
    [
      'an absolute endpoint with dot segments',
      undefined,
      'https://api.example.test/v1/%2e%2e/admin/${{ input.id }}',
      '/admin/{id}',
    ],
    ['a base URL that is entirely a reference', '${{ secrets.BASE_URL }}', '/items', undefined],
  ])('composes the sent path for %s', (_case, baseUrl, endpoint, expected) => {
    expect(
      describeActionRequest({
        method: 'GET',
        endpoint,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        references: [],
        inputs: { id: '7' },
      }).path_template
    ).toBe(expected);
  });

  it('keeps literal path text that looks like a placeholder marker', () => {
    expect(
      describeActionRequest({
        method: 'GET',
        endpoint: '/trackref0trackref/${{ input.id }}',
        baseUrl: 'https://api.example.test',
        references: [],
        inputs: { id: '7' },
      }).path_template
    ).toBe('/trackref0trackref/{id}');
  });

  it('drops the fragment of an absolute endpoint template', () => {
    expect(
      describeActionRequest({
        method: 'GET',
        endpoint: 'https://api.example.test/items/${{ input.id }}#${{ input.token }}',
        references: [],
        inputs: { id: '1', token: 't' },
      }).path_template
    ).toBe('/items/{id}');
  });

  it('reports no input for a value the input did not supply', () => {
    expect(
      describeActionRequest({
        method: 'POST',
        references: [
          { source: 'mapped', key: 'title', path: 'request_body.Title' },
          { source: 'mapped', key: 'region', path: 'request_body.Region' },
          { source: 'mapped', key: 'note', path: 'request_body.Note' },
          { source: 'input', key: 'missing', path: 'request_body.Missing' },
          { source: 'mapped', key: 'name', path: 'request_body.Name' },
        ],
        fieldMapping: {
          fields: { title: 'title', region: { source: 'region' }, name: 'name' },
          unmapped_fields: 'passthrough',
        },
        inputs: { name: 'Ada', note: null, missing: undefined },
      })
    ).toEqual({
      method: 'POST',
      input_locations: { name: ['body'] },
      whole_input_locations: [],
    });
  });

  it('attributes mapped references to their source input, or to the whole input when unknown', () => {
    expect(
      describeActionRequest({
        method: 'POST',
        endpoint: '/records/${{ mapped.record }}/${{ mapped.extra }}',
        baseUrl: 'https://api.example.test',
        references: [
          { source: 'mapped', key: 'record', path: 'api.endpoint' },
          { source: 'mapped', key: 'extra', path: 'api.endpoint' },
          { source: 'mapped', key: 'unknown', path: 'headers.X-Unknown' },
          { source: 'mapped', key: 'detail', path: 'request_body.detail' },
          { source: 'secrets', key: 'TOKEN', path: 'auth.token' },
          { source: 'input', key: 'record_id', path: 'optional_headers.X-Record' },
          { source: 'input', key: 'record_id', path: 'somewhere.new' },
          { source: 'input', key: 'extra', path: 'api.base_url.origin' },
          { source: 'input', key: 'details', path: 'webhook.url.unclassified' },
        ],
        fieldMapping: {
          fields: { record: 'record_id', detail: { source: 'details' } },
          unmapped_fields: 'passthrough',
        },
        inputs: { record_id: 'r', extra: 'e', details: 'd' },
      })
    ).toEqual({
      method: 'POST',
      path_template: '/records/{record_id}/{extra}',
      input_locations: {
        record_id: ['path', 'header', 'other'],
        extra: ['path', 'base_url'],
        details: ['body', 'other'],
      },
      whole_input_locations: ['header'],
    });
  });
});
