import { describe, expect, it } from 'vitest';

import {
  serializeErrorCause,
  DogsledRuntimeError,
  DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES,
} from '../../src/runtime-error.js';

describe('DogsledRuntimeError', () => {
  it('carries the stable public contract and preserves the original cause identity', () => {
    const cause = new Error('provider returned a private diagnostic');
    const error = new DogsledRuntimeError({
      kind: 'provider',
      code: 'MODEL_PROJECT_LOAD_PROVIDER_FAILURE',
      operation: 'model.project.load',
      retryable: true,
      providerStatus: 503,
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DogsledRuntimeError');
    expect(error.message).toBe(DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES.provider);
    expect(error.publicMessage).toBe(DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES.provider);
    expect(error.kind).toBe('provider');
    expect(error.code).toBe('MODEL_PROJECT_LOAD_PROVIDER_FAILURE');
    expect(error.operation).toBe('model.project.load');
    expect(error.retryable).toBe(true);
    expect(error.providerStatus).toBe(503);
    expect(error.cause).toBe(cause);
  });

  it.each([
    ['auth', false],
    ['validation', false],
    ['provider', true],
    ['timeout', true],
    ['cancellation', false],
    ['internal', false],
  ] as const)('uses the stable %s public message', (kind, retryable) => {
    const error = new DogsledRuntimeError({
      kind,
      code: `TEST_${kind.toUpperCase()}`,
      operation: 'test.operation',
      retryable,
    });

    expect(error.message).toBe(DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES[kind]);
    expect(error.publicMessage).toBe(DOGSLED_RUNTIME_ERROR_PUBLIC_MESSAGES[kind]);
  });
});

describe('serializeErrorCause', () => {
  it('preserves useful fields and a nested cause as JSON', () => {
    const providerCause = Object.assign(new Error('HubSpot said the property does not exist'), {
      code: 'PROPERTY_DOES_NOT_EXIST',
      status: 400,
    });
    const cause = new Error('Request failed', { cause: providerCause });

    expect(serializeErrorCause(cause)).toEqual({
      name: 'Error',
      message: 'Request failed',
      cause: {
        name: 'Error',
        message: 'HubSpot said the property does not exist',
        code: 'PROPERTY_DOES_NOT_EXIST',
        status: 400,
      },
    });
    expect(() => JSON.stringify(serializeErrorCause(cause))).not.toThrow();
  });

  it('stops circular cause chains', () => {
    const cause = new Error('circular') as Error & { cause?: unknown };
    cause.cause = cause;

    expect(serializeErrorCause(cause)).toEqual({ name: 'Error', message: 'circular' });
  });
});
