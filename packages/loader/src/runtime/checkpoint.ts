import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export class CheckpointManager {
  private readonly checkpointDir: string;

  constructor(checkpointDir: string) {
    this.checkpointDir = path.resolve(checkpointDir);
  }

  /** Save checkpoint for a stream using atomic write (temp -> rename). */
  async save(stream: string, state: unknown): Promise<void> {
    await fsPromises.mkdir(this.checkpointDir, { recursive: true });
    const filePath = this.filePath(stream);
    const tempPath = `${filePath}.tmp`;
    await fsPromises.writeFile(tempPath, JSON.stringify(state), 'utf-8');
    await fsPromises.rename(tempPath, filePath);
  }

  /** Load checkpoint for a stream. Returns null if no checkpoint exists. */
  async load(stream: string): Promise<unknown | null> {
    try {
      const data = await fsPromises.readFile(this.filePath(stream), 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /** Load all checkpoints. Returns a Map of stream -> state. */
  async loadAll(): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();
    try {
      const files = await fsPromises.readdir(this.checkpointDir);
      for (const file of files) {
        if (!file.endsWith('.checkpoint.json')) continue;
        const stream = file.replace('.checkpoint.json', '');
        const data = await fsPromises.readFile(path.join(this.checkpointDir, file), 'utf-8');
        result.set(stream, JSON.parse(data));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return result;
      }
      throw error;
    }
    return result;
  }

  /** Clear checkpoint for a stream. */
  async clear(stream: string): Promise<void> {
    await fsPromises.rm(this.filePath(stream), { force: true });
  }

  /** Save the set of already-truncated tables so full_refresh skips re-truncation on restart. */
  async saveTruncatedTables(tables: Set<string>): Promise<void> {
    await fsPromises.mkdir(this.checkpointDir, { recursive: true });
    const filePath = path.join(this.checkpointDir, '_truncated_tables.json');
    const tempPath = `${filePath}.tmp`;
    await fsPromises.writeFile(tempPath, JSON.stringify([...tables]), 'utf-8');
    await fsPromises.rename(tempPath, filePath);
  }

  /** Load the set of already-truncated tables. Returns an empty set if no file exists. */
  async loadTruncatedTables(): Promise<Set<string>> {
    try {
      const data = await fsPromises.readFile(
        path.join(this.checkpointDir, '_truncated_tables.json'),
        'utf-8'
      );
      const parsed: unknown = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        return new Set<string>();
      }
      return new Set<string>(parsed.filter((v): v is string => typeof v === 'string'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Set<string>();
      }
      throw error;
    }
  }

  /** Remove the truncated tables file. */
  async clearTruncatedTables(): Promise<void> {
    await fsPromises.rm(path.join(this.checkpointDir, '_truncated_tables.json'), { force: true });
  }

  private filePath(stream: string): string {
    // Sanitize stream name to prevent path traversal
    const safeName = stream.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (safeName.length === 0) {
      throw new Error('Stream name cannot be empty or contain only invalid characters');
    }
    return path.join(this.checkpointDir, `${safeName}.checkpoint.json`);
  }
}
