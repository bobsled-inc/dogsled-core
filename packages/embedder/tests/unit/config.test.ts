import { describe, expect, it } from 'vitest';

import { EmbedderConfigSchema, type EmbedderConfig } from '../../src/config.js';

const streams = { docs: [{ field: 'body' }] };

describe('provider: host config', () => {
  it.each([
    { provider: 'host', streams },
    { provider: 'host', streams, dimension: 1024 },
    { provider: 'host', streams, auth_env_vars: ['HOST_SOURCE_TOKEN'] },
  ])('accepts %j', (config) => {
    expect(EmbedderConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    ['model', 'acme-embed-1'],
    ['api_key', '$OPENAI_API_KEY'],
    ['region', 'us-east-1'],
    ['base_url', 'https://host.example'],
    ['cost_budget_usd', 1],
    ['url', 'https://host.example'],
    ['dimension', 0],
    ['dimension', 1.5],
    ['dimension', '1024'],
    ['streams', {}],
    ['streams', { docs: [] }],
    ['auth_env_vars', ['not a name']],
  ])('rejects %s %j', (key, value) => {
    const result = EmbedderConfigSchema.safeParse({ provider: 'host', streams, [key]: value });
    expect(result.success).toBe(false);
  });

  it('says where a host model comes from', () => {
    const result = EmbedderConfigSchema.safeParse({ provider: 'host', streams, model: 'x' });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['model'],
        message: expect.stringContaining('the host application supplies the model'),
      }),
    ]);
  });

  it('keeps properties that other providers share readable on the whole union', () => {
    const config: EmbedderConfig = EmbedderConfigSchema.parse({ provider: 'host', streams });
    const model: string | undefined = config.model;
    const budget: number | undefined = config.cost_budget_usd;
    expect([model, budget]).toEqual([undefined, undefined]);
    expect(Object.keys(config)).toEqual(['provider', 'streams']);
  });

  it.each(['DOGSLED_HOST_EMBEDDING_URL', 'DOGSLED_HOST_EMBEDDING_TOKEN'])(
    'never lets another provider read %s as its key',
    (name) => {
      const config = { provider: 'openai', model: 'text-embedding-3-small', streams };
      for (const placeholder of [`$${name}`, `\${{ env.${name} }}`]) {
        const result = EmbedderConfigSchema.safeParse({
          ...config,
          api_key: placeholder,
          auth_env_vars: [name],
        });
        expect(result.success).toBe(false);
        expect(
          EmbedderConfigSchema.safeParse({ ...config, api_key: placeholder }).error?.message
        ).toContain('reserved');
      }
    }
  );
});
