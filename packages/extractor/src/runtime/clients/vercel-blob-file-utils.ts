import { Readable } from 'node:stream';

import {
  isPrivateHost,
  isSameOrigin,
  resolveAndValidateHost,
  sanitizeUrlForError,
} from '../../framework/core/index.js';
import { ExtractorConfigError, ExtractorDataError, ExtractorTransientError } from '../errors.js';

export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 262_144_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 250;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface VercelBlobConnection {
  blob_ref: string;
  max_bytes?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  timeout_ms?: number;
}

export interface VercelBlobAuth {
  type: string;
  url_env?: string;
  origin_env?: string;
}

export interface ResponseMetadata {
  etag?: string;
  lastModified?: string;
  contentLength?: number;
}

export function readRequiredEnv(name: string | undefined, field: string): string {
  if (!name) {
    throw new ExtractorConfigError(`Vercel Blob auth ${field} is required`);
  }
  const value = process.env[name];
  if (!value) {
    throw new ExtractorConfigError(`Vercel Blob auth ${field} references missing env var ${name}`);
  }
  return value;
}

export function redactUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => sanitizeUrlForError(raw));
}

export function safeError(error: unknown): Error {
  if (error instanceof Error) {
    const sanitized = new Error(redactUrls(error.message));
    sanitized.name = error.name;
    return sanitized;
  }
  return new Error(redactUrls(String(error)));
}

export function validateBlobReference(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExtractorConfigError(
      'Vercel Blob connection blob_ref must be a non-empty safe reference'
    );
  }
  if (value.includes('?') || value.includes('#') || value.includes('://')) {
    throw new ExtractorConfigError(
      'Vercel Blob connection blob_ref must be a stable object reference, not a URL or glob'
    );
  }
  if (
    value.startsWith('/') ||
    value.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  ) {
    throw new ExtractorConfigError(
      'Vercel Blob connection blob_ref must be a provider-relative pathname'
    );
  }
  if (/[*?[\]{}]/.test(value)) {
    throw new ExtractorConfigError(
      'Vercel Blob source supports one object reference and does not allow glob patterns'
    );
  }
  return value;
}

export function parseAllowedOrigin(rawOrigin: string): string {
  let originUrl: URL;
  try {
    originUrl = new URL(rawOrigin);
  } catch (error) {
    throw new ExtractorConfigError(
      'Vercel Blob auth origin_env must resolve to an HTTPS origin',
      safeError(error)
    );
  }

  if (originUrl.protocol !== 'https:' || originUrl.username || originUrl.password) {
    throw new ExtractorConfigError(
      'Vercel Blob auth origin_env must resolve to an HTTPS origin without credentials'
    );
  }
  if (originUrl.pathname !== '/' || originUrl.search || originUrl.hash) {
    throw new ExtractorConfigError(
      'Vercel Blob auth origin_env must contain only an HTTPS origin, without a path or query'
    );
  }
  return originUrl.origin;
}

export function parseSignedUrl(rawUrl: string, allowedOrigin: string): string {
  let signedUrl: URL;
  try {
    signedUrl = new URL(rawUrl);
  } catch (error) {
    throw new ExtractorConfigError(
      'Vercel Blob auth url_env must resolve to an HTTPS signed URL',
      safeError(error)
    );
  }

  if (signedUrl.protocol !== 'https:' || signedUrl.username || signedUrl.password) {
    throw new ExtractorConfigError(
      'Vercel Blob auth url_env must resolve to an HTTPS signed URL without credentials'
    );
  }
  if (!isSameOrigin(signedUrl.origin, allowedOrigin)) {
    throw new ExtractorConfigError(
      `Vercel Blob signed URL origin "${signedUrl.origin}" does not match the allowed origin "${allowedOrigin}"`
    );
  }
  signedUrl.hash = '';
  return signedUrl.toString();
}

/**
 * Vercel Blob signs the pathname supplied to issueReadUrl. Keep this check at
 * the runtime boundary so a stale or incorrectly paired signed URL cannot be
 * used for a different stable object reference.
 */
export function validateSignedUrlPath(signedUrl: string, blobRef: string): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(signedUrl).pathname).replace(/^\/+/, '');
  } catch (error) {
    throw new ExtractorConfigError(
      'Vercel Blob signed URL contains an invalid object pathname',
      safeError(error)
    );
  }
  if (pathname !== blobRef) {
    throw new ExtractorConfigError(
      'Vercel Blob signed URL pathname does not match connection.blob_ref'
    );
  }
}

export function validatePublicBlobHosts(signedUrl: string, allowedOrigin: string): Promise<void> {
  const signedUrlHost = new URL(signedUrl).hostname;
  const originHost = new URL(allowedOrigin).hostname;
  if (isPrivateHost(signedUrlHost) || isPrivateHost(originHost)) {
    throw new ExtractorConfigError('Vercel Blob signed URL host must be public');
  }
  return resolveAndValidateHost(signedUrlHost, 'Vercel Blob signed URL').then(async () => {
    if (originHost !== signedUrlHost) {
      await resolveAndValidateHost(originHost, 'Vercel Blob allowed origin');
    }
  });
}

export function parseHeaderSize(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function responseMetadata(response: Response): ResponseMetadata {
  const lastModified = response.headers.get('last-modified') ?? undefined;
  let normalizedLastModified: string | undefined;
  if (lastModified) {
    const date = new Date(lastModified);
    if (!Number.isNaN(date.getTime())) normalizedLastModified = date.toISOString();
  }
  const rawEtag = response.headers.get('etag')?.trim();
  const etag = rawEtag?.replace(/^"|"$/g, '') || undefined;
  return {
    etag,
    lastModified: normalizedLastModified,
    contentLength: parseHeaderSize(response.headers.get('content-length')),
  };
}

export function classifyDownloadError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
  signedUrl: string
): Error {
  if (callerSignal?.aborted) {
    return callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
  if (timeoutSignal.aborted) {
    return new ExtractorTransientError(
      `Vercel Blob request timed out after ${timeoutMs}ms for ${sanitizeUrlForError(signedUrl)}`,
      undefined,
      'timeout'
    );
  }
  if (isAbortError(error)) return error instanceof Error ? error : safeError(error);
  if (
    error instanceof ExtractorConfigError ||
    error instanceof ExtractorDataError ||
    error instanceof ExtractorTransientError
  ) {
    return error;
  }
  const cause = safeError(error);
  return new ExtractorTransientError(
    `Vercel Blob download failed for ${sanitizeUrlForError(signedUrl)}: ${cause.message}`,
    cause
  );
}

export function addCleanupFailure(original: Error, cleanup: unknown, signedUrl: string): Error {
  const safeOriginal = safeError(original);
  const safeCleanup = safeError(cleanup);
  const message =
    `Vercel Blob partial-file cleanup failed for ${sanitizeUrlForError(signedUrl)}: ` +
    `${safeCleanup.message}; original error: ${safeOriginal.message}`;
  const cleanupCause = new Error(safeCleanup.message, { cause: safeOriginal });
  cleanupCause.name = safeCleanup.name;
  const wrapped = new Error(message, { cause: cleanupCause });
  wrapped.name = original.name;
  Object.defineProperty(wrapped, 'retryable', { value: false, enumerable: true });
  return wrapped;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function toNodeReadable(body: ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  return Readable.fromWeb(body as globalThis.ReadableStream<Uint8Array>);
}
