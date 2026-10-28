import * as fs from 'node:fs';

import { PROTOCOL_VERSION, isObject } from '@bobsled-inc/protocol';

import type { LogMessage } from '@bobsled-inc/protocol';

export function writeLogLine(line: string, logStream?: fs.WriteStream): void {
  process.stderr.write(`${line}\n`);
  logStream?.write(`${line}\n`);
}

export function buildLogMessage(
  level: LogMessage['level'],
  message: string,
  extra: { destination?: string } = {}
): LogMessage & { destination?: string } {
  return {
    _v: PROTOCOL_VERSION,
    type: 'LOG',
    level,
    message,
    time: new Date().toISOString(),
    ...extra,
  };
}

export function formatDestinationLogLine(
  line: string,
  destinationName: string,
  logFormat: string | undefined
): string {
  const resolvedLogFormat = logFormat ?? 'json';

  if (resolvedLogFormat === 'json') {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          destination: destinationName,
        });
      }
    } catch {
      // Fall back to a structured wrapper for non-JSON log lines.
    }

    return JSON.stringify({
      ...buildLogMessage('info', line, {
        destination: destinationName,
      }),
    });
  }

  return `[${destinationName}] ${formatPipelineLogLine(line, resolvedLogFormat)}`;
}

/** Quiet runs parse every child line for the summary but only show errors and plain text. */
export function shouldDisplayPipelineLogLine(line: string, quiet: boolean | undefined): boolean {
  if (!quiet) return true;
  try {
    const parsed: unknown = JSON.parse(line);
    return !isObject(parsed) || parsed['level'] === 'error';
  } catch {
    return true;
  }
}

export function writePipelineLogLine(
  line: string,
  logFormat: string | undefined,
  logStream: fs.WriteStream | undefined,
  quiet: boolean | undefined
): void {
  if (shouldDisplayPipelineLogLine(line, quiet)) {
    writeLogLine(formatPipelineLogLine(line, logFormat), logStream);
  }
}

/**
 * Render structured child telemetry for humans after it has been consumed by
 * the summary parser. Unknown lines stay unchanged.
 */
export function formatPipelineLogLine(line: string, logFormat: string | undefined): string {
  if ((logFormat ?? 'json') === 'json') return line;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed['type'] === 'LOG' && typeof parsed['message'] === 'string') {
      const level = typeof parsed['level'] === 'string' ? parsed['level'].toUpperCase() : 'INFO';
      return `[${level}] ${parsed['message']}`;
    }
    if (parsed['type'] === 'METRIC' && typeof parsed['stream'] === 'string') {
      const metrics =
        parsed['metrics'] && typeof parsed['metrics'] === 'object'
          ? (parsed['metrics'] as Record<string, unknown>)
          : {};
      return `${parsed['stream']}: ${Number(metrics['records_emitted'] ?? 0)} records, ${Number(metrics['api_calls'] ?? 0)} API calls`;
    }
    if (typeof parsed['event'] === 'string') {
      return parsed['event'];
    }
  } catch {
    // Already human-readable or emitted by an older child.
  }
  return line;
}
