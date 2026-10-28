import type { Writable } from 'node:stream';

export type LogFormat = 'text' | 'json';

export interface LoaderLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  metric(name: string, value: number, fields?: Record<string, unknown>): void;
}

function formatJson(level: string, event: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({ ...fields, level, event, ts: new Date().toISOString() }) + '\n';
}

function formatText(level: string, event: string, fields?: Record<string, unknown>): string {
  const prefix = level === 'warn' ? 'WARN ' : level === 'error' ? 'ERROR ' : '';
  const entries = fields ? Object.entries(fields) : [];
  const fieldStr =
    entries.length > 0
      ? ' ' +
        entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
      : '';
  return `[loader] ${prefix}${event}${fieldStr}\n`;
}

function formatMetricJson(name: string, value: number, fields?: Record<string, unknown>): string {
  return (
    JSON.stringify({
      ...fields,
      level: 'metric',
      name,
      value,
      ts: new Date().toISOString(),
    }) + '\n'
  );
}

function formatMetricText(name: string, value: number, fields?: Record<string, unknown>): string {
  const entries = fields ? Object.entries(fields) : [];
  const fieldStr =
    entries.length > 0
      ? ' ' +
        entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
      : '';
  return `[loader] METRIC ${name}=${value}${fieldStr}\n`;
}

export function createLogger(stderr: Writable, format: LogFormat = 'text'): LoaderLogger {
  const fmt = format === 'json' ? formatJson : formatText;
  const fmtMetric = format === 'json' ? formatMetricJson : formatMetricText;
  return {
    info(event, fields) {
      stderr.write(fmt('info', event, fields));
    },
    warn(event, fields) {
      stderr.write(fmt('warn', event, fields));
    },
    error(event, fields) {
      stderr.write(fmt('error', event, fields));
    },
    metric(name, value, fields) {
      stderr.write(fmtMetric(name, value, fields));
    },
  };
}
