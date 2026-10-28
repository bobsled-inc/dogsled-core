import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { PROTOCOL_VERSION } from '@bobsled-inc/protocol';

import type {
  BatchEncoding,
  BatchMessage,
  RecordMessage,
  SchemaBehavior,
  StateMessage,
  SchemaMessage,
} from '../types/index.js';
import { buildSchemaMessage, type SchemaResourceLike } from './schema-message.js';

export type OutputMode = 'stdout' | 'file';

export interface EmitterOptions {
  stdoutStream?: Writable;
  createWriteStream?: (filePath: string) => Writable;
  defaultSchemaBehavior?: SchemaBehavior;
}

export class Emitter {
  private readonly mode: OutputMode;
  private readonly outputDir: string;
  private readonly stdoutStream: Writable;
  private readonly createWriteStream: (filePath: string) => Writable;
  private readonly defaultSchemaBehavior: SchemaBehavior | undefined;
  private readonly fileHandles = new Map<string, Writable>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private outputDirCreated = false;

  constructor(mode: OutputMode = 'stdout', outputDir = 'output', options: EmitterOptions = {}) {
    this.mode = mode;
    this.outputDir = outputDir;
    this.stdoutStream = options.stdoutStream ?? process.stdout;
    this.createWriteStream =
      options.createWriteStream ??
      ((filePath: string) => fs.createWriteStream(filePath, { flags: 'a' }));
    this.defaultSchemaBehavior = options.defaultSchemaBehavior;
  }

  /**
   * Emit a SCHEMA message for a stream.
   */
  async emitSchema(
    resource: SchemaResourceLike,
    options?: { fullRefresh?: boolean }
  ): Promise<void> {
    await this.writeMessage(
      resource.name,
      buildSchemaMessage(resource, {
        ...options,
        defaultSchemaBehavior: this.defaultSchemaBehavior,
      })
    );
  }

  /**
   * Emit a RECORD message.
   */
  async emitRecord(
    stream: string,
    record: RecordMessage['record'],
    timeExtracted?: string
  ): Promise<void> {
    const message = {
      _v: PROTOCOL_VERSION,
      type: 'RECORD',
      stream,
      record,
      time_extracted: timeExtracted ?? new Date().toISOString(),
    } satisfies RecordMessage;

    await this.writeMessage(stream, message);
  }

  /**
   * Emit a BATCH message referencing finalized batch files.
   */
  async emitBatch(stream: string, encoding: BatchEncoding, manifest: string[]): Promise<void> {
    const message = {
      _v: PROTOCOL_VERSION,
      type: 'BATCH',
      stream,
      encoding,
      manifest,
    } satisfies BatchMessage;

    await this.writeMessage(stream, message);
  }

  /**
   * Emit a STATE message with bookmark info. `partition` is set when this
   * stream is being extracted as one iteration of a `for_each` loop — it
   * scopes the bookmark slot without changing the destination table identity.
   */
  async emitState(stream: string, value: StateMessage['value'], partition?: string): Promise<void> {
    const message = {
      _v: PROTOCOL_VERSION,
      type: 'STATE',
      stream,
      ...(partition !== undefined ? { partition } : {}),
      value,
    } satisfies StateMessage;

    await this.writeMessage(stream, message);
  }

  async close(): Promise<void> {
    await Promise.all(this.writeChains.values());
    await Promise.all(
      [...this.fileHandles.values()].map(
        (handle) => new Promise<void>((resolve) => handle.end(resolve))
      )
    );
    this.fileHandles.clear();
    this.writeChains.clear();
  }

  private async writeMessage(
    stream: string,
    message: SchemaMessage | RecordMessage | StateMessage | BatchMessage
  ): Promise<void> {
    const line = JSON.stringify(message) + '\n';

    if (this.mode === 'file') {
      const handle = this.getFileHandle(stream);
      await this.enqueueWrite(stream, handle, line);
    } else {
      await this.enqueueWrite('__stdout__', this.stdoutStream, line);
    }
  }

  private getFileHandle(stream: string): Writable {
    let handle = this.fileHandles.get(stream);
    if (!handle) {
      if (!this.outputDirCreated) {
        fs.mkdirSync(this.outputDir, { recursive: true });
        this.outputDirCreated = true;
      }
      const filePath = path.join(this.outputDir, `${stream}.jsonl`);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(this.outputDir) + path.sep)) {
        throw new Error(`Invalid stream name: path traversal detected in "${stream}"`);
      }
      handle = this.createWriteStream(filePath);
      this.fileHandles.set(stream, handle);
    }
    return handle;
  }

  private async enqueueWrite(channel: string, stream: Writable, line: string): Promise<void> {
    const next = (this.writeChains.get(channel) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (stream.write(line)) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            stream.removeListener('error', onError);
            resolve();
          };
          const onError = (err: Error) => {
            stream.removeListener('drain', onDrain);
            reject(err);
          };
          stream.once('drain', onDrain);
          stream.once('error', onError);
        });
      });

    this.writeChains.set(channel, next);
    await next;
  }
}
