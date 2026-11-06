export const RESPONSE_BODY_LIMITS = {
  api: 64 * 1024 * 1024,
  error: 64 * 1024,
  iceberg: 16 * 1024 * 1024,
  mcpEvent: 16 * 1024 * 1024,
  mcpJson: 16 * 1024 * 1024,
  state: 8 * 1024 * 1024,
  token: 1024 * 1024,
} as const;

export class ResponseBodyLimitError extends Error {
  readonly maxBytes: number;

  constructor(label: string, maxBytes: number) {
    super(`${label} exceeded the ${maxBytes}-byte response body limit.`);
    this.name = 'ResponseBodyLimitError';
    this.maxBytes = maxBytes;
  }
}

function assertContentLengthWithinLimit(response: Response, maxBytes: number, label: string): void {
  const rawLength = response.headers.get('content-length');
  if (!rawLength) return;
  const contentLength = Number(rawLength);
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw new ResponseBodyLimitError(label, maxBytes);
  }
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Uint8Array> {
  assertContentLengthWithinLimit(response, maxBytes, label);
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const error = new ResponseBodyLimitError(label, maxBytes);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytesWithLimit(response, maxBytes, label));
}

export async function readResponseJsonWithLimit(
  response: Response,
  maxBytes: number,
  label: string
): Promise<unknown> {
  const text = await readResponseTextWithLimit(response, maxBytes, label);
  return JSON.parse(text) as unknown;
}

function createLimitedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
  resetAtSseEventBoundary: boolean
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let measuredBytes = 0;
  let currentLineBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }

        for (const byte of value) {
          measuredBytes += 1;
          if (resetAtSseEventBoundary) {
            if (byte === 0x0a) {
              if (currentLineBytes === 0) {
                measuredBytes = 0;
              }
              currentLineBytes = 0;
            } else if (byte !== 0x0d) {
              currentLineBytes += 1;
            }
          }
          if (measuredBytes > maxBytes) {
            const error = new ResponseBodyLimitError(label, maxBytes);
            await reader.cancel(error).catch(() => undefined);
            reader.releaseLock();
            controller.error(error);
            return;
          }
        }
        controller.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
    },
  });
}

/**
 * Return an equivalent response whose decoded body stream is bounded.
 *
 * Fetch implementations expose decompressed bytes through `response.body`, so
 * the limit applies after gzip/brotli decompression even when Content-Length
 * describes only the compressed representation.
 */
export function limitResponseBody(
  response: Response,
  maxBytes: number,
  label: string,
  options: { resetAtSseEventBoundary?: boolean } = {}
): Response {
  if (!response.body) return response;
  if (!options.resetAtSseEventBoundary) {
    assertContentLengthWithinLimit(response, maxBytes, label);
  }

  return new Response(
    createLimitedStream(response.body, maxBytes, label, options.resetAtSseEventBoundary ?? false),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }
  );
}

const PROVIDER_RESPONSE_BODY_PROPERTY = 'providerResponseBody';
const MAX_PROVIDER_RESPONSE_BODY_DEPTH = 5;

/**
 * Attach the already redacted body of a failed provider response to its error.
 * The property is not enumerable, so error serializers and loggers are unchanged.
 */
export function attachProviderResponseBody<T extends Error>(error: T, body: string | undefined): T {
  if (body) {
    Object.defineProperty(error, PROVIDER_RESPONSE_BODY_PROPERTY, {
      value: body,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return error;
}

/** Return the provider response body attached to an error or one of its causes. */
export function readProviderResponseBody(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth <= MAX_PROVIDER_RESPONSE_BODY_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const body = (current as Record<string, unknown>)[PROVIDER_RESPONSE_BODY_PROPERTY];
    if (typeof body === 'string') return body;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
