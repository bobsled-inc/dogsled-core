import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  DownloadFileOptions,
  DownloadedFile,
  FileStorageClient,
  ListedFile,
  ListFilesOptions,
} from '../../framework/core/index.js';
import {
  isPrivateHost,
  isSameOrigin,
  resolveAndValidateHost,
  safeFetch,
  sanitizeUrlForError,
} from '../../framework/core/index.js';
import {
  ExtractorConfigError,
  ExtractorDataError,
  ExtractorTransientError,
  withRetry,
} from '../errors.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
  RETRYABLE_STATUSES,
  addCleanupFailure,
  classifyDownloadError,
  type ResponseMetadata,
  type VercelBlobAuth,
  type VercelBlobConnection,
  parseAllowedOrigin,
  parseSignedUrl,
  readRequiredEnv,
  responseMetadata,
  safeError,
  toNodeReadable,
  validateBlobReference,
  validatePublicBlobHosts,
  validateSignedUrlPath,
} from './vercel-blob-file-utils.js';

interface SourceFingerprint {
  hasResponse?: boolean;
  etag?: string;
  lastModified?: string;
  size?: number;
}

function assertStableFingerprint(
  label: string,
  observed: string | number | undefined,
  next: string | number | undefined
): void {
  if (observed === undefined && next === undefined) return;
  if (observed === undefined || next === undefined || observed !== next) {
    throw new ExtractorDataError(`Vercel Blob object metadata changed during a retry (${label})`);
  }
}

function recordFingerprint(observed: SourceFingerprint, metadata: ResponseMetadata): void {
  const next: SourceFingerprint = {
    etag: metadata.etag,
    lastModified: metadata.lastModified,
    size: metadata.contentLength,
  };
  if (observed.hasResponse) {
    assertStableFingerprint('etag', observed.etag, next.etag);
    assertStableFingerprint('last-modified', observed.lastModified, next.lastModified);
    assertStableFingerprint('size', observed.size, next.size);
  }
  observed.hasResponse = true;
  if (observed.etag === undefined && next.etag !== undefined) observed.etag = next.etag;
  if (observed.lastModified === undefined && next.lastModified !== undefined) {
    observed.lastModified = next.lastModified;
  }
  if (observed.size === undefined && next.size !== undefined) observed.size = next.size;
}

export class VercelBlobFileStorageClient implements FileStorageClient {
  private readonly blobRef: string;
  private readonly signedUrl: string;
  private readonly allowedOrigin: string;
  private readonly maxBytes: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  private constructor(connection: VercelBlobConnection, signedUrl: string, allowedOrigin: string) {
    this.blobRef = validateBlobReference(connection.blob_ref);
    this.signedUrl = signedUrl;
    this.allowedOrigin = allowedOrigin;
    this.maxBytes = connection.max_bytes ?? DEFAULT_MAX_BYTES;
    this.maxRetries = connection.max_retries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = connection.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = connection.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  static async create(
    connection: VercelBlobConnection,
    auth: VercelBlobAuth,
    authEnvVars: readonly string[] = []
  ): Promise<VercelBlobFileStorageClient> {
    assertDeclaredEnvironmentReferences(auth, authEnvVars);
    if (auth.type !== 'signed_url_env') {
      throw new ExtractorConfigError(`Unsupported Vercel Blob auth type: ${String(auth.type)}`);
    }

    const allowedOrigin = parseAllowedOrigin(readRequiredEnv(auth.origin_env, 'origin_env'));
    const signedUrl = parseSignedUrl(readRequiredEnv(auth.url_env, 'url_env'), allowedOrigin);
    const blobRef = validateBlobReference(connection.blob_ref);
    validateSignedUrlPath(signedUrl, blobRef);
    await validatePublicBlobHosts(signedUrl, allowedOrigin);
    return new VercelBlobFileStorageClient(connection, signedUrl, allowedOrigin);
  }

  async *list(options: ListFilesOptions): AsyncGenerator<ListedFile> {
    const requested = validateBlobReference(options.path);
    if (requested !== this.blobRef) {
      throw new ExtractorConfigError(
        'Vercel Blob resource source.path must equal connection.blob_ref'
      );
    }
    if (options.maxFiles === 0) return;
    yield {
      path: this.blobRef,
      uri: `vercel-blob://${this.blobRef
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`,
    };
  }

  async download(
    file: ListedFile,
    targetPath: string,
    options: DownloadFileOptions = {}
  ): Promise<DownloadedFile> {
    if (validateBlobReference(file.path) !== this.blobRef) {
      throw new ExtractorConfigError(
        'Vercel Blob download reference does not match connection.blob_ref'
      );
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    const observedFingerprint: SourceFingerprint = {};

    return await withRetry(
      async () => await this.downloadAttempt(file, targetPath, options.signal, observedFingerprint),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
        maxDelayMs: 5_000,
        signal: options.signal,
      }
    );
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  private async downloadAttempt(
    file: ListedFile,
    targetPath: string,
    callerSignal: AbortSignal | undefined,
    observedFingerprint: SourceFingerprint
  ): Promise<DownloadedFile> {
    let response: Response | undefined;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    try {
      response = await this.fetchWithRedirects(requestSignal, observedFingerprint);
      const metadata = responseMetadata(response);
      if (metadata.contentLength !== undefined && metadata.contentLength > this.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ExtractorDataError(
          `Vercel Blob object exceeds the ${this.maxBytes} byte download limit`
        );
      }
      if (!response.body) {
        throw new ExtractorDataError(
          `Vercel Blob object ${file.uri} returned no response body (status ${response.status})`
        );
      }

      const digest = createHash('sha256');
      let bytesDownloaded = 0;
      const meter = new Transform({
        transform: (chunk: unknown, _encoding, callback) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          bytesDownloaded += value.byteLength;
          if (bytesDownloaded > this.maxBytes) {
            callback(
              new ExtractorDataError(
                `Vercel Blob object exceeds the ${this.maxBytes} byte download limit`
              )
            );
            return;
          }
          digest.update(value);
          callback(null, value);
        },
      });
      await pipeline(
        toNodeReadable(response.body),
        meter,
        createWriteStream(targetPath, { flags: 'w' }),
        { signal: requestSignal }
      );

      if (metadata.contentLength !== undefined && metadata.contentLength !== bytesDownloaded) {
        throw new ExtractorTransientError(
          `Vercel Blob object transfer ended at ${bytesDownloaded} bytes; expected ${metadata.contentLength}`
        );
      }

      file.size = bytesDownloaded;
      file.last_modified = metadata.lastModified;
      file.etag = metadata.etag ?? `sha256:${digest.digest('hex')}`;
      recordFingerprint(observedFingerprint, {
        etag: metadata.etag,
        lastModified: metadata.lastModified,
        contentLength: metadata.contentLength,
      });
      return { file, path: targetPath, bytes_downloaded: bytesDownloaded };
    } catch (error) {
      await response?.body?.cancel().catch(() => undefined);
      let cleanupFailure: Error | undefined;
      try {
        await rm(targetPath, { force: true });
      } catch (cleanupError) {
        cleanupFailure ??= safeError(cleanupError);
      }
      const classified = classifyDownloadError(
        error,
        callerSignal,
        timeoutSignal,
        this.timeoutMs,
        this.signedUrl
      );
      if (cleanupFailure) {
        throw addCleanupFailure(classified, cleanupFailure, this.signedUrl);
      }
      throw classified;
    }
  }

  private async fetchWithRedirects(
    signal: AbortSignal | undefined,
    observedFingerprint: SourceFingerprint
  ): Promise<Response> {
    let currentUrl = this.signedUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      let response: Response;
      try {
        await resolveAndValidateHost(new URL(currentUrl).hostname, 'Vercel Blob request');
      } catch (error) {
        throw new ExtractorConfigError(
          'Vercel Blob request host failed SSRF validation',
          safeError(error)
        );
      }
      try {
        response = await safeFetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        if (
          error instanceof ExtractorConfigError ||
          error instanceof ExtractorDataError ||
          error instanceof ExtractorTransientError
        ) {
          throw error;
        }
        throw new ExtractorTransientError(
          `Vercel Blob request failed for ${sanitizeUrlForError(currentUrl)}: ${safeError(error).message}`,
          safeError(error)
        );
      }

      if (response.status >= 200 && response.status < 300) {
        recordFingerprint(observedFingerprint, responseMetadata(response));
        return response;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new ExtractorDataError(
            `Vercel Blob request returned redirect ${response.status} without a location`
          );
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch (error) {
          throw new ExtractorConfigError(
            'Vercel Blob redirect location was not a valid URL',
            safeError(error)
          );
        }
        if (
          redirectUrl.protocol !== 'https:' ||
          !isSameOrigin(redirectUrl.origin, this.allowedOrigin) ||
          redirectUrl.username ||
          redirectUrl.password ||
          isPrivateHost(redirectUrl.hostname)
        ) {
          throw new ExtractorConfigError(
            `Vercel Blob redirect to ${redirectUrl.origin} was blocked because it is outside the allowed origin`
          );
        }
        validateSignedUrlPath(redirectUrl.toString(), this.blobRef);
        try {
          await resolveAndValidateHost(redirectUrl.hostname, 'Vercel Blob redirect');
        } catch (error) {
          throw new ExtractorConfigError(
            'Vercel Blob redirect host failed SSRF validation',
            safeError(error)
          );
        }
        currentUrl = redirectUrl.toString();
        continue;
      }

      await response.body?.cancel().catch(() => undefined);
      const safeUrl = sanitizeUrlForError(currentUrl);
      if (response.status === 401 || response.status === 403) {
        throw new ExtractorConfigError(
          `Vercel Blob signed URL was rejected with HTTP ${response.status} for ${safeUrl}; issue a fresh object-scoped signed URL`,
          undefined,
          'auth_failure'
        );
      }
      if (response.status === 404) {
        throw new ExtractorDataError(`Vercel Blob object was not found (HTTP 404) for ${safeUrl}`);
      }
      if (RETRYABLE_STATUSES.has(response.status)) {
        throw new ExtractorTransientError(
          `Vercel Blob provider returned HTTP ${response.status} for ${safeUrl}`
        );
      }
      throw new ExtractorDataError(
        `Vercel Blob provider returned HTTP ${response.status} for ${safeUrl}`
      );
    }
    throw new ExtractorTransientError(
      `Vercel Blob request exceeded ${MAX_REDIRECTS} redirects for ${sanitizeUrlForError(this.signedUrl)}`
    );
  }
}
