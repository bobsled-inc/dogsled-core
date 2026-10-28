import { Writable, type WritableOptions } from 'node:stream';

import type { BufferEncoding } from 'node:buffer';

export class BufferingWritable extends Writable {
  readonly chunks: string[] = [];

  constructor(options?: WritableOptions) {
    super(options);
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk);
    callback();
  }

  toString(): string {
    return this.chunks.join('');
  }
}
