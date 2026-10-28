import { describe, expect, it } from 'vitest';

import { resolveModelConnection } from '../src/index.js';

describe('resolveModelConnection', () => {
  it('resolves model roles from platform.models', () => {
    expect(
      resolveModelConnection('default_embedding_v1', {
        platform: {
          models: {
            default_embedding_v1: {
              provider: 'amazon-bedrock',
              model: 'amazon.titan-embed-text-v2:0',
              region: 'us-east-1',
              dimension: 1024,
            },
          },
        },
      })
    ).toMatchObject({
      provider: 'amazon-bedrock',
      model: 'amazon.titan-embed-text-v2:0',
    });
  });

  it('throws a validation error when a role is missing', () => {
    expect(() => resolveModelConnection('missing', { platform: { models: {} } })).toThrow(
      /missing/
    );
  });
});
