import { CronExpressionParser } from 'cron-parser';

export interface ScheduleParseResult {
  valid: boolean;
  cron?: string;
  croneq?: string;
  human?: string;
  error?: string;
  nextRuns?: string[];
}

const DAY_LABELS: Record<string, string> = {
  '0': 'Sunday',
  '1': 'Monday',
  '2': 'Tuesday',
  '3': 'Wednesday',
  '4': 'Thursday',
  '5': 'Friday',
  '6': 'Saturday',
  '1-5': 'Weekdays',
};

function formatUtcTime(hour: number, minute: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(Date.UTC(2025, 0, 1, hour, minute)));
}

function formatRunTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}

function normalizeSchedule(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

function describeCron(cron: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return `Custom cron schedule (${cron})`;
  }

  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Hourly';
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (
    minute === '0' &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const interval = Number(everyHourMatch[1]);
    return `Every ${interval} hour${interval === 1 ? '' : 's'}`;
  }

  const everyMinuteMatch = minute.match(/^\*\/(\d+)$/);
  if (
    everyMinuteMatch &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const interval = Number(everyMinuteMatch[1]);
    return `Every ${interval} minute${interval === 1 ? '' : 's'}`;
  }

  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${formatUtcTime(0, 0)}`;
  }

  if (minute === '0' && hour === '0' && dayOfMonth === '1' && month === '*' && dayOfWeek === '*') {
    return `Monthly on day 1 at ${formatUtcTime(0, 0)}`;
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek in DAY_LABELS
  ) {
    return `${DAY_LABELS[dayOfWeek]} at ${formatUtcTime(Number(hour), Number(minute))}`;
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `Daily at ${formatUtcTime(Number(hour), Number(minute))}`;
  }

  return `Custom cron schedule (${cron})`;
}

function toCron(normalized: string): { cron: string; human: string } | null {
  if (normalized === 'hourly') {
    return { cron: '0 * * * *', human: 'Hourly' };
  }

  const hourMatch = normalized.match(/^every (\d+)h$/);
  if (hourMatch) {
    const interval = Number(hourMatch[1]);
    if (interval < 1 || interval > 23) return null;
    return {
      cron: `0 */${interval} * * *`,
      human: `Every ${interval} hour${interval === 1 ? '' : 's'}`,
    };
  }

  const minuteMatch = normalized.match(/^every (\d+)m$/);
  if (minuteMatch) {
    const interval = Number(minuteMatch[1]);
    if (interval < 1 || interval > 59) return null;
    return {
      cron: `*/${interval} * * * *`,
      human: `Every ${interval} minute${interval === 1 ? '' : 's'}`,
    };
  }

  if (normalized === 'daily') {
    return { cron: '0 0 * * *', human: `Daily at ${formatUtcTime(0, 0)}` };
  }

  if (normalized === 'weekly') {
    return { cron: '0 0 * * 1', human: `Monday at ${formatUtcTime(0, 0)}` };
  }

  if (normalized === 'monthly') {
    return { cron: '0 0 1 * *', human: `Monthly on day 1 at ${formatUtcTime(0, 0)}` };
  }

  if (/^(\S+\s+){4}\S+$/.test(normalized)) {
    return { cron: normalized, human: describeCron(normalized) };
  }

  return null;
}

export function parseSchedule(input: string, now = new Date()): ScheduleParseResult {
  const normalized = normalizeSchedule(input);
  if (!normalized) {
    return { valid: false, error: 'Enter a schedule like "daily" or "0 */4 * * *".' };
  }

  const schedule = toCron(normalized);
  if (!schedule) {
    return {
      valid: false,
      error:
        'Use hourly, every Nh, every Nm, daily, weekly, monthly, or a 5-field cron expression.',
    };
  }

  try {
    const parsed = CronExpressionParser.parse(schedule.cron, {
      currentDate: now,
      tz: 'UTC',
    });
    const nextRuns = parsed.take(3).map((date) => formatRunTime(date.toDate()));
    return {
      valid: true,
      cron: schedule.cron,
      croneq: schedule.cron,
      human: schedule.human,
      nextRuns,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron expression',
    };
  }
}
