import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkDuckDb, checkDuckLake, checkLocal } from '../../../src/commands/check.js';
import { openDuckDb } from '../../../src/runtime/duckdb-primitives.js';

describe('check command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-check-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('checkDuckDb', () => {
    it('succeeds when database is writable', async () => {
      const dbPath = path.join(tempDir, 'test.duckdb');
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      await checkDuckDb(dbPath, {
        stderr,
        databaseFactory: openDuckDb,
      });

      expect(output).toContain('DuckDB: database writable at');
      expect(output).toContain(dbPath);
      // Verify the database file was actually created
      const stat = await fs.stat(dbPath);
      expect(stat.isFile()).toBe(true);
    });

    it('reports failure for invalid path', async () => {
      const dbPath = path.join(tempDir, 'nonexistent', 'nested', 'deeply', 'test.duckdb');
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      let exitCode: number | undefined;

      await checkDuckDb(dbPath, {
        stderr,
        databaseFactory: () => {
          throw new Error('Cannot open database');
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      });

      expect(output).toContain('DuckDB:');
      expect(output).toContain('Cannot open database');
      expect(exitCode).toBe(1);
    });
  });

  describe('checkLocal', () => {
    it('succeeds when directory exists and is writable', async () => {
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      await checkLocal(tempDir, { stderr });

      expect(output).toContain('Local: output directory');
      expect(output).toContain('is writable');
      expect(output).toContain(tempDir);
    });

    it('reports failure when directory does not exist', async () => {
      const missingDir = path.join(tempDir, 'does', 'not', 'exist');
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      let exitCode: number | undefined;
      await checkLocal(missingDir, {
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
      });

      expect(output).toContain('does not exist');
      expect(exitCode).toBe(1);
    });

    it('reports failure when path is a file not a directory', async () => {
      const filePath = path.join(tempDir, 'afile');
      await fs.writeFile(filePath, 'data');
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      let exitCode: number | undefined;
      await checkLocal(filePath, {
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
      });

      expect(output).toContain('is not a directory');
      expect(exitCode).toBe(1);
    });
  });

  describe('checkDuckLake', () => {
    it('succeeds when the destination initializes and closes cleanly', async () => {
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      await checkDuckLake(
        {
          catalogUrl: 'ducklake:./catalog.db',
          dataPath: './data',
          attachAlias: 'warehouse',
        },
        {
          stderr,
          checkFactory: async (options) => {
            expect(options).toEqual({
              catalogUrl: 'ducklake:./catalog.db',
              dataPath: './data',
              attachAlias: 'warehouse',
            });
          },
        }
      );

      expect(output).toContain('DuckLake: catalog "ducklake:./catalog.db" is accessible');
      expect(output).toContain('alias "warehouse"');
    });

    it('reports failures from destination initialization', async () => {
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      let exitCode: number | undefined;
      await checkDuckLake(
        { catalogUrl: 'ducklake:./catalog.db' },
        {
          stderr,
          checkFactory: async () => {
            throw new Error('extension install failed');
          },
          setExitCode: (code) => {
            exitCode = code;
          },
        }
      );

      expect(output).toContain('DuckLake: extension install failed');
      expect(exitCode).toBe(1);
    });
  });
});
