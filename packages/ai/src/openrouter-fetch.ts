export const OPENROUTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;

export function createBoundedOpenRouterFetch(
  fetchImplementation?: typeof fetch,
  maxBytes = OPENROUTER_MAX_RESPONSE_BYTES
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? init : { redirect: 'error' as const, ...init };
    const response = await (fetchImplementation ?? globalThis.fetch)(input, request);
    const failure = () =>
      new RangeError(`OpenRouter response exceeded maximum size of ${maxBytes} bytes.`);
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw failure();
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let total = 0;
    let released = false;
    const release = () => {
      if (!released) {
        reader.releaseLock();
        released = true;
      }
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } finally {
              release();
            }
            controller.error(failure());
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
