import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { sanitizeStreamName } from './utils.js';

export interface RecordBufferOptions {
  stream: string;
  flushThreshold: number;
  tempDir: string;
  /** Target file size in bytes. When estimated buffer size exceeds this, flush is triggered. */
  targetFileSizeBytes?: number;
  /** Shared memory tracker for coordinating backpressure across buffers. */
  memoryTracker?: MemoryTracker;
}

/** Number of records sampled to estimate average bytes per record. */
const SAMPLE_SIZE = 100;

/** Safety multiplier for memory estimates to account for JSON overhead and staging. */
const MEMORY_SAFETY_MULTIPLIER = 1.3;

export class MemoryTracker {
  private readonly maxBytes: number;
  private readonly buffers = new Set<RecordBuffer>();

  constructor(maxBytes: number) {
    if (maxBytes <= 0) {
      throw new Error(`Invalid maxBytes: ${maxBytes}`);
    }
    this.maxBytes = maxBytes;
  }

  register(buffer: RecordBuffer): void {
    this.buffers.add(buffer);
  }

  unregister(buffer: RecordBuffer): void {
    this.buffers.delete(buffer);
  }

  get totalBytes(): number {
    let total = 0;
    for (const buffer of this.buffers) {
      total += buffer.estimatedBytes;
    }
    return total;
  }

  /**
   * If total memory across all tracked buffers exceeds the limit,
   * force-flush the largest buffer to free memory.
   * Returns the flushed file path (if any) so the caller can schedule it for loading.
   */
  async enforceLimit(): Promise<string | null> {
    if (this.totalBytes <= this.maxBytes) {
      return null;
    }

    let largest: RecordBuffer | null = null;
    let largestBytes = 0;

    for (const buffer of this.buffers) {
      const bytes = buffer.estimatedBytes;
      if (bytes > largestBytes) {
        largestBytes = bytes;
        largest = buffer;
      }
    }

    if (largest !== null && largestBytes > 0) {
      return largest.flush();
    }

    return null;
  }
}

export class RecordBuffer {
  private readonly stream: string;
  private flushThreshold: number;
  private readonly tempDir: string;
  private targetFileSizeBytes: number | undefined;
  private readonly tracker: MemoryTracker | undefined;
  private readonly records: Record<string, unknown>[] = [];
  private readonly tempFiles = new Set<string>();
  private fileIndex = 0;
  /** Monotonic batch ID for correlating flushes with loads. */
  private _batchId = 0;

  /** Running total of serialized byte sizes for the first SAMPLE_SIZE records. */
  private sampleBytesTotal = 0;
  /** Number of records that have been sampled (capped at SAMPLE_SIZE). */
  private sampleCount = 0;

  constructor(options: RecordBufferOptions) {
    if (!Number.isInteger(options.flushThreshold) || options.flushThreshold <= 0) {
      throw new Error(`Invalid flushThreshold: ${options.flushThreshold}`);
    }
    this.stream = sanitizeStreamName(options.stream);
    this.flushThreshold = options.flushThreshold;
    this.tempDir = path.resolve(options.tempDir);
    this.targetFileSizeBytes = options.targetFileSizeBytes;
    this.tracker = options.memoryTracker;

    if (this.tracker) {
      this.tracker.register(this);
    }
  }

  /**
   * Average bytes per record based on the first SAMPLE_SIZE records.
   * Returns 0 if no records have been sampled yet.
   */
  private get avgBytesPerRecord(): number {
    if (this.sampleCount === 0) {
      return 0;
    }
    return this.sampleBytesTotal / this.sampleCount;
  }

  /**
   * Estimated total bytes currently buffered in memory.
   */
  get estimatedBytes(): number {
    return Math.ceil(this.records.length * this.avgBytesPerRecord * MEMORY_SAFETY_MULTIPLIER);
  }

  /**
   * Returns true if the buffer should be flushed based on record count
   * or estimated byte size.
   */
  shouldFlush(): boolean {
    if (this.records.length >= this.flushThreshold) {
      return true;
    }

    if (
      this.targetFileSizeBytes !== undefined &&
      this.sampleCount > 0 &&
      this.estimatedBytes >= this.targetFileSizeBytes
    ) {
      return true;
    }

    return false;
  }

  async addRecord(record: Record<string, unknown>): Promise<string | null> {
    // Sample the first SAMPLE_SIZE records for byte-size estimation.
    if (this.sampleCount < SAMPLE_SIZE) {
      // +1 for the trailing newline written to JSONL
      this.sampleBytesTotal += JSON.stringify(record).length + 1;
      this.sampleCount += 1;
    }

    this.records.push(record);

    // Memory pressure may force-flush a buffer (possibly this one).
    // Return the flushed path so the caller can schedule it for loading.
    if (this.tracker) {
      const pressureFlushed = await this.tracker.enforceLimit();
      if (pressureFlushed) {
        return pressureFlushed;
      }
    }

    if (!this.shouldFlush()) {
      return null;
    }

    return this.flush();
  }

  /** Update flush thresholds (used by backpressure to increase buffer sizes). */
  updateThresholds(flushThreshold: number, targetFileSizeBytes?: number): void {
    this.flushThreshold = flushThreshold;
    this.targetFileSizeBytes = targetFileSizeBytes;
  }

  /** The batch ID of the most recent flush (0 = no flushes yet). */
  get lastBatchId(): number {
    return this._batchId;
  }

  async flush(): Promise<string | null> {
    if (this.records.length === 0) {
      return null;
    }

    this._batchId++;
    const filePath = this.nextFilePath();
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    // Stream records to disk one at a time to avoid materializing the entire
    // buffer as a single string (O(n) memory spike with large bufferSize).
    const handle = await fsPromises.open(filePath, 'w');
    try {
      for (const r of this.records) {
        await handle.write(JSON.stringify(r) + '\n');
      }
    } finally {
      await handle.close();
    }

    this.records.length = 0;
    this.tempFiles.add(filePath);

    return filePath;
  }

  /**
   * Returns all temp file paths that have been flushed to disk so far.
   * Does not include records still in memory (call flush() first if needed).
   */
  flushAll(): string[] {
    return [...this.tempFiles];
  }

  async cleanup(): Promise<void> {
    const removals = [...this.tempFiles].map((filePath) =>
      fsPromises.rm(filePath, { force: true })
    );
    await Promise.allSettled(removals);
    this.tempFiles.clear();

    if (this.tracker) {
      this.tracker.unregister(this);
    }
  }

  private nextFilePath(): string {
    const fileName = `${this.stream}-${this.fileIndex}.jsonl`;
    const filePath = path.resolve(this.tempDir, fileName);
    const prefix = this.tempDir.endsWith(path.sep) ? this.tempDir : `${this.tempDir}${path.sep}`;

    if (filePath !== this.tempDir && !filePath.startsWith(prefix)) {
      throw new Error(`Invalid stream name: path traversal detected in "${this.stream}"`);
    }

    this.fileIndex += 1;
    return filePath;
  }
}
