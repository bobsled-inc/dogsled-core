import { describe, expect, it } from 'vitest';

import { ModelConnectionSchema as ProtocolModelConnectionSchema } from '@bobsled-inc/protocol';
import { ModelConnectionSchema } from '../../../src/schemas/model.js';

describe('ModelConnectionSchema env placeholders', () => {
  it('re-exports the protocol-owned schema', () => {
    expect(ModelConnectionSchema).toBe(ProtocolModelConnectionSchema);
  });

  it('accepts $VARNAME placeholders for API-key providers', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      api_key: '$OPENAI_API_KEY',
    });

    expect(result.success).toBe(true);
  });

  it('accepts ${{ env.VARNAME }} placeholders for API-key providers', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      api_key: '${{ env.OPENAI_API_KEY }}',
    });

    expect(result.success).toBe(true);
  });

  it('rejects literal API keys', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      api_key: 'raw-secret',
    });

    expect(result.success).toBe(false);
  });

  it('accepts an optional api_key placeholder on Bedrock connections', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      api_key: '$AWS_BEARER_TOKEN_BEDROCK',
    });

    expect(result.success).toBe(true);
  });

  it('still allows Bedrock connections without an api_key', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a literal Bedrock api_key', () => {
    const result = ModelConnectionSchema.safeParse({
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      api_key: 'raw-bedrock-key',
    });

    expect(result.success).toBe(false);
  });
});
