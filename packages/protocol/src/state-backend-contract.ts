/**
 * HTTP state backend contract shared between `@bobsled-inc/extractor` (consumer, Dogsled CLI)
 * and any implementing server (host application control plane, OSS self-hosted service, etc.).
 *
 * Endpoint: `GET` / `PUT` on `STATE_BACKEND_PATH`.
 *
 * - GET returns the full `ExtractorState` as JSON (the `streams` object). 404 means never-written
 *   and the client treats that as empty state. Responses include an `ETag` header used as
 *   optimistic concurrency token for subsequent PUTs.
 * - PUT body is the full `ExtractorState`. `If-Match` header echoes the last-known ETag.
 *   200 on success. 412 if ETag mismatch (another writer won the race). Error bodies match
 *   `StateBackendErrorResponse`.
 *
 * Auth: `Authorization: Bearer <token>`. Token scheme is server-defined (managed host application
 * uses per-run JWTs embedding the project id claim).
 */

export const STATE_BACKEND_CONTRACT_VERSION = 1 as const;
export type StateBackendContractVersion = typeof STATE_BACKEND_CONTRACT_VERSION;

export const STATE_BACKEND_PATH = '/v1/state' as const;
export type StateBackendPath = typeof STATE_BACKEND_PATH;

/** Error response body returned on non-2xx responses. */
export interface StateBackendErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export function isStateBackendErrorResponse(value: unknown): value is StateBackendErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return typeof code === 'string' && typeof message === 'string';
}
