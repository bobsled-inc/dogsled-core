import { isPlainObject } from './guards';

export interface EntityGraphRouteErrorResponse {
  error: string;
  detail?: string;
  issues?: unknown;
  code?: string;
}

export function isEntityGraphRouteErrorResponse(
  value: unknown
): value is EntityGraphRouteErrorResponse {
  if (!isPlainObject(value) || typeof value.error !== 'string') {
    return false;
  }

  return (
    (value.detail === undefined || typeof value.detail === 'string') &&
    (value.code === undefined || typeof value.code === 'string')
  );
}

export function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function formatEntityGraphRouteErrorMessage(
  value: unknown,
  fallback: string,
  includeIssues = false
): string {
  if (!isEntityGraphRouteErrorResponse(value)) {
    return fallback;
  }

  const parts = [value.error];
  if (value.detail && value.detail !== value.error) {
    parts.push(value.detail);
  }

  if (includeIssues && value.issues !== undefined) {
    try {
      parts.push(JSON.stringify(value.issues, null, 2));
    } catch {
      parts.push(String(value.issues));
    }
  }

  return parts.join('\n');
}
