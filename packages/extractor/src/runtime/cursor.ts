/**
 * Cursor comparison utilities for monotonic bookmark advancement.
 *
 * Supports timestamp (ISO 8601), numeric, integer, and string cursors.
 */

export { CURSOR_KINDS } from '../constants.js';
export type { CursorKind } from '../constants.js';

import type { CursorKind } from '../constants.js';

/**
 * Compare two cursor values. Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareCursors(a: string, b: string, kind: CursorKind): -1 | 0 | 1 {
  switch (kind) {
    case 'number': {
      const na = Number(a);
      const nb = Number(b);
      if (!Number.isFinite(na) || !Number.isFinite(nb)) {
        throw new Error(`Invalid number cursor: "${a}" or "${b}"`);
      }
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    }
    case 'integer': {
      try {
        const na = BigInt(a);
        const nb = BigInt(b);
        if (na < nb) return -1;
        if (na > nb) return 1;
        return 0;
      } catch {
        throw new Error(`Invalid integer cursor: "${a}" or "${b}"`);
      }
    }
    case 'timestamp': {
      const ta = new Date(a).getTime();
      const tb = new Date(b).getTime();
      if (isNaN(ta) || isNaN(tb)) {
        throw new Error(`Invalid timestamp cursor: "${a}" or "${b}"`);
      }
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    }
    case 'string': {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }
    case 'lsn': {
      const la = parseLsn(a);
      const lb = parseLsn(b);
      if (la < lb) return -1;
      if (la > lb) return 1;
      return 0;
    }
  }
}

/**
 * Return the greater of two cursor values. Used for monotonic bookmark advancement.
 */
export function maxCursor(current: string, candidate: string, kind: CursorKind): string {
  return compareCursors(candidate, current, kind) > 0 ? candidate : current;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]/;
const INTEGER_RE = /^-?\d+$/;
const LSN_RE = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;

function parseLsn(value: string): bigint {
  const normalized = value.trim();
  if (!LSN_RE.test(normalized)) {
    throw new Error(`Invalid lsn cursor: "${value}"`);
  }

  const [upperHex, lowerHex] = normalized.split('/');
  if (!upperHex || !lowerHex) {
    throw new Error(`Invalid lsn cursor: "${value}"`);
  }

  const upper = BigInt(`0x${upperHex}`);
  const lower = BigInt(`0x${lowerHex}`);
  return (upper << 32n) + lower;
}

/**
 * Infer cursor kind from a value string.
 *
 * Heuristic: ISO 8601 prefix → timestamp, all digits → integer, else string.
 */
export function inferCursorKind(value: string): CursorKind {
  if (ISO_RE.test(value)) return 'timestamp';
  if (LSN_RE.test(value)) return 'lsn';
  if (INTEGER_RE.test(value)) return 'integer';
  if (!Number.isNaN(Number(value)) && value.trim() !== '') return 'number';
  return 'string';
}

/**
 * Resolve cursor kind from explicit config, spec, or value hint.
 *
 * Priority: explicit > spec cursor_type > infer from hint value > undefined.
 */
export function resolveCursorKind(params: {
  explicit?: CursorKind;
  specCursorType?: CursorKind;
  hintValue?: string;
}): CursorKind | undefined {
  if (params.explicit) return params.explicit;
  if (params.specCursorType) return params.specCursorType;
  if (params.hintValue) return inferCursorKind(params.hintValue);
  return undefined;
}
