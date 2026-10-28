import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointManager } from '../../src/runtime/checkpoint.js';

describe('CheckpointManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('save() writes checkpoint file to disk', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('my-stream', { cursor: 42 });

    const filePath = path.join(tempDir, 'my-stream.checkpoint.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const contents = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(contents).toEqual({ cursor: 42 });
  });

  it('load() reads saved checkpoint', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('my-stream', { cursor: 42, page: 'abc' });

    const state = await mgr.load('my-stream');
    expect(state).toEqual({ cursor: 42, page: 'abc' });
  });

  it('load() returns null for missing stream', async () => {
    const mgr = new CheckpointManager(tempDir);
    const state = await mgr.load('nonexistent');
    expect(state).toBeNull();
  });

  it('loadAll() returns all checkpoints', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('stream-a', { cursor: 1 });
    await mgr.save('stream-b', { cursor: 2 });
    await mgr.save('stream-c', { cursor: 3 });

    const all = await mgr.loadAll();
    expect(all.size).toBe(3);
    expect(all.get('stream-a')).toEqual({ cursor: 1 });
    expect(all.get('stream-b')).toEqual({ cursor: 2 });
    expect(all.get('stream-c')).toEqual({ cursor: 3 });
  });

  it('loadAll() returns empty map when directory does not exist', async () => {
    const mgr = new CheckpointManager(path.join(tempDir, 'nonexistent-subdir'));
    const all = await mgr.loadAll();
    expect(all.size).toBe(0);
  });

  it('clear() removes checkpoint file', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('my-stream', { cursor: 42 });

    // Verify it exists first
    expect(await mgr.load('my-stream')).toEqual({ cursor: 42 });

    await mgr.clear('my-stream');
    expect(await mgr.load('my-stream')).toBeNull();

    const filePath = path.join(tempDir, 'my-stream.checkpoint.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('save() performs atomic write via temp file rename', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('my-stream', { cursor: 1 });

    // After save completes, the .tmp file should not exist (it was renamed)
    const tempPath = path.join(tempDir, 'my-stream.checkpoint.json.tmp');
    expect(fs.existsSync(tempPath)).toBe(false);

    // The final file should exist with the correct content
    const filePath = path.join(tempDir, 'my-stream.checkpoint.json');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ cursor: 1 });
  });

  it('save() overwrites existing checkpoint', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('my-stream', { cursor: 1 });
    await mgr.save('my-stream', { cursor: 99, extra: true });

    const state = await mgr.load('my-stream');
    expect(state).toEqual({ cursor: 99, extra: true });
  });

  it('stream name sanitization prevents path traversal', async () => {
    const mgr = new CheckpointManager(tempDir);
    const maliciousStream = `../escape-${Date.now()}-${path.basename(tempDir)}`;
    await mgr.save(maliciousStream, { malicious: true });
    const sanitizedFileName = `${maliciousStream.replace(/[^a-zA-Z0-9_-]/g, '_')}.checkpoint.json`;

    // The file should be written inside the checkpoint dir, not at the traversal path
    const files = fs.readdirSync(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(sanitizedFileName);

    // A unique traversal target outside the checkpoint directory should not be created
    const escapedFilePath = path.resolve(tempDir, `${maliciousStream}.checkpoint.json`);
    expect(fs.existsSync(escapedFilePath)).toBe(false);

    // Should be loadable with the same key
    const state = await mgr.load(maliciousStream);
    expect(state).toEqual({ malicious: true });
  });

  it('rejects empty stream names after sanitization', async () => {
    const mgr = new CheckpointManager(tempDir);

    await expect(mgr.save('', { cursor: 1 })).rejects.toThrow(
      'Stream name cannot be empty or contain only invalid characters'
    );

    expect(fs.readdirSync(tempDir)).toHaveLength(0);
  });

  it('save() creates checkpoint directory if it does not exist', async () => {
    const nestedDir = path.join(tempDir, 'a', 'b', 'c');
    const mgr = new CheckpointManager(nestedDir);

    await mgr.save('my-stream', { cursor: 1 });

    expect(fs.existsSync(nestedDir)).toBe(true);
    const state = await mgr.load('my-stream');
    expect(state).toEqual({ cursor: 1 });
  });

  it('clear() is a no-op for non-existent stream', async () => {
    const mgr = new CheckpointManager(tempDir);
    // Should not throw
    await mgr.clear('nonexistent');
  });

  it('saveTruncatedTables() persists and loadTruncatedTables() restores', async () => {
    const mgr = new CheckpointManager(tempDir);
    const tables = new Set(['schema.table_a', 'schema.table_b']);
    await mgr.saveTruncatedTables(tables);

    const loaded = await mgr.loadTruncatedTables();
    expect(loaded).toEqual(tables);
  });

  it('loadTruncatedTables() returns empty set when no file exists', async () => {
    const mgr = new CheckpointManager(tempDir);
    const loaded = await mgr.loadTruncatedTables();
    expect(loaded.size).toBe(0);
  });

  it('clearTruncatedTables() removes the file', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.saveTruncatedTables(new Set(['t1']));
    await mgr.clearTruncatedTables();

    const loaded = await mgr.loadTruncatedTables();
    expect(loaded.size).toBe(0);
  });

  it('loadAll() ignores non-checkpoint files in directory', async () => {
    const mgr = new CheckpointManager(tempDir);
    await mgr.save('stream-a', { cursor: 1 });

    // Write a non-checkpoint file manually
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(tempDir, 'data.json'), '{}');

    const all = await mgr.loadAll();
    expect(all.size).toBe(1);
    expect(all.get('stream-a')).toEqual({ cursor: 1 });
  });
});
