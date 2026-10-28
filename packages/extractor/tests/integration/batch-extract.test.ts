import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractResource } from '../../src/commands/extract.js';
import { ExtractorClient } from '../../src/runtime/client.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { FileStateStore } from '../../src/runtime/state.js';

import { makeProvider, makeResource } from '../helpers/fixtures.js';
import { createFakeServer, type FakeServer } from './helpers/fake-server.js';

interface ParquetItemRow {
  id: number;
  name: string;
}

async function readParquetRows(filePath: string): Promise<ParquetItemRow[]> {
  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();

  try {
    const escapedPath = filePath.replaceAll("'", "''");
    const reader = await conn.runAndReadAll(
      `SELECT * FROM read_parquet('${escapedPath}') ORDER BY id`
    );
    const rows = reader.getRowObjectsJS() as Array<{ id: number | bigint; name: string }>;
    return rows.map((row) => ({
      id: typeof row.id === 'bigint' ? Number(row.id) : row.id,
      name: row.name,
    }));
  } finally {
    conn.disconnectSync();
    db.closeSync();
  }
}

describe('batch extract integration', () => {
  let server: FakeServer;
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-batch-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    if (server) await server.close();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits SCHEMA → BATCH → STATE on stdout (no RECORD) in batch mode', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [
            { id: 1, name: 'alpha' },
            { id: 2, name: 'beta' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();
    const batchDir = path.join(tmpDir, 'batch');

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir,
      opts: { batch: true },
    });

    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(messages.map((m) => m.type)).toEqual(['SCHEMA', 'BATCH', 'STATE']);
    expect(messages.find((m) => m.type === 'RECORD')).toBeUndefined();
    expect(result.recordCount).toBe(2);
    expect(result.batchFiles).toBe(1);
  });

  it('batch files on disk contain raw JSONL records', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [
            { id: 1, name: 'alpha' },
            { id: 2, name: 'beta' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();
    const batchDir = path.join(tmpDir, 'batch');

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir,
      opts: { batch: true },
    });

    const batchFile = path.join(batchDir, 'test_items', 'test_items-0.jsonl');
    expect(fs.existsSync(batchFile)).toBe(true);
    const lines = fs
      .readFileSync(batchFile, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it('writes parquet batch files and emits parquet BATCH metadata', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [
            { id: 1, name: 'alpha' },
            { id: 2, name: 'beta' },
          ],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();
    const batchDir = path.join(tmpDir, 'batch');

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir,
      opts: { batch: true, batchFormat: 'parquet' },
    });

    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const batchMessage = messages.find((message) => message.type === 'BATCH');
    expect(batchMessage?.encoding).toEqual({ format: 'parquet' });

    const batchFile = path.join(batchDir, 'test_items', 'test_items-0.parquet');
    expect(fs.existsSync(batchFile)).toBe(true);
    await expect(readParquetRows(batchFile)).resolves.toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it('creates multiple batch files when records exceed maxRecords', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `item_${i + 1}` })),
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();
    const batchDir = path.join(tmpDir, 'batch');

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir,
      opts: { batch: true, batchSize: 2 },
    });

    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const batchMessages = messages.filter((m) => m.type === 'BATCH');
    expect(batchMessages).toHaveLength(3); // 2+2+1
    expect(result.recordCount).toBe(5);
    expect(result.batchFiles).toBe(3);
  });

  it('without batch flag produces RECORD output', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [{ id: 1, name: 'alpha' }],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource();
    const batchDir = path.join(tmpDir, 'batch');

    await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir,
      opts: {},
    });

    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(messages.map((m) => m.type)).toEqual(['SCHEMA', 'RECORD', 'STATE']);
    expect(messages.find((m) => m.type === 'BATCH')).toBeUndefined();
  });

  it('--batch CLI flag activates batch mode on resource without batch config', async () => {
    server = await createFakeServer([
      {
        path: '/items',
        handler: () => ({
          body: [{ id: 1, name: 'alpha' }],
        }),
      },
    ]);

    const stateStore = new FileStateStore(tmpDir);
    const state = await stateStore.load();
    const integrationSpec = makeProvider(server.url);
    const resource = makeResource(); // No batch config
    const batchDir = path.join(tmpDir, 'batch');

    const result = await extractResource({
      integration: integrationSpec,
      integrationName: 'test_api',
      resource,
      client: new ExtractorClient({ integration: integrationSpec }),
      emitter: new Emitter('stdout', path.join(tmpDir, 'output')),
      logger: new ControlLogger({ logFormat: 'json' }),
      state,
      stateStore,
      batchDir,
      opts: { batch: true },
    });

    const messages = stdoutSpy.mock.calls
      .map((call) => String(call[0]).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(messages.map((m) => m.type)).toEqual(['SCHEMA', 'BATCH', 'STATE']);
    expect(result.batchFiles).toBe(1);
  });
});
