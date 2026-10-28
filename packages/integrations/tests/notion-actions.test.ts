import { describe, expect, it } from 'vitest';

import { getAction } from '../src/actions.js';

describe('Notion actions', () => {
  it('ships a create_page action for reverse ETL', () => {
    const action = getAction('notion', 'create_page');

    expect(action.qualifiedName).toBe('notion/create_page');
    expect(action.transport).toBe('api');
    expect(action.inputs).toMatchObject({
      database_id: { type: 'string', required: true },
      title: { type: 'string', required: true },
      email: { type: 'string' },
      number: { type: 'number' },
      url: { type: 'string' },
      checkbox: { type: 'boolean' },
      date: { type: 'timestamp' },
    });
    expect(action.spec).toMatchObject({
      transport: 'api',
      integration: 'notion',
      api: {
        endpoint: '/v1/pages',
        method: 'POST',
        headers: {
          'Notion-Version': '2022-06-28',
        },
        request_body: {
          parent: {
            database_id: '${{ mapped.database_id }}',
          },
          properties: {
            Name: {
              title: [{ text: { content: '${{ mapped.title }}' } }],
            },
            Email: {
              email: '${{ mapped.email }}',
            },
            Number: {
              number: '${{ mapped.number }}',
            },
            URL: {
              url: '${{ mapped.url }}',
            },
            Checkbox: {
              checkbox: '${{ mapped.checkbox }}',
            },
            Date: {
              date: { start: '${{ mapped.date }}' },
            },
          },
        },
      },
      field_mapping: {
        fields: {
          database_id: 'database_id',
          title: 'title',
          email: 'email',
          number: 'number',
          url: 'url',
          checkbox: 'checkbox',
          date: 'date',
        },
        unmapped_fields: 'ignore',
      },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
      },
      activate: {
        operation: 'create',
        result_path: '$.id',
      },
    });
  });

  it('throws when a Notion action does not exist', () => {
    expect(() => getAction('notion', 'missing_action')).toThrow(
      'Action "notion/missing_action" not found'
    );
  });

  it('exposes the expected qualified name shape and required inputs', () => {
    const action = getAction('notion', 'create_page');

    expect(action.qualifiedName.split('/')).toEqual(['notion', 'create_page']);
    expect(
      Object.entries(action.inputs)
        .filter(([, input]) => input.required === true)
        .map(([name]) => name)
    ).toEqual(['database_id', 'title']);
  });
});
