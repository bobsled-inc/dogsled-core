/**
 * Wait for a shared producer with caller-scoped cancellation.
 *
 * Aborting one caller stops only that caller's wait; it does not cancel or
 * otherwise affect the producer shared by other callers.
 */
export function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    // Close the race where abort fires between throwIfAborted() and listener
    // registration.
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}
