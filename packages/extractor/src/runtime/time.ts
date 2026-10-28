/**
 * Time parsing utilities for cursor values.
 *
 * Accepts ISO 8601 timestamps or relative durations (e.g. "2h", "30m", "1d").
 */

const MAX_RELATIVE_DAYS = 365;

const ISO_CURSOR_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Parse a --since / --until value into an ISO 8601 timestamp.
 *
 * Accepts:
 *   - ISO 8601 string: "2026-03-20T00:00:00Z" → normalized to full ISO
 *   - Relative duration: "2h" | "30m" | "1d" | "7d" → resolved to absolute timestamp
 */
export function parseCursorValue(value: string): string {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const amount = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const maxAmount = {
      m: MAX_RELATIVE_DAYS * 24 * 60,
      h: MAX_RELATIVE_DAYS * 24,
      d: MAX_RELATIVE_DAYS,
    }[unit]!;
    if (amount > maxAmount) {
      throw new Error(`Relative duration "${value}" exceeds maximum of ${MAX_RELATIVE_DAYS} days.`);
    }
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return new Date(Date.now() - amount * ms).toISOString();
  }

  if (!ISO_CURSOR_RE.test(value)) {
    throw new Error(
      `Invalid cursor value "${value.slice(0, 100)}". Use ISO 8601 (e.g. 2026-03-20T00:00:00Z) or relative duration (e.g. 2h, 1d).`
    );
  }

  // Require explicit timezone for full timestamps to avoid local-time ambiguity
  if (value.includes('T') && !/[Zz]|[+-]\d{2}:\d{2}$/.test(value)) {
    throw new Error(
      `Cursor value "${value.slice(0, 100)}" is missing a timezone. Append Z for UTC or +HH:MM offset (e.g. 2026-03-20T00:00:00Z).`
    );
  }

  // Normalize date-only to UTC midnight to avoid local-time ambiguity
  const normalizedValue = value.includes('T') ? value : `${value}T00:00:00Z`;
  const date = new Date(normalizedValue);
  if (isNaN(date.getTime())) {
    throw new Error(
      `Invalid cursor value "${value.slice(0, 100)}". Use ISO 8601 (e.g. 2026-03-20T00:00:00Z) or relative duration (e.g. 2h, 1d).`
    );
  }

  // Reject invalid calendar dates (e.g. Feb 31) by round-tripping
  if (!value.includes('T')) {
    const parts = value.split('-').map(Number);
    const [y, m, d] = [parts[0], parts[1], parts[2]];
    if (
      parts.length !== 3 ||
      date.getUTCFullYear() !== y ||
      date.getUTCMonth() + 1 !== m ||
      date.getUTCDate() !== d
    ) {
      throw new Error(`Invalid calendar date "${value}". The date does not exist.`);
    }
  }

  return date.toISOString();
}
