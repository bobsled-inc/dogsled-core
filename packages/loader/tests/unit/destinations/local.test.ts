import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalDestination } from '../../../src/runtime/destinations/local.js';

describe('LocalDestination', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-destination-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('publishes files under the configured output directory', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });
    const uri = await destination.publish(sourcePath, 'issues/issues-0.csv');
    const expectedPath = path.join(outputDir, 'issues', 'issues-0.csv');

    expect(uri).toBe(pathToFileURL(expectedPath).href);
    await expect(fs.readFile(expectedPath, 'utf-8')).resolves.toContain('id');
    await expect(fs.access(sourcePath)).rejects.toThrow();
  });

  it('publishes to a flat destination path without subdirectory', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });
    const uri = await destination.publish(sourcePath, 'output.csv');
    const expectedPath = path.join(outputDir, 'output.csv');

    expect(uri).toBe(pathToFileURL(expectedPath).href);
    await expect(fs.readFile(expectedPath, 'utf-8')).resolves.toContain('id');
  });

  it('creates nested directories for deeply nested destination paths', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'data\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });
    const uri = await destination.publish(sourcePath, 'a/b/c/file.csv');
    const expectedPath = path.join(outputDir, 'a', 'b', 'c', 'file.csv');

    expect(uri).toBe(pathToFileURL(expectedPath).href);
    await expect(fs.readFile(expectedPath, 'utf-8')).resolves.toContain('data');
  });

  it('removes the source file after publish', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });
    await destination.publish(sourcePath, 'issues/issues-0.csv');

    await expect(fs.access(sourcePath)).rejects.toThrow();
  });

  it('creates the output directory if it does not exist', async () => {
    const outputDir = path.join(tempDir, 'nested', 'deep', 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });
    await destination.publish(sourcePath, 'data.csv');

    await expect(fs.readFile(path.join(outputDir, 'data.csv'), 'utf-8')).resolves.toContain('id');
  });

  it('falls back to copy + unlink when rename crosses devices', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    let copied = false;
    const destination = new LocalDestination({
      outputDir,
      fileSystem: {
        mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
        copyFile: async (source, destinationPath) => {
          copied = true;
          await fs.copyFile(source, destinationPath);
        },
        rename: async () => {
          const error = new Error('cross-device') as NodeJS.ErrnoException;
          error.code = 'EXDEV';
          throw error;
        },
        unlink: (filePath) => fs.unlink(filePath),
      },
    });

    await destination.publish(sourcePath, 'issues/issues-0.csv');

    expect(copied).toBe(true);
    await expect(
      fs.readFile(path.join(outputDir, 'issues', 'issues-0.csv'), 'utf-8')
    ).resolves.toContain('id');
  });

  it('rethrows non-EXDEV rename errors', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({
      outputDir,
      fileSystem: {
        mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
        copyFile: () => Promise.resolve(),
        rename: () => {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
        unlink: () => Promise.resolve(),
      },
    });

    await expect(destination.publish(sourcePath, 'data.csv')).rejects.toThrow('permission denied');
  });

  it('propagates mkdir failure', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({
      outputDir,
      fileSystem: {
        mkdir: () => {
          throw new Error('mkdir: EACCES');
        },
        copyFile: () => Promise.resolve(),
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
      },
    });

    await expect(destination.publish(sourcePath, 'data.csv')).rejects.toThrow('mkdir: EACCES');
  });

  it('rejects traversal outside the output directory', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });

    await expect(destination.publish(sourcePath, '../escape.csv')).rejects.toThrow(
      'Invalid destination path'
    );
  });

  it('normalizes absolute-style destination paths to be relative', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });
    const uri = await destination.publish(sourcePath, '/etc/passwd');

    // Leading slash is stripped by normalizeDestinationPath, so file lands under outputDir
    const expectedPath = path.join(outputDir, 'etc', 'passwd');
    expect(uri).toBe(pathToFileURL(expectedPath).href);
    await expect(fs.readFile(expectedPath, 'utf-8')).resolves.toContain('id');
  });

  it('rejects empty destination path', async () => {
    const outputDir = path.join(tempDir, 'out');
    const sourcePath = path.join(tempDir, 'source.csv');
    await fs.writeFile(sourcePath, 'id\n1\n', 'utf-8');

    const destination = new LocalDestination({ outputDir });

    await expect(destination.publish(sourcePath, '')).rejects.toThrow('Invalid destination path');
  });

  it('handles multiple sequential publishes to the same directory', async () => {
    const outputDir = path.join(tempDir, 'out');
    const destination = new LocalDestination({ outputDir });

    for (let i = 0; i < 3; i++) {
      const sourcePath = path.join(tempDir, `source-${i}.csv`);
      await fs.writeFile(sourcePath, `id\n${i}\n`, 'utf-8');
      const uri = await destination.publish(sourcePath, `batch/file-${i}.csv`);
      const expectedPath = path.join(outputDir, 'batch', `file-${i}.csv`);
      expect(uri).toBe(pathToFileURL(expectedPath).href);
    }

    for (let i = 0; i < 3; i++) {
      const content = await fs.readFile(path.join(outputDir, 'batch', `file-${i}.csv`), 'utf-8');
      expect(content).toContain(String(i));
    }
  });
});
