/**
 * Shared display formatters for the Explorer UI.
 *
 * Consolidates a few formatters that previously lived as local copies in
 * multiple components, so we have one source of truth for how numbers and
 * "member date" values render. Keep this module dependency-free.
 */

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
// en-CA gives ISO-style YYYY-MM-DD output. We use the user's local calendar
// here on purpose: `toISOString().slice(0, 10)` shifts the date to UTC, so a
// timestamp at 2026-04-27T01:00Z renders as the prior day for a Pacific user.
const CALENDAR_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DATE_KEY_RE = /_(at|date|time|timestamp|updated|created|seen)$/i;

/**
 * Format an integer/decimal count for display. Returns "—" for null/undefined
 * so UI tables can render an em-dash placeholder for unknown counts.
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  return NUMBER_FORMATTER.format(value);
}

/**
 * Minimum numeric value treated as a Unix-millisecond timestamp.
 * 1e11 ms ≈ 1973-03, so any number below this is more likely a count/id than
 * a real timestamp and is rejected to avoid rendering "1234" as a 1970 date.
 */
const NUMERIC_DATE_MIN_MS = 1e11;

/**
 * Type-guard: is this value plausibly a date we can parse?
 *
 * Avoid parsing plain numeric/short strings as dates (e.g. "12345" -> 12345 ms
 * epoch) — require a date separator, "T", or a timezone indicator before
 * accepting a string. Also reject small numbers that could be ambiguous
 * counts or ids — only treat numerics in a plausible ms-epoch range as dates.
 */
export function looksLikeDateValue(value: unknown): value is string | number | Date {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) >= NUMERIC_DATE_MIN_MS;
  }
  if (typeof value !== 'string') return false;
  if (!/[-/T:]/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Decide whether a `{ key, value }` member field looks like a date attribute,
 * either by attribute-name suffix (`_at`, `_date`, `_updated`, ...) or by the
 * value being parseable as a date.
 */
export function isDateField(field: { key: string; value: string | null }): boolean {
  if (DATE_KEY_RE.test(field.key)) return true;
  if (field.value === null) return false;
  return looksLikeDateValue(field.value);
}

/**
 * Render a date-ish member value with relative wording inside +/- 30 days
 * ("3h ago", "in 2 days") and a YYYY-MM-DD calendar date for older/farther
 * values. Returns "—" for null/undefined and stringifies non-date values.
 *
 * `nowMs` is the reference moment to compute "ago" / "in" wording against.
 * Pass `Date.now()` from a client effect when you want relative output. When
 * omitted (e.g. during SSR or when a stable reference isn't available) we
 * fall back to the calendar format so server-rendered HTML matches the
 * client's first paint and React doesn't trip a hydration mismatch.
 */
export function formatMemberDate(value: unknown, nowMs?: number): string {
  if (value === null || value === undefined) return '—';
  if (!looksLikeDateValue(value)) return String(value);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  if (nowMs == null) {
    return CALENDAR_DATE_FORMATTER.format(date);
  }

  const diffMs = date.getTime() - nowMs;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const absDays = Math.abs(diffDays);

  if (absDays <= 30) {
    const absMs = Math.abs(diffMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (absMs < minute) return 'just now';
    if (absMs < hour) {
      // 30-59s rounds to 0 minutes — surface as "just now" so we never render
      // the awkward "in 0 minutes" / "0 minutes ago".
      const mins = Math.round(diffMs / minute);
      if (mins === 0) return 'just now';
      return RELATIVE_TIME_FORMATTER.format(mins, 'minute');
    }
    if (absMs < day) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / hour), 'hour');
    }
    return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / day), 'day');
  }

  return CALENDAR_DATE_FORMATTER.format(date);
}
