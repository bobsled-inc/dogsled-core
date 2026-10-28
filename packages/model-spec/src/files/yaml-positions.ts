/**
 * YAML position tracking for Zod validation errors.
 *
 * Uses the `yaml` library's Document API to map YAML paths to
 * line/column positions, enabling file:line:col error formatting.
 */

import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface YamlPosition {
  line: number;
  col: number;
}

/** Maps dot-separated YAML paths to their source positions. */
export type PositionMap = Map<string, YamlPosition>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a map from YAML paths (e.g. "source.ref", "columns.0.name") to
 * their {line, col} positions in the source text.
 */
export function buildPositionMap(content: string): PositionMap {
  const map: PositionMap = new Map();
  const doc = YAML.parseDocument(content);
  if (!doc.contents) return map;

  // Pre-compute line start offsets for O(log n) offset->line lookup
  const lineStarts = buildLineStarts(content);
  walkNode(doc.contents, '', map, lineStarts);
  return map;
}

/**
 * Format Zod validation errors with file:line:col positions.
 *
 * Falls back to plain path formatting if no position is found.
 */
export function formatZodErrorWithPositions(
  zodError: { issues: Array<{ path: PropertyKey[]; message: string }> },
  positionMap: PositionMap,
  filePath: string
): string {
  return zodError.issues
    .map((issue) => {
      const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
      const pathStr = path.join('.');
      const pos = findPosition(positionMap, path);
      if (pos) {
        return `${filePath}:${pos.line}:${pos.col}: ${pathStr}: ${issue.message}`;
      }
      return `${filePath}: ${pathStr}: ${issue.message}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build array of line-start offsets for offset->line:col conversion. */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Convert a character offset to 1-based line and column. */
function offsetToPosition(offset: number, lineStarts: number[]): YamlPosition {
  // Binary search for the line
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo + 1, col: offset - lineStarts[lo]! + 1 };
}

/** Try to find a position for a Zod path, walking up to parent if needed. */
function findPosition(map: PositionMap, path: (string | number)[]): YamlPosition | undefined {
  // Try exact path first
  const exact = map.get(path.join('.'));
  if (exact) return exact;

  // Try parent paths (e.g. for "columns.0.name" try "columns.0", then "columns")
  for (let i = path.length - 1; i > 0; i--) {
    const parent = path.slice(0, i).join('.');
    const pos = map.get(parent);
    if (pos) return pos;
  }

  return undefined;
}

function walkNode(node: unknown, path: string, map: PositionMap, lineStarts: number[]): void {
  if (!node || typeof node !== 'object') return;

  if (YAML.isMap(node)) {
    for (const pair of node.items) {
      if (YAML.isScalar(pair.key)) {
        const keyPath = path ? `${path}.${String(pair.key.value)}` : String(pair.key.value);
        if (pair.key.range) {
          map.set(keyPath, offsetToPosition(pair.key.range[0], lineStarts));
        }
        walkNode(pair.value, keyPath, map, lineStarts);
      }
    }
  } else if (YAML.isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i];
      const itemPath = `${path}.${i}`;
      // For sequence items, use the item's range if available
      if (item && typeof item === 'object' && 'range' in item) {
        const seqItem = item as { range?: [number, number, number] };
        if (seqItem.range) {
          map.set(itemPath, offsetToPosition(seqItem.range[0], lineStarts));
        }
      }
      walkNode(item, itemPath, map, lineStarts);
    }
  } else if (YAML.isScalar(node)) {
    // Leaf scalar value — record position for the path
    const scalar = node as { range?: [number, number, number] };
    if (scalar.range && path) {
      // Only set if not already set by the key (key position is more useful)
      if (!map.has(path)) {
        map.set(path, offsetToPosition(scalar.range[0], lineStarts));
      }
    }
  }
}
