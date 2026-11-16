import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareStageFiles } from '../../../src/runtime/cross-warehouse-execution.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';

const columns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'name', type: 'string' },
];

let workDir = '';

async function writeChunks(count: number, rowsPerChunk: number): Promise<string[]> {
  const files: string[] = [];
  for (let chunk = 0; chunk < count; chunk += 1) {
    const lines = Array.from({ length: rowsPerChunk }, (_, row) => {
      const id = chunk * rowsPerChunk + row;
      return `${JSON.stringify({ id, name: `name_${id}` })}\n`;
    });
    const file = path.join(workDir, `stage-${chunk}.jsonl`);
    await fs.writeFile(file, lines.join(''));
    files.push(file);
  }
  return files;
}

async function readIds(file: string): Promise<number[]> {
  const text = await fs.readFile(file, 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { id: number }).id);
}

describe('prepareStageFiles', () => {
  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-xwh-stage-'));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('joins every JSONL chunk into one file in order for a one-load stage (BigQuery)', async () => {
    const chunks = await writeChunks(3, 4);

    const files = await prepareStageFiles(chunks, {
      oneFile: true,
      stagingFormat: 'jsonl',
      columns,
      workDir,
      baseName: 'stage',
    });

    expect(files).toEqual([path.join(workDir, 'stage-stage.jsonl')]);
    expect(await readIds(files[0]!)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    for (const chunk of chunks) {
      await expect(fs.access(chunk)).rejects.toThrow();
    }
  });

  it('converts the joined file to a single Parquet file', async () => {
    const chunks = await writeChunks(3, 5);

    const files = await prepareStageFiles(chunks, {
      oneFile: true,
      stagingFormat: 'parquet',
      columns,
      workDir,
      baseName: 'stage',
    });

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.parquet$/);
    const runner = await buildDuckDbRunner({
      spec_version: '1',
      type: 'integration',
      name: 'check',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: path.join(workDir, 'check.duckdb'), read_only: false },
    });
    try {
      const rows = await runner.query!(
        `SELECT COUNT(*)::INTEGER AS n, MIN(id)::INTEGER AS lo, MAX(id)::INTEGER AS hi FROM read_parquet('${files[0]!.replaceAll("'", "''")}')`
      );
      expect(rows).toEqual([{ n: 15, lo: 0, hi: 14 }]);
    } finally {
      await runner.close?.();
    }
  });

  it('keeps one file per chunk for other destinations', async () => {
    const chunks = await writeChunks(3, 2);

    const files = await prepareStageFiles(chunks, {
      oneFile: false,
      stagingFormat: 'jsonl',
      columns,
      workDir,
      baseName: 'stage',
    });

    expect(files).toEqual(chunks);
  });

  it('leaves a single chunk and an empty stage unchanged', async () => {
    const [chunk] = await writeChunks(1, 2);
    const options = {
      oneFile: true,
      stagingFormat: 'jsonl' as const,
      columns,
      workDir,
      baseName: 'stage',
    };

    await expect(prepareStageFiles([chunk!], options)).resolves.toEqual([chunk]);
    await expect(prepareStageFiles([], options)).resolves.toEqual([]);
  });
});
