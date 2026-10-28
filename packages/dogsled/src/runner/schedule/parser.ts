// Human-readable schedule strings to POSIX cron expressions.
//
// Supported formats:
//   hourly, daily, weekly, monthly          — named presets
//   every 2h, every 30m                     — interval shorthand
//   30 past hourly, 15 past every 2h       — offset + interval
//   daily at 8, daily at 14:30, daily at 2am — daily at specific time
//   Raw 5-field cron                        — pass-through

import { CommandError } from '@bobsled-inc/protocol';

/**
 * Sentinel `schedule:` value that opts a pipeline out of automatic firing.
 *
 * `parseToCron` deliberately rejects this so the manual sentinel can never
 * smuggle through and end up as a literal cron expression in a generated
 * workflow. Callers must branch on
 * `isManualSchedule()` (or the `pipelineTrigger` schema helper) before
 * deciding whether to compute a cron.
 */
export const MANUAL_SCHEDULE = 'manual';

export function isManualSchedule(schedule: string | undefined | null): boolean {
  return typeof schedule === 'string' && schedule.trim().toLowerCase() === MANUAL_SCHEDULE;
}

// ---------------------------------------------------------------------------
// Named presets
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  hourly: '0 * * * *',
  daily: '0 6 * * *',
  weekly: '0 6 * * 1',
  monthly: '0 6 1 * *',
};

// ---------------------------------------------------------------------------
// Regex matchers
// ---------------------------------------------------------------------------

/** `every 4h`, `every 30m` */
const EVERY_RE = /^every\s+(\d+)\s*(h|m)$/;

/** `30 past hourly`, `15 past every 2h` */
const PAST_RE = /^(\d+)\s+past\s+(.+)$/;

/** `daily at 8`, `daily at 14:30`, `daily at 2am`, `daily at 2pm` */
const DAILY_AT_RE = /^daily\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

/** 5-field cron (loose validation — just checks structure) */
const CRON_RE = /^[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+$/;

type CronRange = {
  min: number;
  max: number;
};

const CRON_FIELD_RANGES: readonly CronRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
] as const;

// ---------------------------------------------------------------------------
// Individual parsers (return null on no-match)
// ---------------------------------------------------------------------------

function tryParseNamed(s: string): string | null {
  return NAMED[s] ?? null;
}

function tryParseEvery(s: string): string | null {
  const m = EVERY_RE.exec(s);
  if (!m) return null;

  const value = Number(m[1]);
  const unit = m[2];

  if (unit === 'h') {
    if (value < 1 || value > 23 || 24 % value !== 0) return null;
    return `0 */${value} * * *`;
  }
  // minutes
  if (value < 1 || value > 59 || 60 % value !== 0) return null;
  return `*/${value} * * * *`;
}

function tryParsePast(s: string): string | null {
  const m = PAST_RE.exec(s);
  if (!m) return null;

  const offset = Number(m[1]);
  if (offset < 0 || offset > 59) return null;

  const base = m[2]!.trim();

  // "30 past hourly"
  if (base === 'hourly') {
    return `${offset} * * * *`;
  }

  // "15 past every 2h"
  const everyMatch = EVERY_RE.exec(base);
  if (everyMatch && everyMatch[2] === 'h') {
    const hours = Number(everyMatch[1]);
    if (hours < 1 || hours > 23 || 24 % hours !== 0) return null;
    return `${offset} */${hours} * * *`;
  }

  return null;
}

function tryParseDailyAt(s: string): string | null {
  const m = DAILY_AT_RE.exec(s);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const period = m[3]; // am/pm

  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return `${minute} ${hour} * * *`;
}

function tryParseCron(s: string): string | null {
  if (!CRON_RE.test(s)) {
    return null;
  }

  const fields = s.split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }

  return fields.every((field, index) => isValidCronField(field, CRON_FIELD_RANGES[index]!))
    ? s
    : null;
}

function isValidCronField(field: string, range: CronRange): boolean {
  return field.split(',').every((part) => isValidCronPart(part, range));
}

function isValidCronPart(part: string, range: CronRange): boolean {
  if (!part) {
    return false;
  }

  const [base, stepRaw, ...rest] = part.split('/');
  if (!base || rest.length > 0) {
    return false;
  }

  if (stepRaw !== undefined) {
    if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) {
      return false;
    }
  }

  if (base === '*') {
    return true;
  }

  if (/^\d+$/.test(base)) {
    return isInCronRange(Number(base), range);
  }

  const [startRaw, endRaw, ...rangeRest] = base.split('-');
  if (!startRaw || !endRaw || rangeRest.length > 0) {
    return false;
  }
  if (!/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw)) {
    return false;
  }

  const start = Number(startRaw);
  const end = Number(endRaw);
  return start <= end && isInCronRange(start, range) && isInCronRange(end, range);
}

function isInCronRange(value: number, range: CronRange): boolean {
  return value >= range.min && value <= range.max;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable schedule string into a POSIX cron expression.
 * Throws `CommandError` (exit code 2) on unrecognized input.
 */
export function parseToCron(schedule: string): string {
  const s = schedule.trim().toLowerCase();
  if (!s) {
    throw new CommandError('Schedule string cannot be empty', 2);
  }

  if (s === MANUAL_SCHEDULE) {
    throw new CommandError(
      'Schedule "manual" has no cron expression — branch on isManualSchedule() before calling parseToCron.',
      2
    );
  }

  const result =
    tryParseNamed(s) ??
    tryParseEvery(s) ??
    tryParsePast(s) ??
    tryParseDailyAt(s) ??
    tryParseCron(s);

  if (result === null) {
    throw new CommandError(
      `Unrecognized schedule: "${schedule}". Use a named schedule (hourly, daily, weekly, monthly), ` +
        `an interval (every 4h, every 30m), a time (daily at 14:30), or a raw cron expression.`,
      2
    );
  }

  return result;
}

/**
 * Check whether a schedule string is valid without throwing. The `manual`
 * sentinel counts as valid even though `parseToCron` rejects it — manual is a
 * valid `schedule:` value, it just has no cron expression to compute.
 */
export function isValidSchedule(schedule: string): boolean {
  if (isManualSchedule(schedule)) return true;
  try {
    parseToCron(schedule);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reverse mapping: cron to human-readable slug (for workflow filenames)
// ---------------------------------------------------------------------------

const REVERSE_NAMED: Record<string, string> = {
  '0 * * * *': 'hourly',
  '0 6 * * *': 'daily',
  '0 6 * * 1': 'weekly',
  '0 6 1 * *': 'monthly',
};

// Convert a cron expression to a short, filename-safe slug.
export function cronToHumanSlug(cron: string): string {
  const c = cron.trim();

  // Check named presets first
  const named = REVERSE_NAMED[c];
  if (named) return named;

  const parts = c.split(/\s+/);
  if (parts.length !== 5) return sanitizeSlug(c);

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  // "*/N * * * *" -> "every-Nm"
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `every-${minStep[1]}m`;
  }

  // "0 */N * * *" -> "every-Nh"
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (minute === '0' && hourStep && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `every-${hourStep[1]}h`;
  }

  // "M */N * * *" -> "M-past-every-Nh"
  if (hourStep && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `${minute}-past-every-${hourStep[1]}h`;
  }

  // "M H * * *" -> "daily-at-H-M" (specific time daily)
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const h = Number(hour);
    const m = Number(minute);
    if (m === 0) return `daily-at-${h}`;
    return `daily-at-${h}-${String(m).padStart(2, '0')}`;
  }

  return sanitizeSlug(c);
}

function sanitizeSlug(cron: string): string {
  return cron
    .replace(/\*/g, 'x')
    .replace(/\//g, '-')
    .replace(/,/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
