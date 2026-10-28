import { describe, it, expect } from 'vitest';

import { MetaSpecSchema, SourceSpecSchema } from '../src/validate.js';

const baseSource = {
  auth_env_vars: ['LANGSMITH_API_KEY'],
  spec_version: '2',
  type: 'source',
  name: 'langsmith',
  transports: [
    {
      id: 'default',
      base_url: 'https://api.smith.langchain.com',
      auth: { type: 'api-key', header: 'x-api-key', key: '${{ env.LANGSMITH_API_KEY }}' },
    },
  ],
  default_transport: 'default',
};

describe('custom_api meta schema', () => {
  it('accepts a meta.yml without auth_setup', () => {
    const result = MetaSpecSchema.safeParse({
      display_name: 'LangSmith',
      category: 'developer-tools',
      tags: ['observability'],
      docs_url: 'https://docs.smith.langchain.com',
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a meta.yml with auth_setup', () => {
    const result = MetaSpecSchema.safeParse({
      display_name: 'LangSmith',
      category: 'developer-tools',
      tags: ['observability'],
      docs_url: 'https://docs.smith.langchain.com',
      auth_setup: [{ env: 'LANGSMITH_API_KEY', description: 'API key' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('custom_api source schema', () => {
  it('accepts source_type: custom_api with auth_env_vars', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseSource,
      source_type: 'custom_api',
      auth_env_vars: ['LANGSMITH_API_KEY'],
    });
    expect(result.success).toBe(true);
  });

  it('tolerates the dogsled_source_kind extension key by stripping it', () => {
    const result = SourceSpecSchema.safeParse({
      ...baseSource,
      source_type: 'custom_api',
      dogsled_source_kind: 'custom_api',
      auth_env_vars: ['LANGSMITH_API_KEY'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('dogsled_source_kind' in result.data).toBe(false);
    }
  });

  it('still rejects unknown non-extension top-level keys (strict)', () => {
    const result = SourceSpecSchema.safeParse({ ...baseSource, totally_unknown: true });
    expect(result.success).toBe(false);
  });
});
