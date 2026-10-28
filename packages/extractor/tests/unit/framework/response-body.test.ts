import { describe, expect, it, vi } from 'vitest';

import {
  limitResponseBody,
  readResponseTextWithLimit,
  ResponseBodyLimitError,
} from '../../../src/framework/core/response-body.js';

describe('bounded response bodies', () => {
  it('accepts a body exactly at the byte limit', async () => {
    const response = new Response('12345');
    await expect(readResponseTextWithLimit(response, 5, 'test response')).resolves.toBe('12345');
  });

  it('rejects an oversized declared Content-Length before reading', async () => {
    const response = new Response('small', {
      headers: { 'content-length': '1000' },
    });
    await expect(readResponseTextWithLimit(response, 10, 'test response')).rejects.toEqual(
      expect.objectContaining({
        name: 'ResponseBodyLimitError',
        maxBytes: 10,
      })
    );
  });

  it('counts decoded stream bytes instead of trusting compressed Content-Length', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123456'));
        },
        cancel,
      }),
      {
        headers: {
          'content-encoding': 'gzip',
          'content-length': '2',
        },
      }
    );

    await expect(readResponseTextWithLimit(response, 5, 'decoded response')).rejects.toBeInstanceOf(
      ResponseBodyLimitError
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds each SSE event without imposing a lifetime-wide stream cap', async () => {
    const original = new Response('data: a\n\ndata: b\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    const limited = limitResponseBody(original, 9, 'MCP SSE event', {
      resetAtSseEventBoundary: true,
    });

    await expect(limited.text()).resolves.toBe('data: a\n\ndata: b\n\n');
  });

  it('rejects a single oversized SSE event', async () => {
    const original = new Response('data: 123456789\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    const limited = limitResponseBody(original, 10, 'MCP SSE event', {
      resetAtSseEventBoundary: true,
    });

    await expect(limited.text()).rejects.toBeInstanceOf(ResponseBodyLimitError);
  });
});
