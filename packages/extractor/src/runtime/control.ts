import { Writable } from 'node:stream';

import { PROTOCOL_VERSION } from '@bobsled-inc/protocol';
import { formatPrettyLog, formatPrettyMetric } from '../output.js';

import type {
  JsonObject,
  LogMessage,
  MetricMessage,
  ProgressEventType,
  ProgressMessage,
} from '@bobsled-inc/protocol';

export interface ControlLoggerOptions {
  logFormat?: 'json' | 'pretty';
  quiet?: boolean;
  verbose?: boolean;
  stream?: Writable;
}

export class ControlLogger {
  private readonly format: 'json' | 'pretty';
  private readonly quiet: boolean;
  private readonly verbose: boolean;
  private readonly stream: Writable;
  private writeChain = Promise.resolve();

  constructor(options: ControlLoggerOptions) {
    this.format = options.logFormat ?? 'json';
    this.quiet = options.quiet ?? false;
    this.verbose = options.verbose ?? false;
    this.stream = options.stream ?? process.stderr;
  }

  async debug(message: string): Promise<void> {
    await this.log('debug', message);
  }

  async info(message: string): Promise<void> {
    await this.log('info', message);
  }

  async warn(message: string): Promise<void> {
    await this.log('warn', message);
  }

  async error(message: string): Promise<void> {
    await this.log('error', message);
  }

  async log(
    level: LogMessage['level'],
    message: string,
    event?: string,
    attributes?: JsonObject
  ): Promise<void> {
    if (!this.shouldEmit(level)) {
      return;
    }

    const payload = {
      _v: PROTOCOL_VERSION,
      type: 'LOG',
      level,
      message,
      time: new Date().toISOString(),
      ...(event ? { event } : {}),
      ...(attributes ? { attributes } : {}),
    } satisfies LogMessage;
    const line =
      this.format === 'json'
        ? JSON.stringify(payload) + '\n'
        : `${formatPrettyLog(level, message)}\n`;

    await this.enqueueWrite(line);
  }

  async metric(stream: string, metrics: MetricMessage['metrics']): Promise<void> {
    if (this.quiet) {
      return;
    }

    const line =
      this.format === 'json'
        ? JSON.stringify({
            _v: PROTOCOL_VERSION,
            type: 'METRIC',
            stream,
            metrics,
            time: new Date().toISOString(),
          } satisfies MetricMessage) + '\n'
        : `${formatPrettyMetric(stream, metrics)}\n`;

    await this.enqueueWrite(line);
  }

  async progress(
    event: ProgressEventType,
    resource?: string,
    data?: ProgressMessage['data']
  ): Promise<void> {
    if (this.quiet) return;

    const attributes: JsonObject = {
      progress_event: event,
      ...(resource != null ? { resource } : {}),
      ...(data ?? {}),
    };

    if (this.format === 'json') {
      const level: LogMessage['level'] = event.includes('error') ? 'error' : 'info';
      const label = resource ? `${event} ${resource}` : event;
      await this.log(level, label, `progress.${event}`, attributes);
    } else {
      const label = resource ? `${event} ${resource}` : event;
      const hasMetrics =
        typeof data?.records_emitted === 'number' &&
        typeof data?.api_calls === 'number' &&
        typeof data?.duration_ms === 'number';
      const line = event.includes('error')
        ? formatPrettyLog('error', label)
        : hasMetrics
          ? formatPrettyMetric(label, {
              records_emitted: data!.records_emitted as number,
              api_calls: data!.api_calls as number,
              duration_ms: data!.duration_ms as number,
            })
          : formatPrettyLog('info', label);
      await this.enqueueWrite(line + '\n');
    }
  }

  async close(): Promise<void> {
    await this.writeChain;
  }

  private shouldEmit(level: LogMessage['level']): boolean {
    if (level === 'error') {
      return true;
    }
    if (this.quiet) {
      return false;
    }
    if (level === 'debug') {
      return this.verbose;
    }
    return true;
  }

  private async enqueueWrite(line: string): Promise<void> {
    const next = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        if (this.stream.write(line)) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            this.stream.removeListener('error', onError);
            resolve();
          };
          const onError = (err: Error) => {
            this.stream.removeListener('drain', onDrain);
            reject(err);
          };
          this.stream.once('drain', onDrain);
          this.stream.once('error', onError);
        });
      });

    this.writeChain = next;
    await next;
  }
}
