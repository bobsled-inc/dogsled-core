import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { registerAclBackend } from '../../src/runtime/acl-capture.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { extractDocumentResource } from '../../src/runtime/document-extraction.js';
import { LocalFileStorageClient } from '../../src/runtime/clients/local-file-client.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';

type Message = {
  type: string;
  stream?: string;
  key?: string;
  values?: string[];
  load_strategy?: string;
  record?: Record<string, unknown>;
};

function resource(method: 'full_refresh' | 'incremental_append'): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'docs',
    description: '',
    input: {},
    source: {
      kind: 'document',
      path: '*.md',
      parse: { formats: ['md'], on_error: 'record' },
      chunk: { max_tokens: 200, overlap_tokens: 20, tokenizer: 'cl100k_base' },
      ingest: { mode: 'extract' },
      permissions: { capture: true, enforcement: { enabled: false } },
    },
    replication: { method },
    extract: {},
    output: { document_id: { type: 'string' } },
  } as unknown as FileResourceSpec;
}

async function run(
  baseDir: string,
  state: ExtractorState,
  method: 'full_refresh' | 'incremental_append' = 'incremental_append'
): Promise<Message[]> {
  const stdout = new FakeWritable();
  await extractDocumentResource({
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'local_docs',
      source_type: 'local',
      connection: { base_directory: baseDir },
      auth: { type: 'none' },
    } as unknown as IntegrationSpec,
    resource: resource(method),
    integrationName: 'local_docs',
    emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
    logger: new ControlLogger({ stream: new FakeWritable() }),
    state,
    stateStore: {
      load: vi.fn().mockResolvedValue(state),
      save: vi.fn().mockImplementation(async (next: ExtractorState) => {
        state.streams = next.streams;
      }),
    },
    advanceState: true,
    startedAt: Date.now(),
  });
  return stdout.chunks
    .map((chunk) => chunk.toString())
    .flatMap((text) => text.split('\n').filter((line) => line.length > 0))
    .map((line) => JSON.parse(line) as Message);
}

const STREAMS = ['docs__documents', 'docs__chunks', 'docs__parse_errors', 'docs__acl'];
const replaced = (messages: Message[]) =>
  messages
    .filter((m) => m.type === 'REPLACE')
    .map((m) => `${m.stream}:${m.key}:${m.values?.length}`);

beforeAll(() => {
  registerAclBackend({
    provider: 'local',
    captureForFile: async ({ documentId }) => [
      {
        row_id: documentId,
        row_type: 'document',
        principal_id: 'group:readers',
        source_grant_type: 'file_storage_group',
        source_provider: 'local',
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
});

describe('document Resources replace a changed file per stream', () => {
  it('sends REPLACE for every stream of a changed file before its rows, and none for unchanged files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'doc-replace-'));
    await writeFile(path.join(dir, 'a.md'), '# A\n\nfirst.');
    await writeFile(path.join(dir, 'b.md'), '# B\n\nsecond.');
    const state: ExtractorState = { streams: {} };

    const first = await run(dir, state);
    expect(
      first.filter((m) => m.type === 'SCHEMA').map((m) => [m.stream, m.load_strategy])
    ).toEqual(STREAMS.map((stream) => [stream, 'append']));
    expect(replaced(first)).toHaveLength(STREAMS.length * 2);
    for (const stream of ['docs__documents', 'docs__chunks', 'docs__acl']) {
      const firstReplace = first.findIndex((m) => m.type === 'REPLACE' && m.stream === stream);
      const firstRecord = first.findIndex((m) => m.type === 'RECORD' && m.stream === stream);
      expect(firstReplace).toBeGreaterThanOrEqual(0);
      expect(firstReplace).toBeLessThan(firstRecord);
    }
    const acl = first.filter((m) => m.type === 'RECORD' && m.stream === 'docs__acl');
    expect(acl).toHaveLength(2);
    expect(acl.every((m) => typeof m.record?.['document_id'] === 'string')).toBe(true);

    await writeFile(path.join(dir, 'b.md'), '# B\n\nsecond, longer now.');
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(dir, 'b.md'), later, later);
    const second = await run(dir, state);
    const ids = new Set(second.filter((m) => m.type === 'REPLACE').flatMap((m) => m.values));
    expect(replaced(second)).toEqual(STREAMS.map((stream) => `${stream}:document_id:1`));
    expect(ids.size).toBe(1);
    expect(second.filter((m) => m.type === 'RECORD' && m.stream === 'docs__documents')).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ document_id: [...ids][0] }) }),
    ]);
  });

  it('replaces whole tables without REPLACE on a full read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'doc-replace-'));
    await writeFile(path.join(dir, 'a.md'), '# A\n\nfirst.');
    const messages = await run(dir, { streams: {} }, 'full_refresh');
    expect(
      new Set(messages.filter((m) => m.type === 'SCHEMA').map((m) => m.load_strategy))
    ).toEqual(new Set(['full_refresh']));
    expect(replaced(messages)).toEqual([]);
  });

  it('keeps the last good rows when the new version cannot be downloaded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'doc-replace-'));
    await writeFile(path.join(dir, 'a.md'), '# A\n\nfirst.');
    const download = vi
      .spyOn(LocalFileStorageClient.prototype, 'download')
      .mockRejectedValueOnce(new Error('read failed'));
    try {
      const messages = await run(dir, { streams: {} });
      expect(replaced(messages)).toEqual(['docs__parse_errors:document_id:1']);
    } finally {
      download.mockRestore();
    }
  });
});
