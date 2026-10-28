import { describe, expect, it } from 'vitest';
import { AuthEnvVarsSchema, getEnvironmentDeclarationError } from '../src/declared-environment.js';
import { DogsledRuntimeError } from '../src/runtime-error.js';
import { ModelConnectionSchema } from '../src/config-contracts.js';
import { validateModelProviderConfig } from '../src/model-provider-security.js';

describe('declaration validation and diagnostics', () => {
  it('validates environment identifiers', () => {
    expect(AuthEnvVarsSchema.safeParse(['_token2', 'SERVICE_TOKEN']).success).toBe(true);
    for (const name of [
      'A.B',
      'A-B',
      '2TOKEN',
      '',
      'A B',
      '__proto__',
      'constructor',
      'prototype',
    ]) {
      expect(AuthEnvVarsSchema.safeParse([name]).success).toBe(false);
    }
  });
  it('unwraps only the safe declaration diagnostic', () => {
    const message = 'Undeclared environment variable: TOKEN. Add TOKEN to auth_env_vars.';
    const wrap = (cause: Error) =>
      new DogsledRuntimeError({
        kind: 'validation',
        code: 'TEST',
        operation: 'test',
        retryable: false,
        cause,
      });
    expect(getEnvironmentDeclarationError(wrap(new Error(message)))).toBe(message);
    expect(getEnvironmentDeclarationError(wrap(new Error('private-value')))).toBeUndefined();
  });
  it.each([
    {
      provider: 'amazon-bedrock',
      region: 'invalid',
      field: 'region',
      message: 'Invalid Bedrock region',
    },
    {
      provider: 'ollama',
      base_url: 'http://remote.example.com',
      field: 'base_url',
      message: 'Ollama base_url must use HTTPS or HTTP on loopback',
    },
  ])('reports a readable $field error at its field', ({ field, message, ...config }) => {
    expect(() => validateModelProviderConfig(config)).toThrow(message);
    const result = ModelConnectionSchema.safeParse({ ...config, model: 'test' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: [field], message })
      );
    }
  });
});
