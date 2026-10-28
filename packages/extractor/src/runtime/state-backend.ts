/**
 * State backend URL parsing and factory.
 *
 * Supports file:// URLs (local disk, default) and http(s):// URLs (remote HTTP state backend).
 * The HTTP backend serves host applications and OSS users running Dogsled
 * inside an ephemeral container who needs durable state outside the filesystem.
 */

import { assertPathContained } from '../commands/common.js';
import { safeFetch } from '../framework/core/ssrf.js';
import { isNonPublicHost, isPrivateHost } from '../framework/core/shared.js';
import {
  readResponseJsonWithLimit,
  RESPONSE_BODY_LIMITS,
  ResponseBodyLimitError,
} from '../framework/core/response-body.js';
import { ExtractorStateSchema } from '../schemas/state.js';
import type { ExtractorState } from '../types/index.js';

import { ExtractorConfigError, ExtractorDataError, ExtractorTransientError } from './errors.js';
import { FileStateStore, type StateStore } from './state.js';

function httpErrorFromStatus(op: 'load' | 'save', status: number): Error {
  const message = `HTTP state backend ${op} returned ${status}`;
  if (status >= 500 || status === 429 || status === 412) {
    // 412 means another writer won the etag race — retry reads and compose.
    return new ExtractorTransientError(message);
  }
  if (status === 401 || status === 403) {
    return new ExtractorConfigError(message);
  }
  if (status >= 400 && status < 500) {
    return new ExtractorDataError(message);
  }
  return new Error(message);
}

export type FetchLike = typeof fetch;

export interface HttpStateStoreOptions {
  url: string;
  fetch?: FetchLike;
  authToken?: string;
  timeoutMs?: number;
}

export class HttpStateStore implements StateStore {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private lastEtag?: string;

  constructor(opts: HttpStateStoreOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetch ?? safeFetch;
    this.authToken = opts.authToken;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async load(): Promise<ExtractorState> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: this.buildHeaders(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network/DNS/TLS failures are transient and retryable.
      throw new ExtractorTransientError(
        `HTTP state backend load failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }

    this.captureEtag(response);

    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { streams: {} };
    }

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw httpErrorFromStatus('load', response.status);
    }

    let body: unknown;
    try {
      body = await readResponseJsonWithLimit(
        response,
        RESPONSE_BODY_LIMITS.state,
        'HTTP state backend response'
      );
    } catch (err) {
      if (err instanceof ResponseBodyLimitError) {
        throw new ExtractorDataError(err.message, err);
      }
      // Invalid JSON from a 2xx response is a data error — server contract broken, not transient.
      throw new ExtractorDataError(
        `HTTP state backend returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
    const parsed = ExtractorStateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExtractorDataError(
        `HTTP state backend returned invalid state: ${parsed.error.issues.map((i) => i.message).join(', ')}`
      );
    }
    return parsed.data;
  }

  async save(state: ExtractorState): Promise<void> {
    const headers: Record<string, string> = {
      ...this.buildHeaders(),
      'Content-Type': 'application/json',
    };
    if (this.lastEtag) {
      headers['If-Match'] = this.lastEtag;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(state),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ExtractorTransientError(
        `HTTP state backend save failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw httpErrorFromStatus('save', response.status);
    }

    this.captureEtag(response);
    await response.body?.cancel().catch(() => undefined);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authToken) {
      // Strip CR/LF defensively — prevents header injection if the token env
      // var was set from an untrusted source.
      const sanitized = this.authToken.replace(/[\r\n]/g, '');
      headers['Authorization'] = `Bearer ${sanitized}`;
    }
    return headers;
  }

  private captureEtag(response: Response): void {
    // Always overwrite — a 2xx without an ETag must clear stale validators so
    // subsequent PUTs don't send an If-Match for a version the server forgot.
    this.lastEtag = response.headers.get('etag') ?? undefined;
  }
}

export type StateBackendSpec = { kind: 'file'; path: string } | { kind: 'http'; url: string };

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/**
 * Raw check for loopback or private/link-local hostnames. Unlike `isPrivateHost` in
 * framework/core/shared, this does NOT honour `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS` —
 * the opt-in escape hatch for private hosts should not also whitelist cleartext-http
 * bearer tokens to public endpoints.
 */
function isLoopbackOrPrivate(hostname: string): boolean {
  return isNonPublicHost(hostname);
}

export function parseStateBackendUrl(url: string): StateBackendSpec {
  const match = SCHEME_RE.exec(url);

  if (!match) {
    // Bare path (no scheme) — treat as local file path.
    return { kind: 'file', path: url };
  }

  const scheme = match[1]!.toLowerCase();

  if (scheme === 'file') {
    return { kind: 'file', path: url.slice(match[0].length) };
  }

  if (scheme === 'http' || scheme === 'https') {
    return { kind: 'http', url };
  }

  throw new ExtractorConfigError(`Unsupported state backend URL scheme "${scheme}": ${url}`);
}

export interface CreateStateStoreOptions {
  /**
   * Name of an environment variable holding a bearer token to send as
   * `Authorization: Bearer <value>` on every state request. Ignored by the file backend.
   */
  authTokenEnv?: string;

  /**
   * Override fetch implementation for testing. Defaults to globalThis.fetch.
   */
  fetch?: FetchLike;
}

export interface ResolveStateStoreOptions {
  /** Fallback path used when no backend URL is provided (CLI default behaviour). */
  defaultStateDir: string;

  /** Explicit `--state-backend <url>` flag, if set. */
  stateBackend?: string;

  /**
   * Explicit `--state-auth-env <VAR>` flag, if set.
   * Falls back to the `DOGSLED_STATE_AUTH_ENV` env var when absent.
   */
  stateAuthEnv?: string;

  /**
   * Project root used to contain file-backed state paths. When set, any `file://` or bare-path
   * state backend must resolve inside `projectRoot` (matching the containment contract used
   * elsewhere by the extractor for resource/state directories).
   */
  projectRoot?: string;

  /** Override fetch implementation for testing. */
  fetch?: FetchLike;
}

/**
 * Resolve the extraction `StateStore` honouring (in precedence order):
 * 1. `--state-backend` flag
 * 2. `DOGSLED_STATE_BACKEND` env var
 * 3. local file backend rooted at `defaultStateDir`
 *
 * Auth token env-var comes from `--state-auth-env` flag or `DOGSLED_STATE_AUTH_ENV` env var.
 */
export function resolveStateStore(options: ResolveStateStoreOptions): StateStore {
  const backendUrl = options.stateBackend ?? process.env.DOGSLED_STATE_BACKEND;
  const authTokenEnv = options.stateAuthEnv ?? process.env.DOGSLED_STATE_AUTH_ENV;

  if (!backendUrl) {
    return new FileStateStore(options.defaultStateDir);
  }

  // For file-backed overrides, reuse the extractor's project-root containment contract so
  // `--state-backend=file://../../outside` or `--state-backend=/etc/passwd` can't escape the
  // project tree. HTTP backends aren't subject to filesystem containment.
  if (options.projectRoot) {
    const spec = parseStateBackendUrl(backendUrl);
    if (spec.kind === 'file') {
      assertPathContained(options.projectRoot, spec.path, 'state backend path');
    }
  }

  return createStateStore(backendUrl, {
    authTokenEnv,
    fetch: options.fetch,
  });
}

/**
 * Create a StateStore from a backend URL.
 *
 * Accepts: `file://<path>`, bare paths (treated as file), `http(s)://...`.
 * Bare paths and `file://` resolve to the existing on-disk `FileStateStore`.
 */
export function createStateStore(url: string, options: CreateStateStoreOptions = {}): StateStore {
  const spec = parseStateBackendUrl(url);

  if (spec.kind === 'file') {
    return new FileStateStore(spec.path);
  }

  // SSRF guard: reject private/loopback/link-local hosts unless the operator has
  // explicitly opted in via DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1 (the same
  // escape hatch the extractor uses for VPN warehouse endpoints).
  const parsedUrl = new URL(spec.url);
  if (isPrivateHost(parsedUrl.hostname)) {
    throw new ExtractorConfigError(
      `State backend URL "${spec.url}" resolves to a private host (${parsedUrl.hostname}). ` +
        `Set DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1 to allow this (intended for VPN / on-prem setups).`
    );
  }

  const authToken = options.authTokenEnv ? process.env[options.authTokenEnv] : undefined;

  // Reject explicitly-set-but-empty auth env var — if someone configured it, they intended
  // a real value. Sending `Authorization: Bearer ` is never correct.
  if (
    options.authTokenEnv &&
    options.authTokenEnv in process.env &&
    process.env[options.authTokenEnv] === ''
  ) {
    throw new ExtractorConfigError(
      `State auth env var "${options.authTokenEnv}" is set but empty. Provide a valid bearer token or unset the variable.`
    );
  }

  // Refuse to transmit a bearer token over cleartext HTTP to a non-loopback/non-private host.
  // Loopback is OK for local dev/test; public-internet http is never acceptable with creds.
  // Use a raw loopback/private check here rather than isPrivateHost() because the latter is
  // short-circuited by DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS (the operator opting in to private
  // hosts doesn't mean they want creds leaked to *public* http endpoints).
  if (authToken && parsedUrl.protocol === 'http:' && !isLoopbackOrPrivate(parsedUrl.hostname)) {
    throw new ExtractorConfigError(
      `Refusing to send bearer token over cleartext HTTP to "${parsedUrl.hostname}". Use https:// for authenticated state backends.`
    );
  }

  return new HttpStateStore({
    url: spec.url,
    fetch: options.fetch,
    authToken: authToken || undefined,
  });
}
