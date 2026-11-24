import { getEnvironmentDeclarationError } from '@bobsled-inc/protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BlockList, isIP } from 'node:net';

import { z } from 'zod';

export { isObject } from '@bobsled-inc/protocol';

export const SAFE_NAME_RE = /^[a-z][a-z0-9_]*$/;

export const SpecNameSchema = z.string().regex(SAFE_NAME_RE, 'Must be lowercase snake_case');

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

export const ScalarTypeValues = ['string', 'number', 'integer', 'boolean', 'timestamp'] as const;
export const FieldTypeValues = [...ScalarTypeValues, 'array', 'object'] as const;
export const CursorTypeValues = ['string', 'number', 'integer', 'timestamp', 'lsn'] as const;

export const ScalarTypeSchema = z.enum(ScalarTypeValues);
export const FieldTypeSchema = z.enum(FieldTypeValues);
export const CursorTypeSchema = z.enum(CursorTypeValues);
export type ScalarType = z.infer<typeof ScalarTypeSchema>;
export type FieldType = z.infer<typeof FieldTypeSchema>;
export type CursorType = z.infer<typeof CursorTypeSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const RESTRICTED_HEADERS = [
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'authorization',
] as const;

export const SafeHeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'Must be a valid HTTP header name')
  .refine(
    (value) =>
      !RESTRICTED_HEADERS.includes(value.toLowerCase() as (typeof RESTRICTED_HEADERS)[number]),
    'Cannot override restricted HTTP headers'
  );

export const SafeHeaderValueSchema = z
  .string()
  .refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value),
    'Header values must not contain control characters'
  );

export const SafeHeadersSchema = z.record(SafeHeaderNameSchema, SafeHeaderValueSchema);

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

const URL_TEMPLATE_RE =
  /\$\{\{\s*(?:input|secrets|env|integration)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g;

export function isAbsoluteHttpsUrlTemplate(value: string): boolean {
  return isAbsoluteHttpsUrl(value.replace(URL_TEMPLATE_RE, 'placeholder'));
}

const BLOCKED_HOSTNAMES = new Set(['localhost']);
const ALWAYS_BLOCKED_HOSTNAMES = new Set(['metadata.google.internal']);

// Keep IPv4 and IPv6 rules in separate lists. Node's BlockList treats IPv4
// input as IPv4-mapped IPv6, so placing ::ffff:0:0/96 in a shared list would
// accidentally classify every IPv4 address as non-public.
const NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
const NON_PUBLIC_IPV6_ADDRESSES = new BlockList();
const ALWAYS_BLOCKED_IPV4_ADDRESSES = new BlockList();
const ALWAYS_BLOCKED_IPV6_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_IPV4_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_IPV6_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

// Link-local ranges contain the well-known cloud metadata endpoints and are
// never legitimate VPN/on-prem destinations. Keep them blocked even when the
// broad legacy private-host escape hatch is enabled.
ALWAYS_BLOCKED_IPV4_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED_IPV6_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED_IPV4_ADDRESSES.addAddress('100.100.100.200', 'ipv4'); // Alibaba metadata
ALWAYS_BLOCKED_IPV6_ADDRESSES.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS IPv6

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase().replace(/\.$/, '');
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

const scopedPrivateHostAllowlist = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Narrowly allow exact private hosts for an isolated operation such as the
 * in-process mock verifier. Unlike the legacy process-wide environment
 * variable, this allowance cannot leak into concurrent requests.
 */
export function withPrivateHostAllowlist<T>(hostnames: readonly string[], operation: () => T): T {
  return scopedPrivateHostAllowlist.run(
    new Set(hostnames.map((hostname) => normalizeHostname(hostname))),
    operation
  );
}

export function isPrivateHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (ALWAYS_BLOCKED_HOSTNAMES.has(normalized)) return true;
  const family = isIP(normalized);
  if (
    (family === 4 && ALWAYS_BLOCKED_IPV4_ADDRESSES.check(normalized, 'ipv4')) ||
    (family === 6 && ALWAYS_BLOCKED_IPV6_ADDRESSES.check(normalized, 'ipv6'))
  ) {
    return true;
  }

  if (scopedPrivateHostAllowlist.getStore()?.has(normalized)) {
    return false;
  }
  if (process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] === '1') {
    return false;
  }

  return isNonPublicHost(normalized);
}

/** Classify a literal/hostname without honoring any private-host allowance. */
export function isNonPublicHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (ALWAYS_BLOCKED_HOSTNAMES.has(normalized) || BLOCKED_HOSTNAMES.has(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return NON_PUBLIC_IPV4_ADDRESSES.check(normalized, 'ipv4');
  if (family === 6) return NON_PUBLIC_IPV6_ADDRESSES.check(normalized, 'ipv6');
  return false;
}

export function isSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export const AbsoluteHttpsUrlSchema = z
  .string()
  .refine(isAbsoluteHttpsUrlTemplate, 'Must be an absolute HTTPS URL');

export const IntegrationRelativeEndpointSchema = z
  .string()
  .startsWith('/', { message: 'Must be an integration-relative path starting with /' });

export function getErrorMessage(error: unknown): string {
  return (
    getEnvironmentDeclarationError(error) ??
    (error instanceof Error ? error.message : String(error))
  );
}

/**
 * Rebuild the URL from its parsed parts without userinfo or query values. The parsed URL is
 * never mutated, because it can come from remote text.
 */
export function sanitizeUrlForError(rawUrl: string): string {
  try {
    const { protocol, host, href, pathname, search, hash } = new URL(rawUrl);
    const authority = href.startsWith(`${protocol}//`) ? `//${host}` : '';
    return `${protocol}${authority}${pathname}${search ? '?[redacted]' : ''}${hash}`;
  } catch {
    return '[invalid-url]';
  }
}
