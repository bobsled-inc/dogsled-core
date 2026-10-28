/**
 * Snowflake identifier handling.
 *
 * Snowflake uppercases unquoted identifiers and preserves case for
 * double-quoted ones. The generator normalizes on lookup so that user-provided
 * source YAMLs (which typically use uppercase) match SQL written in any case.
 */

/** Strip wrapping double quotes if present. */
export function unquote(id: string): { value: string; quoted: boolean } {
  if (id.length >= 2 && id.startsWith('"') && id.endsWith('"')) {
    return { value: id.slice(1, -1).replace(/""/g, '"'), quoted: true };
  }
  return { value: id, quoted: false };
}

/**
 * Normalize a Snowflake identifier for comparison: uppercase unless quoted.
 * Used as the lookup key when matching SQL identifiers against source specs.
 */
export function normalize(id: string): string {
  const { value, quoted } = unquote(id);
  return quoted ? value : value.toUpperCase();
}

/** Split a dotted identifier (`db.schema.table`) into normalized parts. */
export function splitDotted(dotted: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < dotted.length; i++) {
    const ch = dotted[i];
    if (ch === '"' && inQuotes && dotted[i + 1] === '"') {
      // Escaped double-quote inside a quoted identifier: keep both chars and skip.
      current += '""';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '.' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.map(normalize);
}
