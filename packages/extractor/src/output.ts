import chalk from 'chalk';

export interface PrettyMetricLine {
  records_emitted?: number;
  api_calls?: number;
  duration_ms?: number;
  batch_files?: number;
  batch_bytes?: number;
  estimated_requests?: number;
  estimated_credits?: number;
  estimate_confidence?: 'exact' | 'upper_bound' | 'unknown';
  seed_rows_total?: number;
  seed_rows_executed?: number;
}

function isInteractive(): boolean {
  return process.stderr.isTTY ?? false;
}

export function formatPrettyLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string
): string {
  if (!isInteractive()) {
    return `[${level}] ${message}`;
  }

  switch (level) {
    case 'debug':
      return `${chalk.gray('⊡')} ${message}`;
    case 'info':
      return `${chalk.blue('ℹ')} ${message}`;
    case 'warn':
      return `${chalk.yellow('⚠')} ${message}`;
    case 'error':
      return `${chalk.red('✖')} ${message}`;
  }
}

export function formatPrettyMetric(stream: string, metrics: PrettyMetricLine): string {
  const hasRunMetrics =
    typeof metrics.records_emitted === 'number' &&
    typeof metrics.api_calls === 'number' &&
    typeof metrics.duration_ms === 'number';
  const message = hasRunMetrics
    ? `${stream}: ${metrics.records_emitted} record(s), ` +
      `${metrics.api_calls} API call(s), ${metrics.duration_ms}ms`
    : `${stream}: ${Object.entries(metrics)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`;

  if (!isInteractive()) {
    return `[metric] ${message}`;
  }

  return `${chalk.green('✔')} ${message}`;
}
