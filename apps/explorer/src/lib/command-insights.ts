import type { LogMessage, MetricMessage, ProgressMessage } from '@bobsled-inc/protocol';
import type { CommandOutput } from '@/lib/use-command';

export interface ProtocolStreamStats {
  stream: string;
  records: number;
  hasSchema: boolean;
  metrics: Record<string, number | string>;
  error?: string;
}

export interface ProtocolStats {
  streams: ProtocolStreamStats[];
  totalRecords: number;
  totalStreams: number;
  errors: string[];
  durationMs: number | null;
}

export interface HealthCheckStatus {
  status: 'connected' | 'failed' | 'missing_env' | 'unknown';
  missingVars: string[];
  error?: string;
}

function getMetricEntries(metric: MetricMessage): Array<[string, number | string]> {
  return Object.entries(metric.metrics).reduce<Array<[string, number | string]>>(
    (entries, entry) => {
      if (entry[1] !== undefined) {
        entries.push([entry[0], entry[1]]);
      }
      return entries;
    },
    []
  );
}

export function commandOutputsToText(
  outputs: CommandOutput[],
  exitCode: number | null,
  error: string | null
): string {
  const lines = outputs.map((output) => `[${output.stream}] ${output.raw}`);
  if (exitCode !== null) {
    lines.push(`[exit] Process exited with code ${exitCode}`);
  }
  if (error) {
    lines.push(`[error] ${error}`);
  }
  return lines.join('\n');
}

export function collectProtocolStats(
  outputs: CommandOutput[],
  startedAt: number | null,
  completedAt: number | null
): ProtocolStats {
  const streams = new Map<string, ProtocolStreamStats>();
  const errors: string[] = [];

  function getStreamStats(name: string): ProtocolStreamStats {
    const existing = streams.get(name);
    if (existing) return existing;
    const created: ProtocolStreamStats = {
      stream: name,
      records: 0,
      hasSchema: false,
      metrics: {},
    };
    streams.set(name, created);
    return created;
  }

  for (const output of outputs) {
    if (output.parsed?.type === 'SCHEMA') {
      getStreamStats(output.parsed.stream).hasSchema = true;
      continue;
    }

    if (output.parsed?.type === 'RECORD') {
      getStreamStats(output.parsed.stream).records += 1;
      continue;
    }

    if (output.parsed?.type === 'METRIC') {
      const metric = output.parsed as MetricMessage;
      const stream = getStreamStats(metric.stream);
      for (const [key, value] of getMetricEntries(metric)) {
        stream.metrics[key] = value;
      }
      continue;
    }

    if (output.parsed?.type === 'PROGRESS') {
      const progress = output.parsed as ProgressMessage;
      if (progress.event === 'resource_error' && progress.resource) {
        const stream = getStreamStats(progress.resource);
        const reason =
          typeof progress.data?.error === 'string'
            ? progress.data.error
            : typeof progress.data?.status === 'string'
              ? progress.data.status
              : 'Resource failed';
        stream.error = reason;
      }
      continue;
    }

    if (output.parsed?.type === 'LOG') {
      const log = output.parsed as LogMessage;
      if (log.level === 'error') {
        errors.push(log.message);
      }
    }
  }

  const streamList = [...streams.values()].sort((left, right) => right.records - left.records);
  const totalRecords = streamList.reduce((sum, stream) => sum + stream.records, 0);
  return {
    streams: streamList,
    totalRecords,
    totalStreams: streamList.length,
    errors,
    durationMs: startedAt && completedAt ? completedAt - startedAt : null,
  };
}

export function getMetricTableRows(outputs: CommandOutput[]): Array<{
  id: string;
  stream: string;
  name: string;
  value: string;
}> {
  return outputs.flatMap((output) => {
    if (output.parsed?.type !== 'METRIC') {
      return [];
    }
    const metric = output.parsed as MetricMessage;
    return getMetricEntries(metric).map(([name, value]) => ({
      id: `${output.id}-${metric.stream}-${name}`,
      stream: metric.stream,
      name,
      value: String(value),
    }));
  });
}

export function summarizeHealthCheck(
  outputs: CommandOutput[],
  exitCode: number | null,
  error: string | null
): HealthCheckStatus {
  const missingVars = outputs.flatMap((output) => {
    if (output.parsed?.type === 'LOG') {
      const log = output.parsed as LogMessage;
      const match = log.message.match(/^Missing environment variable: (.+)$/);
      return match?.[1] ? [match[1]] : [];
    }
    return [];
  });

  const progress = outputs.find(
    (output) =>
      output.parsed?.type === 'PROGRESS' &&
      (output.parsed as ProgressMessage).event === 'health_check_complete'
  );

  if (missingVars.length > 0) {
    return { status: 'missing_env', missingVars: [...new Set(missingVars)] };
  }

  if (error) {
    return { status: 'failed', missingVars: [], error };
  }

  if (progress?.parsed?.type === 'PROGRESS') {
    const message = progress.parsed as ProgressMessage;
    const progressStatus = typeof message.data?.status === 'string' ? message.data.status : null;

    if (progressStatus === 'ok' && exitCode === 0) {
      return { status: 'connected', missingVars: [] };
    }

    if (progressStatus && progressStatus !== 'ok') {
      return {
        status: 'failed',
        missingVars: [],
        error:
          typeof message.data?.error === 'string'
            ? message.data.error
            : (error ?? 'Connection test failed'),
      };
    }
  }

  if (exitCode === 0) {
    return { status: 'connected', missingVars: [] };
  }

  const errorLog = outputs.find(
    (output) => output.parsed?.type === 'LOG' && (output.parsed as LogMessage).level === 'error'
  );
  return {
    status: 'failed',
    missingVars: [],
    error:
      errorLog?.parsed?.type === 'LOG'
        ? (errorLog.parsed as LogMessage).message
        : (error ?? 'Connection test failed'),
  };
}
