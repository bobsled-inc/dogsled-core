/**
 * Pure utility functions extracted from extract.ts for testability.
 */

const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function setNestedValue(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown
): void {
  const keys = dotPath.split('.');
  for (const key of keys) {
    if (BLOCKED_PROTO_KEYS.has(key)) return;
  }
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const finalKey = keys[keys.length - 1]!;
  current[finalKey] = value;
}

/**
 * Route pagination/cursor params into either body overrides or URL query params.
 *
 * Rules:
 * - POST with request_body: ALL params go to bodyOverrides
 * - Dotted key with request_body present: that param goes to bodyOverrides
 * - Otherwise: param goes to urlQueryParams
 */
export function routePaginationParams(
  queryParams: Record<string, string | number | boolean>,
  method: string,
  hasRequestBody: boolean
): {
  bodyOverrides: Record<string, string | number | boolean>;
  urlQueryParams: Record<string, string | number | boolean>;
} {
  const isPostWithBody = method.toUpperCase() === 'POST' && hasRequestBody;
  const bodyOverrides: Record<string, string | number | boolean> = {};
  const urlQueryParams: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(queryParams)) {
    if ((key.includes('.') && hasRequestBody) || isPostWithBody) {
      bodyOverrides[key] = value;
    } else {
      urlQueryParams[key] = value;
    }
  }
  return { bodyOverrides, urlQueryParams };
}
