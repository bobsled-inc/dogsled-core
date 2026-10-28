import { describe, expect, it } from 'vitest';

import YAML from 'yaml';

import {
  generateModelSpecSource,
  inferSemanticRole,
  humanize,
} from '../../src/model-spec/generate-source.js';

describe('generateModelSpecSource', () => {
  it('generates valid Model Spec source YAML', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'issues',
      type: 'resource' as const,
      integration: 'github',
      description: 'Issues',
      api: {
        endpoint: '/issues',
        method: 'GET' as const,
      },
      input: {},
      output: {
        id: { type: 'integer' as const, path: '$.id' },
        title: { type: 'string' as const, path: '$.title' },
        created_at: { type: 'timestamp' as const, path: '$.created_at' },
        active: { type: 'boolean' as const, path: '$.active' },
        score: { type: 'number' as const, path: '$.score' },
        tags: { type: 'array' as const, path: '$.tags[*]' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
          trust_tier: 'bronze' as const,
        },
      },
    };

    const yaml = generateModelSpecSource(resource, 'github');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;

    expect(parsed['spec_version']).toBe('0.2');
    expect(parsed['name']).toBe('github_issues');
    expect(parsed['type']).toBe('source');
    expect(parsed['source_type']).toBe('warehouse_table');
    expect(parsed['table']).toBe('raw.github_issues');
    expect(parsed['trust_tier']).toBe('bronze');

    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };
    expect(schema.columns).toEqual([
      {
        name: 'id',
        type: 'NUMBER',
        description: 'Id',
        primary_key: true,
        semantic_role: 'entity_id',
      },
      { name: 'title', type: 'VARCHAR', description: 'Title', semantic_role: 'categorical' },
      {
        name: 'created_at',
        type: 'TIMESTAMP',
        description: 'Created at',
        semantic_role: 'event_timestamp',
      },
      { name: 'active', type: 'BOOLEAN', description: 'Active' },
      { name: 'score', type: 'FLOAT', description: 'Score' },
      { name: 'tags', type: 'VARIANT', description: 'Tags' },
    ]);
  });

  it('includes primary_key in column output', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'items',
      type: 'resource' as const,
      integration: 'api',
      description: 'Items',
      api: {
        endpoint: '/items',
        method: 'GET' as const,
      },
      input: {},
      output: {
        id: { type: 'integer' as const, path: '$.id' },
        value: { type: 'string' as const, path: '$.value' },
      },
      extract: {
        record_path: '$',
        table: {
          primary_key: ['id'],
        },
      },
    };

    const yaml = generateModelSpecSource(resource, 'api');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };
    expect(schema.columns[0]!['primary_key']).toBe(true);
    expect(schema.columns[1]!['primary_key']).toBeUndefined();
  });

  it('includes contextual output fields and explicit composite keys', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'events',
      type: 'resource' as const,
      integration: 'api',
      description: 'Events by project',
      api: {
        endpoint: '/projects/${{ input.project_id }}/events',
        method: 'GET' as const,
      },
      input: {
        project_id: { type: 'integer' as const, required: true },
      },
      output: {
        id: { type: 'string' as const, path: '$.id' },
        project_id: {
          type: 'integer' as const,
          from: { resource: 'projects', path: '$.id' },
          description: 'Project that produced this event',
        },
      },
      extract: {
        record_path: '$',
        for_each: {
          resource: 'projects',
          field: 'id',
          input: 'project_id',
        },
        table: {
          primary_key: ['project_id', 'id'],
        },
      },
    };

    const yaml = generateModelSpecSource(resource, 'api');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };

    expect(schema.columns).toEqual([
      {
        name: 'id',
        type: 'VARCHAR',
        description: 'Id',
        primary_key: true,
        semantic_role: 'entity_id',
      },
      {
        name: 'project_id',
        type: 'NUMBER',
        description: 'Project that produced this event',
        primary_key: true,
        semantic_role: 'entity_id',
      },
    ]);
  });

  it('omits trust_tier when not specified', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'items',
      type: 'resource' as const,
      integration: 'api',
      description: 'Items',
      api: {
        endpoint: '/items',
        method: 'GET' as const,
      },
      input: {},
      output: {
        id: { type: 'integer' as const, path: '$.id' },
      },
      extract: {
        record_path: '$',
      },
    };

    const yaml = generateModelSpecSource(resource, 'api');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed['trust_tier']).toBeUndefined();
  });

  it('copies authored FieldMetadata into Model Spec source columns', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'customers',
      type: 'resource' as const,
      integration: 'api',
      description: 'Customers',
      api: {
        endpoint: '/customers',
        method: 'GET' as const,
      },
      input: {},
      output: {
        email: {
          type: 'string' as const,
          path: '$.email',
          description: 'Primary email address',
          semantic_role: 'email' as const,
          tags: ['contact', 'pii'],
          unit: 'USD',
          format: 'rfc5322',
          pii: true,
          enum_values: ['a@example.com'],
          examples: ['a@example.com'],
          references: 'contacts.email',
          business_rule: 'Only active customer emails are loaded.',
          quality_notes: 'Imported records may be missing email.',
          owner: 'revops',
          deprecated: false,
          embedding_candidate: true,
        },
      },
      extract: {
        record_path: '$',
      },
    };

    const yaml = generateModelSpecSource(resource, 'api');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };

    expect(schema.columns[0]).toEqual({
      name: 'email',
      type: 'VARCHAR',
      description: 'Primary email address',
      semantic_role: 'email',
      tags: ['contact', 'pii'],
      unit: 'USD',
      format: 'rfc5322',
      pii: true,
      enum_values: ['a@example.com'],
      examples: ['a@example.com'],
      references: 'contacts.email',
      business_rule: 'Only active customer emails are loaded.',
      quality_notes: 'Imported records may be missing email.',
      owner: 'revops',
      deprecated: false,
      embedding_candidate: true,
    });
  });

  it('emits VECTOR columns with embedded_from when an embed config is provided', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'issues',
      type: 'resource' as const,
      integration: 'linear',
      description: 'Issues',
      api: {
        endpoint: '/issues',
        method: 'GET' as const,
      },
      input: {},
      output: {
        id: { type: 'string' as const, path: '$.id' },
        description: { type: 'string' as const, path: '$.description' },
        body: { type: 'string' as const, path: '$.body' },
      },
      extract: {
        record_path: '$',
        table: { primary_key: ['id'] },
      },
    };

    const yaml = generateModelSpecSource(resource, 'linear', {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
      fields: [{ field: 'description' }, { field: 'body', as: 'body_vec' }],
    });
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };

    expect(schema.columns).toContainEqual({
      name: 'description_embedding',
      type: 'VECTOR',
      dimension: 1536,
      description: 'Vector embedding of description (openai/text-embedding-3-small)',
      embedded_from: {
        column: 'description',
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
    });
    expect(schema.columns).toContainEqual({
      name: 'body_vec',
      type: 'VECTOR',
      dimension: 1536,
      description: 'Vector embedding of body (openai/text-embedding-3-small)',
      embedded_from: {
        column: 'body',
        provider: 'openai',
        model: 'text-embedding-3-small',
      },
    });
  });

  it('omits embedding columns when no embed config is provided', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'issues',
      type: 'resource' as const,
      integration: 'linear',
      description: 'Issues',
      api: { endpoint: '/issues', method: 'GET' as const },
      input: {},
      output: {
        id: { type: 'string' as const, path: '$.id' },
        description: { type: 'string' as const, path: '$.description' },
      },
      extract: { record_path: '$' },
    };

    const yaml = generateModelSpecSource(resource, 'linear');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };

    expect(schema.columns.find((c) => c['name'] === 'description_embedding')).toBeUndefined();
    expect(schema.columns).toHaveLength(2);
  });

  it('skips embed fields whose output column already exists in the resource schema', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'issues',
      type: 'resource' as const,
      integration: 'linear',
      description: 'Issues',
      api: { endpoint: '/issues', method: 'GET' as const },
      input: {},
      output: {
        id: { type: 'string' as const, path: '$.id' },
        description: { type: 'string' as const, path: '$.description' },
        description_embedding: { type: 'vector' as const, path: '$.description_embedding' },
      },
      extract: { record_path: '$' },
    };

    const yaml = generateModelSpecSource(resource, 'linear', {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: 1536,
      fields: [{ field: 'description' }],
    });
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };

    const embeddingColumns = schema.columns.filter((c) => c['name'] === 'description_embedding');
    expect(embeddingColumns).toHaveLength(1);
    expect(embeddingColumns[0]).not.toHaveProperty('embedded_from');
  });

  it('keeps authored semantic_role instead of replacing it with an inferred role', () => {
    const resource = {
      spec_version: '1' as const,
      name: 'customers',
      type: 'resource' as const,
      integration: 'api',
      description: 'Customers',
      api: {
        endpoint: '/customers',
        method: 'GET' as const,
      },
      input: {},
      output: {
        customer_id: {
          type: 'string' as const,
          path: '$.customer_id',
          semantic_role: 'identifier' as const,
        },
      },
      extract: {
        record_path: '$',
      },
    };

    const yaml = generateModelSpecSource(resource, 'api');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const schema = parsed['schema'] as { columns: Array<Record<string, unknown>> };

    expect(schema.columns[0]!['semantic_role']).toBe('identifier');
  });
});

describe('inferSemanticRole', () => {
  it('infers entity_id for *_id columns', () => {
    expect(inferSemanticRole('id', 'integer')).toBe('entity_id');
    expect(inferSemanticRole('user_id', 'integer')).toBe('entity_id');
    expect(inferSemanticRole('user_id', 'string')).toBe('entity_id');
  });

  it('infers event_timestamp for *_at timestamp columns', () => {
    expect(inferSemanticRole('created_at', 'timestamp')).toBe('event_timestamp');
    expect(inferSemanticRole('updated_date', 'timestamp')).toBe('event_timestamp');
    expect(inferSemanticRole('start_time', 'timestamp')).toBe('event_timestamp');
  });

  it('infers measure for remaining numeric measure patterns', () => {
    expect(inferSemanticRole('line_total', 'number')).toBe('measure');
    expect(inferSemanticRole('running_sum', 'integer')).toBe('measure');
    expect(inferSemanticRole('risk_score', 'number')).toBe('measure');
  });

  it('infers categorical for known categorical names', () => {
    expect(inferSemanticRole('title', 'string')).toBe('categorical');
    expect(inferSemanticRole('status', 'string')).toBe('categorical');
    expect(inferSemanticRole('type', 'string')).toBe('categorical');
  });

  it('infers common semantic metadata roles', () => {
    expect(inferSemanticRole('external_key', 'string')).toBe('identifier');
    expect(inferSemanticRole('display_name', 'string')).toBe('name');
    expect(inferSemanticRole('billing_address', 'string')).toBe('address');
    expect(inferSemanticRole('email', 'string')).toBe('email');
    expect(inferSemanticRole('phone_number', 'string')).toBe('phone');
    expect(inferSemanticRole('website_url', 'string')).toBe('url');
    expect(inferSemanticRole('currency_code', 'string')).toBe('currency');
    expect(inferSemanticRole('total_amount', 'number')).toBe('currency');
    expect(inferSemanticRole('order_count', 'integer')).toBe('count');
    expect(inferSemanticRole('conversion_rate', 'number')).toBe('rate');
  });

  it('returns undefined for unrecognized patterns', () => {
    expect(inferSemanticRole('data', 'object')).toBeUndefined();
  });
});

describe('humanize', () => {
  it('converts snake_case to human-readable', () => {
    expect(humanize('created_at')).toBe('Created at');
    expect(humanize('user_name')).toBe('User name');
    expect(humanize('id')).toBe('Id');
  });
});
