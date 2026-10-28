import { describe, expect, it } from 'vitest';

import {
  OutputFieldSchema,
  WarehouseOutputFieldSchema,
} from '../../../src/framework/core/fields.js';

describe('OutputFieldSchema embedding_candidate hint', () => {
  it('accepts embedding_candidate: true', () => {
    const parsed = OutputFieldSchema.parse({
      type: 'string',
      path: '$.description',
      embedding_candidate: true,
    });

    expect(parsed.embedding_candidate).toBe(true);
  });

  it('defaults to undefined when omitted', () => {
    const parsed = OutputFieldSchema.parse({
      type: 'string',
      path: '$.name',
    });

    expect(parsed.embedding_candidate).toBeUndefined();
  });

  it('rejects non-boolean values', () => {
    expect(() =>
      OutputFieldSchema.parse({
        type: 'string',
        path: '$.name',
        embedding_candidate: 'yes',
      })
    ).toThrow();
  });
});

describe('OutputFieldSchema semantic metadata', () => {
  it('accepts additive FieldMetadata fields without changing path or type', () => {
    const parsed = OutputFieldSchema.parse({
      type: 'string',
      path: '$.email',
      description: 'Primary contact email',
      semantic_role: 'email',
      tags: ['contact', 'pii'],
      unit: 'USD',
      format: 'rfc5322',
      pii: true,
      enum_values: ['a@example.com'],
      examples: ['a@example.com'],
      references: 'contacts.email',
      business_rule: 'Only active contact email addresses are loaded.',
      quality_notes: 'May be absent for imported records.',
      owner: 'revops',
      deprecated: false,
      embedding_candidate: true,
    });

    expect(parsed).toMatchObject({
      type: 'string',
      path: '$.email',
      semantic_role: 'email',
      pii: true,
      embedding_candidate: true,
    });
  });

  it('rejects unknown semantic roles', () => {
    expect(() =>
      OutputFieldSchema.parse({
        type: 'string',
        path: '$.name',
        semantic_role: 'dimension',
      })
    ).toThrow();
  });
});

describe('OutputFieldSchema ordered paths (B2)', () => {
  it('accepts an ordered paths fallback list without a singular path', () => {
    const parsed = OutputFieldSchema.parse({
      type: 'string',
      paths: ['$.paragraph.rich_text', '$.heading_1.rich_text'],
      default: null,
    });

    expect(parsed.paths).toEqual(['$.paragraph.rich_text', '$.heading_1.rich_text']);
    expect(parsed.path).toBeUndefined();
  });

  it('rejects path and paths set together (paths would silently win)', () => {
    expect(() =>
      OutputFieldSchema.parse({ type: 'string', path: '$.a', paths: ['$.a', '$.b'] })
    ).toThrow(/Set either `path` or `paths`, not both/);
  });

  it('rejects a field with neither path nor paths', () => {
    expect(() => OutputFieldSchema.parse({ type: 'string' })).toThrow(
      /requires `path` or a non-empty `paths`/
    );
  });

  it('rejects an empty paths array', () => {
    expect(() => OutputFieldSchema.parse({ type: 'string', paths: [] })).toThrow(
      /`paths` must list at least one JSONPath/
    );
  });
});

describe('OutputFieldSchema contextual origins', () => {
  it('accepts an input projection origin', () => {
    expect(
      OutputFieldSchema.parse({
        type: 'string',
        from: { input: 'tour' },
      }).from
    ).toEqual({ input: 'tour' });
  });

  it('rejects input projection names that are not identifiers', () => {
    expect(() => OutputFieldSchema.parse({ type: 'string', from: { input: 'tour-name' } })).toThrow(
      /from\.input/
    );
  });

  it('accepts a strict resource-qualified mapped-output origin', () => {
    expect(
      OutputFieldSchema.parse({
        type: 'integer',
        from: { resource: 'projects', path: '$.id' },
      }).from
    ).toEqual({ resource: 'projects', path: '$.id' });
  });

  it('rejects ambiguous response and contextual origins', () => {
    expect(() =>
      OutputFieldSchema.parse({
        type: 'integer',
        path: '$.project_id',
        from: { resource: 'projects', path: '$.id' },
      })
    ).toThrow(/exactly one/);
  });

  it.each(['$..id', '$.__proto__.id', '$', '$.items[*].id'])(
    'rejects unsafe or unprovable context path %s',
    (path) => {
      expect(() =>
        OutputFieldSchema.parse({ type: 'string', from: { resource: 'parents', path } })
      ).toThrow(/bounded property\/index path/);
    }
  );

  it('rejects unknown contextual origin keys', () => {
    expect(() =>
      OutputFieldSchema.parse({
        type: 'string',
        from: { resource: 'parents', path: '$.id', input: 'token' },
      })
    ).toThrow();
  });

  it.each([
    {
      type: 'object',
      path: '$.owner',
      properties: {
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
    },
    {
      type: 'array',
      path: '$.owners',
      items: {
        type: 'integer',
        from: { resource: 'projects', path: '$.id' },
      },
    },
  ])('rejects contextual origins below top-level output fields', (field) => {
    expect(() => OutputFieldSchema.parse(field)).toThrow(/Unrecognized key.*from/);
  });
});

describe('WarehouseOutputFieldSchema embedding_candidate hint', () => {
  it('supports the hint for warehouse resources too', () => {
    const parsed = WarehouseOutputFieldSchema.parse({
      type: 'string',
      embedding_candidate: true,
    });

    expect(parsed.embedding_candidate).toBe(true);
  });

  it('accepts FieldMetadata fields while keeping path optional', () => {
    const parsed = WarehouseOutputFieldSchema.parse({
      type: 'string',
      description: 'Customer phone number',
      semantic_role: 'phone',
      format: 'e164',
      pii: true,
    });

    expect(parsed.path).toBeUndefined();
    expect(parsed.semantic_role).toBe('phone');
    expect(parsed.format).toBe('e164');
  });
});
