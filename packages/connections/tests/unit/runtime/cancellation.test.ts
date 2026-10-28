import { describe, expect, it, vi } from 'vitest';

import {
  isCancellationError,
  runCancellable,
  SqlCancelledError,
} from '../../../src/runtime/cancellation.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runCancellable', () => {
  it('does not start an operation for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => 'done');

    await expect(runCancellable(controller.signal, operation)).rejects.toBeInstanceOf(
      SqlCancelledError
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('waits for both driver cancellation acknowledgement and operation settlement', async () => {
    const controller = new AbortController();
    const cancelAcknowledged = deferred<void>();
    const operationSettled = deferred<string>();
    const cancel = vi.fn(() => cancelAcknowledged.promise);
    const observed: string[] = [];

    const pending = runCancellable(controller.signal, async (register) => {
      register(cancel);
      return operationSettled.promise.finally(() => {
        observed.push('operation_settled');
      });
    });
    void pending.catch(() => {});

    controller.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());

    let publicSettled = false;
    void pending
      .finally(() => {
        publicSettled = true;
      })
      .catch(() => {});

    operationSettled.reject(new Error('driver reports query cancelled'));
    await vi.waitFor(() => expect(observed).toEqual(['operation_settled']));
    await Promise.resolve();
    expect(publicSettled).toBe(false);

    cancelAcknowledged.resolve();
    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(publicSettled).toBe(true);
  });

  it('cancels a handle registered after the signal has already aborted', async () => {
    const controller = new AbortController();
    const handleAvailable = deferred<void>();
    const operationSettled = deferred<string>();
    const cancel = vi.fn(async () => {
      operationSettled.reject(new Error('cancelled by driver'));
    });

    const pending = runCancellable(controller.signal, async (register) => {
      await handleAvailable.promise;
      register(cancel);
      return operationSettled.promise;
    });

    controller.abort();
    handleAvailable.resolve();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('is a pass-through when no signal is supplied', async () => {
    const operation = vi.fn(async () => 'done');

    await expect(runCancellable(undefined, operation)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not misclassify an unrelated AbortError without an aborted operation signal', () => {
    const error = new DOMException('driver timeout', 'AbortError');
    const active = new AbortController();

    expect(isCancellationError(error)).toBe(false);
    expect(isCancellationError(error, active.signal)).toBe(false);
    active.abort();
    expect(isCancellationError(error, active.signal)).toBe(true);
  });
});
