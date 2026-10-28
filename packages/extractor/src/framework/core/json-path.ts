export type JsonPathToken = { type: 'prop'; value: string } | { type: 'index'; value: number };

const SEGMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(-?\d+)\])?$/;

/**
 * Parse a JSONPath-like string (e.g. `$.data[-1].id`) into a token list.
 * Returns `null` for unsupported paths.
 */
export function parseJsonPathTokens(path: string): JsonPathToken[] | null {
  if (path === '$') return [];
  if (!path.startsWith('$.')) return null;

  const segments = path.slice(2).split('.').filter(Boolean);
  const tokens: JsonPathToken[] = [];

  for (const segment of segments) {
    const match = SEGMENT_RE.exec(segment);
    if (!match?.[1]) {
      return null;
    }

    tokens.push({ type: 'prop', value: match[1] });
    if (match[2] !== undefined) {
      tokens.push({ type: 'index', value: Number(match[2]) });
    }
  }

  return tokens;
}

/** Resolve a negative array index to an absolute index. */
export function resolveArrayIndex(index: number, length: number): number {
  return index < 0 ? length + index : index;
}
