/**
 * Host-owned storage for minted custom-token credentials.
 *
 * The in-process cache only helps callers that share one process. A host that
 * runs operations across many short-lived workers can supply a store so one
 * minted token serves every worker for its lifetime. The store owns
 * cross-worker coordination: when the stored token is missing or inside the
 * expiry buffer, it must call `mint` once and let concurrent callers wait for
 * that result rather than minting their own.
 */

export const CUSTOM_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface CustomTokenGrant {
  token: string;
  /** Epoch milliseconds at which the token stops being valid. */
  expiresAt: number;
}

export interface CustomTokenStoreRequest {
  /** Digest of the interpolated token URL and token request. */
  key: string;
  /** Lifetime the integration declares for a newly minted token. */
  ttlSeconds: number;
  /** A stored token with less remaining lifetime than this must be replaced. */
  expiryBufferMs: number;
  /**
   * Performs one token request. It is independent of any caller's signal so
   * a shared mint survives the cancellation of the caller that started it.
   */
  mint: () => Promise<CustomTokenGrant>;
  /** Cancels this caller's wait only. */
  signal?: AbortSignal;
}

export interface CustomTokenStore {
  get(request: CustomTokenStoreRequest): Promise<CustomTokenGrant>;
  /**
   * Removes `token` after the provider rejected it. A store must leave a
   * different, newer token for the same key in place.
   */
  invalidate(key: string, token: string): Promise<void>;
}
