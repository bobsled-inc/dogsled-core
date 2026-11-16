import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VercelBlobFileStorageClient } from '../../src/runtime/clients/vercel-blob-file-client.js';
import { serializeExtractorErrorCause } from '../../src/runtime/errors.js';

const fsMocks = vi.hoisted(() => ({
  rm: vi.fn(),
  realRm: undefined as typeof import('node:fs/promises').rm | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.realRm = actual.rm;
  fsMocks.rm.mockImplementation(actual.rm);
  return { ...actual, rm: fsMocks.rm };
});

const URL_ENV = 'BOBSLED_CORE_TEST_BLOB_URL';
const ORIGIN_ENV = 'BOBSLED_CORE_TEST_BLOB_ORIGIN';
const originalPrivateHostsValue = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];

function fileRef() {
  return { path: 'attachment-123', uri: 'vercel-blob://attachment-123' };
}

async function createClient(overrides: Record<string, unknown> = {}) {
  process.env[URL_ENV] =
    'https://blob.example.test/attachment-123?token=secret-signed-value&expires=9999999999';
  process.env[ORIGIN_ENV] = 'https://blob.example.test';
  return await VercelBlobFileStorageClient.create(
    {
      blob_ref: 'attachment-123',
      max_retries: 0,
      retry_delay_ms: 0,
      timeout_ms: 5_000,
      ...overrides,
    },
    { type: 'signed_url_env', url_env: URL_ENV, origin_env: ORIGIN_ENV },
    [URL_ENV, ORIGIN_ENV]
  );
}

async function tempTarget(): Promise<{ directory: string; target: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vercel-blob-client-test-'));
  return { directory, target: path.join(directory, 'download.csv') };
}

describe('VercelBlobFileStorageClient', () => {
  beforeEach(() => {
    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
    fsMocks.rm.mockClear();
    fsMocks.rm.mockImplementation(fsMocks.realRm!);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[URL_ENV];
    delete process.env[ORIGIN_ENV];
    if (originalPrivateHostsValue === undefined) {
      delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    } else {
      process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalPrivateHostsValue;
    }
  });

  it('lists exactly one stable object reference and streams CSV bytes with metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('id,name\n1,"Ada, Lovelace"\n', {
        status: 200,
        headers: {
          etag: '"provider-etag"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'content-type': 'text/csv',
        },
      });
    });
    const client = await createClient();
    const files = [];
    for await (const file of client.list({ path: 'attachment-123' })) files.push(file);
    expect(files).toEqual([fileRef()]);

    const { target } = await tempTarget();
    const downloaded = await client.download(files[0]!, target);
    expect(await readFile(target, 'utf8')).toContain('Ada, Lovelace');
    expect(downloaded.bytes_downloaded).toBe(26);
    expect(downloaded.file).toMatchObject({
      etag: 'provider-etag',
      last_modified: '2015-10-21T07:28:00.000Z',
      size: 26,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('token=secret-signed-value');
    expect(calls[0]!.init?.headers).toBeUndefined();
  });

  it('uses a streamed digest when HEAD and provider validators are unavailable', async () => {
    vi.stubGlobal('fetch', async () => new Response('id\n1\n'));
    const client = await createClient();
    const { target } = await tempTarget();
    const [file] = [fileRef()];
    const result = await client.download(file, target);
    expect(result.bytes_downloaded).toBe(5);
    expect(result.file.size).toBe(5);
    expect(result.file.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.file.last_modified).toBeUndefined();
    await expect(stat(target)).resolves.toMatchObject({ size: 5 });
  });

  it('retries transient provider statuses without retrying missing or expired objects', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('temporarily unavailable', { status: 503 })
        : new Response('id\n1\n', { status: 200 });
    });
    const client = await createClient({ max_retries: 1 });
    const { target } = await tempTarget();
    await expect(client.download(fileRef(), target)).resolves.toMatchObject({
      bytes_downloaded: 5,
    });
    expect(attempts).toBe(2);

    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
    const missingTarget = path.join(path.dirname(target), 'missing.csv');
    await expect(client.download(fileRef(), missingTarget)).rejects.toThrow(/HTTP 404/);
    expect(attempts).toBe(2);

    vi.stubGlobal('fetch', async () => new Response('expired', { status: 403 }));
    await expect(client.download(fileRef(), missingTarget)).rejects.toThrow(/fresh object-scoped/);
    expect(existsSync(missingTarget)).toBe(false);
  });

  it('does not treat an error response validator as the downloaded object digest', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('provider error', {
            status: 503,
            headers: { etag: '"error-response"' },
          })
        : new Response('id\n1\n', { status: 200 });
    });
    const client = await createClient({ max_retries: 1 });
    const { target } = await tempTarget();
    const result = await client.download(fileRef(), target);
    expect(result.file.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(attempts).toBe(2);
  });

  it('rejects a source fingerprint that changes between retry attempts', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('id\n'));
                controller.error(new Error('connection reset'));
              },
            }),
            { status: 200, headers: { etag: '"first-version"' } }
          )
        : new Response('id\n1\n', {
            status: 200,
            headers: { etag: '"second-version"' },
          });
    });
    const client = await createClient({ max_retries: 1 });
    const { target } = await tempTarget();
    await expect(client.download(fileRef(), target)).rejects.toThrow(/metadata changed/);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a retry when an observed ETag disappears', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('id\n'));
                controller.error(new Error('connection reset'));
              },
            }),
            { status: 200, headers: { etag: '"first-version"' } }
          )
        : new Response('id\n2\n', { status: 200 });
    });
    const client = await createClient({ max_retries: 1 });
    const { target } = await tempTarget();
    await expect(client.download(fileRef(), target)).rejects.toThrow(/metadata changed/);
    expect(existsSync(target)).toBe(false);
    expect(attempts).toBe(2);
  });

  it('rejects a retry when an ETag first appears', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('id\n'));
                controller.error(new Error('connection reset'));
              },
            }),
            { status: 200 }
          )
        : new Response('id\n2\n', {
            status: 200,
            headers: { etag: '"second-version"' },
          });
    });
    const client = await createClient({ max_retries: 1 });
    const { target } = await tempTarget();
    await expect(client.download(fileRef(), target)).rejects.toThrow(/metadata changed/);
    expect(existsSync(target)).toBe(false);
    expect(attempts).toBe(2);
  });

  it('accepts same-origin redirects and blocks cross-origin credential forwarding', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: '/attachment-123?token=redirect-secret' },
        });
      }
      return new Response('id\n1\n', { status: 200 });
    });
    const client = await createClient();
    const { target } = await tempTarget();
    await expect(client.download(fileRef(), target)).resolves.toMatchObject({
      bytes_downloaded: 5,
    });
    expect(calls[1]).toContain('blob.example.test/attachment-123?token=redirect-secret');

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.test/download.csv?token=leaked' },
        })
    );
    const blockedTarget = path.join(path.dirname(target), 'blocked.csv');
    await expect(client.download(fileRef(), blockedTarget)).rejects.toThrow(
      /outside the allowed origin/
    );
    expect(existsSync(blockedTarget)).toBe(false);

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://user:password@blob.example.test/attachment-123' },
        })
    );
    const credentialTarget = path.join(path.dirname(target), 'credential-redirect.csv');
    await expect(client.download(fileRef(), credentialTarget)).rejects.toThrow(
      /outside the allowed origin/
    );
    expect(existsSync(credentialTarget)).toBe(false);
  });

  it('removes partial files after interrupted transfers and on cancellation', async () => {
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id\n1\n'));
        controller.error(new Error('connection reset'));
      },
    });
    vi.stubGlobal('fetch', async () => new Response(interrupted, { status: 200 }));
    const client = await createClient();
    const { target } = await tempTarget();
    await expect(client.download(fileRef(), target)).rejects.toThrow(
      /download failed|connection reset/
    );
    expect(existsSync(target)).toBe(false);

    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(init?.signal?.reason ?? new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) {
            abort();
          } else {
            init?.signal?.addEventListener('abort', abort, { once: true });
          }
        })
    );
    const cancelledTarget = path.join(path.dirname(target), 'cancelled.csv');
    const pending = client.download(fileRef(), cancelledTarget, { signal: controller.signal });
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(cancelledTarget)).toBe(false);
  });

  it('bounds bytes and cancels a stalled response body at the request timeout', async () => {
    vi.stubGlobal('fetch', async () => new Response('id\n1\n'));
    const limitedClient = await createClient({ max_bytes: 4 });
    const { target } = await tempTarget();
    await expect(limitedClient.download(fileRef(), target)).rejects.toThrow(/download limit/);
    expect(existsSync(target)).toBe(false);

    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id\n'));
      },
    });
    vi.stubGlobal('fetch', async () => new Response(stalled, { status: 200 }));
    const timeoutClient = await createClient({ timeout_ms: 10 });
    const stalledTarget = path.join(path.dirname(target), 'stalled.csv');
    await expect(timeoutClient.download(fileRef(), stalledTarget)).rejects.toThrow(/timed out/);
    expect(existsSync(stalledTarget)).toBe(false);
  });

  it('redacts signed query parameters from provider and body failures', async () => {
    vi.stubGlobal('fetch', async () => new Response('failure', { status: 500 }));
    const client = await createClient();
    const { target } = await tempTarget();
    const providerError = await client.download(fileRef(), target).catch((error: unknown) => error);
    expect(providerError).toBeInstanceOf(Error);
    expect((providerError as Error).message).not.toContain('secret-signed-value');

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(
          new Error(
            'body failed at https://blob.example.test/attachment-123?token=body-secret-value'
          )
        );
      },
    });
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));
    const bodyTarget = path.join(path.dirname(target), 'body-error.csv');
    const bodyError = await client.download(fileRef(), bodyTarget).catch((error: unknown) => error);
    expect(bodyError).toBeInstanceOf(Error);
    expect((bodyError as Error).message).not.toContain('body-secret-value');
    expect(String((bodyError as Error & { cause?: unknown }).cause)).not.toContain(
      'body-secret-value'
    );
  });

  it('surfaces partial-file cleanup failures without exposing signed query parameters', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      throw new Error(
        'download failed at https://blob.example.test/attachment-123?token=body-secret'
      );
    });
    fsMocks.rm.mockRejectedValueOnce(
      new Error('remove failed at https://blob.example.test/attachment-123?token=cleanup-secret')
    );
    const client = await createClient({ max_retries: 1, retry_delay_ms: 0 });
    const { target } = await tempTarget();
    const cleanupError = await client.download(fileRef(), target).catch((error: unknown) => error);

    expect(cleanupError).toMatchObject({ retryable: false });
    expect((cleanupError as Error).message).toContain('partial-file cleanup failed');
    expect((cleanupError as Error).message).toContain('original error:');
    expect((cleanupError as Error).message).not.toContain('body-secret');
    expect((cleanupError as Error).message).not.toContain('cleanup-secret');
    const serialized = serializeExtractorErrorCause(cleanupError);
    expect(serialized?.cause?.message).toContain('remove failed');
    expect(serialized?.cause?.cause?.message).toContain('download failed');
    expect(JSON.stringify(serialized)).not.toContain('body-secret');
    expect(JSON.stringify(serialized)).not.toContain('cleanup-secret');
    expect(attempts).toBe(1);
  });

  it('rejects glob references, mismatched origins, and signed URL credentials', async () => {
    const client = await createClient();
    const files = client.list({ path: 'attachment-*.csv' });
    await expect(files.next()).rejects.toThrow(/does not allow glob/);
    await expect(client.list({ path: 'another-attachment' }).next()).rejects.toThrow(
      /source.path must equal connection.blob_ref/
    );

    process.env[URL_ENV] = 'https://other.example.test/attachment-123?token=secret';
    await expect(
      VercelBlobFileStorageClient.create(
        { blob_ref: 'attachment-123' },
        { type: 'signed_url_env', url_env: URL_ENV, origin_env: ORIGIN_ENV },
        [URL_ENV, ORIGIN_ENV]
      )
    ).rejects.toThrow(/does not match the allowed origin/);

    process.env[URL_ENV] = 'https://blob.example.test/other-object?token=secret';
    await expect(
      VercelBlobFileStorageClient.create(
        { blob_ref: 'attachment-123' },
        { type: 'signed_url_env', url_env: URL_ENV, origin_env: ORIGIN_ENV },
        [URL_ENV, ORIGIN_ENV]
      )
    ).rejects.toThrow(/pathname does not match/);

    process.env[URL_ENV] = 'https://blob.example.test/attachment-123?token=secret';
    process.env[ORIGIN_ENV] = 'https://blob.example.test';
    await expect(
      VercelBlobFileStorageClient.create(
        { blob_ref: 'attachment-123' },
        { type: 'signed_url_env', url_env: URL_ENV, origin_env: ORIGIN_ENV },
        [URL_ENV, ORIGIN_ENV]
      )
    ).resolves.toBeInstanceOf(VercelBlobFileStorageClient);
  });
});
