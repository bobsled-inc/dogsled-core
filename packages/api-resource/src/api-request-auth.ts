import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';

const CONTROL_CHARACTER_RE = /[\x00-\x1f\x7f]/;

export type ApiRequestStaticAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; header?: string; query_param?: string; key: string }
  | { type: 'basic'; username: string; password: string }
  | {
      type: 'aws-sigv4';
      region: string;
      service: string;
      access_key_id: string;
      secret_access_key: string;
      session_token?: string;
    };

export interface AppliedApiRequestAuth {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  derivedSecrets: readonly string[];
}

export type ApiRequestTokenPrefixMode = 'oauth2' | 'custom-token';

export const DEFAULT_API_REQUEST_TOKEN_PREFIX = 'Bearer ';

function assertSafeAuthValue(value: string): void {
  if (CONTROL_CHARACTER_RE.test(value)) {
    throw new Error('Authentication values must not contain control characters');
  }
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined ? '=' : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? '=' : alphabet[third & 0x3f];
  }

  return encoded;
}

/**
 * Resolve the Authorization prefix used by both extraction and catalog-only
 * probes. OAuth2 follows provider/configured-prefix precedence and normalizes
 * the separator; custom-token preserves a configured prefix verbatim for
 * compatibility with existing extraction behavior.
 */
export function resolveApiRequestTokenPrefix(params: {
  mode: ApiRequestTokenPrefixMode;
  configuredPrefix?: string;
  providerTokenType?: string;
}): string {
  const selected =
    params.mode === 'oauth2'
      ? params.configuredPrefix || params.providerTokenType || DEFAULT_API_REQUEST_TOKEN_PREFIX
      : (params.configuredPrefix ?? DEFAULT_API_REQUEST_TOKEN_PREFIX);
  assertSafeAuthValue(selected);

  if (params.mode === 'custom-token' && params.configuredPrefix !== undefined) {
    return selected;
  }
  return selected === '' || selected.endsWith(' ') ? selected : `${selected} `;
}

/**
 * Apply an authentication mode that does not require a network exchange.
 * OAuth and custom-token flows are intentionally handled by the catalog probe
 * because their token request must use the caller's network-policy executor.
 */
export async function applyStaticApiRequestAuth(params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  auth: ApiRequestStaticAuth;
}): Promise<AppliedApiRequestAuth> {
  switch (params.auth.type) {
    case 'none':
      return {
        url: params.url,
        headers: { ...params.headers },
        body: params.body,
        derivedSecrets: [],
      };
    case 'bearer':
      assertSafeAuthValue(params.auth.token);
      return {
        url: params.url,
        headers: { ...params.headers, Authorization: `Bearer ${params.auth.token}` },
        body: params.body,
        derivedSecrets: [],
      };
    case 'api-key': {
      assertSafeAuthValue(params.auth.key);
      if (!params.auth.header && !params.auth.query_param) {
        throw new Error('api-key auth requires at least one of "header" or "query_param"');
      }

      const headers = { ...params.headers };
      if (params.auth.header) {
        assertSafeAuthValue(params.auth.header);
        headers[params.auth.header] = params.auth.key;
      }

      let url = params.url;
      if (params.auth.query_param) {
        assertSafeAuthValue(params.auth.query_param);
        const nextUrl = new URL(url);
        nextUrl.searchParams.set(params.auth.query_param, params.auth.key);
        url = nextUrl.toString();
      }

      return { url, headers, body: params.body, derivedSecrets: [] };
    }
    case 'basic': {
      assertSafeAuthValue(params.auth.username);
      assertSafeAuthValue(params.auth.password);
      const payload = encodeBase64Utf8(`${params.auth.username}:${params.auth.password}`);
      return {
        url: params.url,
        headers: {
          ...params.headers,
          Authorization: `Basic ${payload}`,
        },
        body: params.body,
        derivedSecrets: [payload],
      };
    }
    case 'aws-sigv4': {
      assertSafeAuthValue(params.auth.region);
      assertSafeAuthValue(params.auth.service);
      assertSafeAuthValue(params.auth.access_key_id);
      assertSafeAuthValue(params.auth.secret_access_key);
      if (params.auth.session_token !== undefined) {
        assertSafeAuthValue(params.auth.session_token);
      }

      const url = new URL(params.url);
      const body = params.body === undefined ? '' : JSON.stringify(params.body);
      const signer = new SignatureV4({
        service: params.auth.service,
        region: params.auth.region,
        credentials: {
          accessKeyId: params.auth.access_key_id,
          secretAccessKey: params.auth.secret_access_key,
          ...(params.auth.session_token ? { sessionToken: params.auth.session_token } : {}),
        },
        sha256: Sha256,
      });
      const signedRequest = await signer.sign({
        method: params.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname + url.search,
        headers: { ...params.headers },
        body: body || undefined,
      });

      const headers = Object.fromEntries(
        Object.entries(signedRequest.headers).map(([name, value]) => [name, String(value)])
      );
      const authorization = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === 'authorization'
      )?.[1];
      const signature = authorization?.match(/(?:^|,\s*)Signature=([^\s,]+)/)?.[1];

      return {
        url: params.url,
        headers,
        body: params.body,
        derivedSecrets: signature ? [signature] : [],
      };
    }
  }
}
