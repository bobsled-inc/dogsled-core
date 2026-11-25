import { boundResponse } from './bounded-response.js';

export const OPENROUTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;

export function createBoundedOpenRouterFetch(
  fetchImplementation?: typeof fetch,
  maxBytes = OPENROUTER_MAX_RESPONSE_BYTES
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? init : { redirect: 'error' as const, ...init };
    const response = await (fetchImplementation ?? globalThis.fetch)(input, request);
    return boundResponse(
      response,
      maxBytes,
      () => new RangeError(`OpenRouter response exceeded maximum size of ${maxBytes} bytes.`)
    );
  };
}
