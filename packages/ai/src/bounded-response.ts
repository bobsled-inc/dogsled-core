/**
 * The response with a body that fails once more than `maxBytes` were read. Fetch
 * decompresses a body before it is read, so the bytes counted are the decoded ones.
 */
export async function boundResponse(
  response: Response,
  maxBytes: number,
  failure: () => Error
): Promise<Response> {
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
}
