import { describe, expect, it } from 'vitest';

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  classifyMcpError,
  classifyFailureReason,
  isConnectionError,
  ExtractorConfigError,
  ExtractorDataError,
  ExtractorTransientError,
  toExtractorHttpRuntimeError,
  toExtractorMcpRuntimeError,
  toExtractorRuntimeError,
  serializeExtractorErrorCause,
  withRetry,
} from '../../src/runtime/errors.js';

describe('classifyMcpError', () => {
  it('does not classify rate limit text', () => {
    const err = classifyMcpError('Rate limit exceeded. Too many requests.');
    expect(err).toBeInstanceOf(ExtractorTransientError);
    expect(err.message).toBe('Rate limit exceeded. Too many requests.');
  });

  it('does not classify auth text', () => {
    const err = classifyMcpError('Unauthorized: Invalid credentials. Please check your API key.');
    expect(err).toBeInstanceOf(ExtractorTransientError);
    expect(err.message).toBe('Unauthorized: Invalid credentials. Please check your API key.');
  });

  it('does not classify timeout text', () => {
    const err = classifyMcpError('Request timed out after 30s');
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it('classifies unknown text as ExtractorTransientError (default)', () => {
    const err = classifyMcpError('Something completely unexpected happened');
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it('classifies McpError MethodNotFound as config error', () => {
    const err = classifyMcpError(new McpError(ErrorCode.MethodNotFound, 'tool not available'));
    expect(err).toBeInstanceOf(ExtractorConfigError);
  });

  it('classifies McpError InvalidParams as config error', () => {
    const err = classifyMcpError(new McpError(ErrorCode.InvalidParams, 'bad params'));
    expect(err).toBeInstanceOf(ExtractorConfigError);
  });

  it('classifies McpError ConnectionClosed as transient error', () => {
    const cause = new McpError(ErrorCode.ConnectionClosed, 'conn closed');
    const err = classifyMcpError(cause);
    expect(err).toBeInstanceOf(ExtractorTransientError);
    expect(err.cause).toBe(cause);
    expect((toExtractorMcpRuntimeError(err).cause as ExtractorTransientError).cause).toBe(cause);
  });

  it('classifies McpError RequestTimeout as transient error', () => {
    const err = classifyMcpError(new McpError(ErrorCode.RequestTimeout, 'timed out'));
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it('classifies McpError InternalError as transient error', () => {
    const err = classifyMcpError(new McpError(ErrorCode.InternalError, 'internal'));
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it('does NOT classify "User not found" as config error', () => {
    const err = classifyMcpError('User not found');
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it('does not classify unknown tool text', () => {
    const err = classifyMcpError('unknown tool: list_users');
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it('does not classify tool-not-found text', () => {
    const err = classifyMcpError('tool list_items not found');
    expect(err).toBeInstanceOf(ExtractorTransientError);
  });

  it.each([400, 404])('classifies MCP HTTP %s as non-retryable configuration', (status) => {
    const err = classifyMcpError(new StreamableHTTPError(status, 'provider rejected request'));
    const runtime = toExtractorMcpRuntimeError(err);

    expect(err).toBeInstanceOf(ExtractorConfigError);
    expect(runtime).toMatchObject({ retryable: false, providerStatus: status });
  });

  it.each([429, 500, 503])('classifies MCP HTTP %s as retryable provider failure', (status) => {
    const err = classifyMcpError(new StreamableHTTPError(status, 'provider unavailable'));
    const runtime = toExtractorMcpRuntimeError(err);

    expect(err).toBeInstanceOf(ExtractorTransientError);
    expect(runtime).toMatchObject({ retryable: true, providerStatus: status });
  });
});

describe('toExtractorRuntimeError', () => {
  it('constructs a structured provider failure without inspecting the cause message', () => {
    const cause = new Error('provider diagnostic that must stay private');
    const error = toExtractorRuntimeError({
      kind: 'provider',
      code: 'EXTRACTOR_REQUEST_FAILED',
      operation: 'extractor.request',
      retryable: true,
      providerStatus: 502,
      cause,
    });

    expect(error.kind).toBe('provider');
    expect(error.code).toBe('EXTRACTOR_REQUEST_FAILED');
    expect(error.operation).toBe('extractor.request');
    expect(error.retryable).toBe(true);
    expect(error.providerStatus).toBe(502);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('The provider could not complete the operation.');
    expect(toExtractorHttpRuntimeError(error)).toBe(error);
    expect(toExtractorMcpRuntimeError(error)).toBe(error);
  });

  it.each([
    ['auth_failure', 'auth'],
    ['config_error', 'validation'],
  ] as const)('maps HTTP %s structurally', (failureReason, kind) => {
    const cause = new ExtractorConfigError('private detail', undefined, failureReason);
    expect(toExtractorHttpRuntimeError(cause)).toMatchObject({ kind, cause });
  });

  it('serializes the original cause instead of the public wrapper message', () => {
    const error = toExtractorRuntimeError({
      kind: 'provider',
      code: 'EXTRACTOR_REQUEST_FAILED',
      operation: 'extractor.request',
      retryable: false,
      providerStatus: 400,
      cause: new Error('HubSpot rejected the archived property'),
    });

    expect(serializeExtractorErrorCause(error)).toEqual({
      name: 'Error',
      message: 'HubSpot rejected the archived property',
    });
  });
});

describe('classifyFailureReason', () => {
  it.each([
    ['auth', false, 'auth_failure'],
    ['validation', false, 'config_error'],
    ['provider', true, 'transient_error'],
    ['provider', false, 'data_error'],
    ['timeout', true, 'timeout'],
    ['cancellation', false, 'transient_error'],
    ['internal', false, 'transient_error'],
  ] as const)('maps Dogsled %s structurally', (kind, retryable, expected) => {
    const error = toExtractorRuntimeError({ kind, code: 'TEST', operation: 'test', retryable });
    expect(classifyFailureReason(error)).toBe(expected);
  });
});

describe('isConnectionError', () => {
  it('detects McpError ConnectionClosed', () => {
    expect(isConnectionError(new McpError(ErrorCode.ConnectionClosed, 'closed'))).toBe(true);
  });

  it('does not detect connection errors from message text', () => {
    expect(isConnectionError(new Error('socket hang up: ECONNRESET'))).toBe(false);
  });

  it('does not flag normal errors', () => {
    expect(isConnectionError(new Error('rate limit exceeded'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('succeeds on first try', async () => {
    const result = await withRetry(async () => 'ok', { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
  });

  it('retries transient errors', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ExtractorTransientError('transient');
        }
        return 'recovered';
      },
      { maxRetries: 3, baseDelayMs: 1 }
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('does NOT retry config errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ExtractorConfigError('bad config');
        },
        { maxRetries: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrow('bad config');

    expect(attempts).toBe(1);
  });

  it('does NOT retry data errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new ExtractorDataError('bad data');
        },
        { maxRetries: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrow('bad data');

    expect(attempts).toBe(1);
  });

  it('calls onRetry callback before each retry', async () => {
    const retries: Array<{ attempt: number; message: string }> = [];
    let attempts = 0;

    await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ExtractorTransientError(`fail-${attempts}`);
        }
        return 'ok';
      },
      {
        maxRetries: 3,
        baseDelayMs: 1,
        onRetry: (attempt, error) => {
          retries.push({ attempt, message: error.message });
        },
      }
    );

    expect(retries).toHaveLength(2);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.message).toBe('fail-1');
    expect(retries[1]!.attempt).toBe(2);
    expect(retries[1]!.message).toBe('fail-2');
  });
});
