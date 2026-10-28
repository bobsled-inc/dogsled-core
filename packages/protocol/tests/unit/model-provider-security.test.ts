import { describe, expect, it } from 'vitest';
import { ModelConnectionSchema } from '../../src/config-contracts.js';

describe('model provider configuration security', () => {
  it.each([
    'evil.example#',
    'us-east-1@example.com',
    'us-east-1/path',
    'us-east-1?x',
    'US-east-1',
    'us-east-123',
  ])('rejects hostile Bedrock region %s', (region) => {
    expect(
      ModelConnectionSchema.safeParse({ provider: 'amazon-bedrock', model: 'test', region }).success
    ).toBe(false);
  });
  it.each(['us-east-1', 'us-gov-west-1', 'eu-central-2'])('accepts region %s', (region) => {
    expect(
      ModelConnectionSchema.safeParse({ provider: 'amazon-bedrock', model: 'test', region }).success
    ).toBe(true);
  });
  it.each([
    'http://remote.example/api',
    'http://localhost.evil.example',
    'http://127.0.0.1.example',
    'ftp://127.0.0.1/api',
  ])('rejects unsafe Ollama URL %s', (base_url) => {
    expect(
      ModelConnectionSchema.safeParse({ provider: 'ollama', model: 'test', base_url }).success
    ).toBe(false);
  });
  it.each([
    'https://remote.example/api',
    'http://localhost:11434/api',
    'http://127.0.0.1:11434/api',
    'http://[::1]:11434/api',
  ])('accepts Ollama URL %s', (base_url) => {
    expect(
      ModelConnectionSchema.safeParse({ provider: 'ollama', model: 'test', base_url }).success
    ).toBe(true);
  });
  it.each(['$UNRELATED_SECRET', '${{ env.UNRELATED_SECRET }}'])(
    'requires a declaration for %s',
    (api_key) => {
      const config = { provider: 'openai', model: 'test', api_key };
      expect(ModelConnectionSchema.safeParse(config).success).toBe(false);
      expect(
        ModelConnectionSchema.safeParse({ ...config, auth_env_vars: ['UNRELATED_SECRET'] }).success
      ).toBe(true);
    }
  );
  it('preserves standard provider names', () => {
    expect(
      ModelConnectionSchema.safeParse({
        provider: 'openai',
        model: 'test',
        api_key: '$OPENAI_API_KEY',
      }).success
    ).toBe(true);
  });
});
