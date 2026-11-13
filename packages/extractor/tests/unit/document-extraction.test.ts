import { mkdtemp, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DogsledRuntimeError } from '@bobsled-inc/protocol';

import { LocalFileStorageClient } from '../../src/runtime/clients/local-file-client.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { extractDocumentResource } from '../../src/runtime/document-extraction.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';
import type { StateStore } from '../../src/runtime/state.js';

function createStateStore(state: ExtractorState): StateStore {
  return {
    load: vi.fn().mockResolvedValue(state),
    save: vi.fn().mockImplementation(async (next: ExtractorState) => {
      state.streams = next.streams;
    }),
  };
}

interface ResourceOpts {
  replicationMethod?: 'full_refresh' | 'incremental_append';
  pathPattern?: string;
  onError?: 'record' | 'skip' | 'fail';
  formats?: ('pdf' | 'docx' | 'pptx' | 'html' | 'md' | 'txt' | 'eml')[];
  maxFileSizeMb?: number;
}

function documentResource(opts: ResourceOpts = {}): FileResourceSpec {
  // The runtime predicate only sniffs `source.kind === 'document'` (or `format:
  // document`); these casts let us hand-build minimal fixtures without going through
  // FileResourceSpecSchema.parse() which would require the warehouse-output union.
  return {
    spec_version: '1',
    type: 'resource',
    name: 'docs',
    description: '',
    input: {},
    source: {
      kind: 'document',
      path: opts.pathPattern ?? '*.md',
      parse: {
        formats: opts.formats ?? ['md', 'txt', 'pdf'],
        on_error: opts.onError ?? 'record',
        ...(opts.maxFileSizeMb !== undefined && { max_file_size_mb: opts.maxFileSizeMb }),
      },
      chunk: { max_tokens: 200, overlap_tokens: 20, tokenizer: 'cl100k_base' },
      ingest: { mode: 'extract' },
      permissions: { capture: true, enforcement: { enabled: false } },
    },
    replication: { method: opts.replicationMethod ?? 'full_refresh' },
    extract: {},
    output: {
      document_id: { type: 'string' },
    },
  } as unknown as FileResourceSpec;
}

function localIntegration(baseDir: string): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'local_docs',
    source_type: 'local',
    connection: { base_directory: baseDir },
    auth: { type: 'none' },
  } as unknown as IntegrationSpec;
}

interface RunArgs {
  files?: Array<{ name: string; content: string }>;
  resourceOpts?: ResourceOpts;
  fullRefresh?: boolean;
  limit?: number;
  prevState?: ExtractorState;
}

async function runExtraction(args: RunArgs = {}) {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'doc-ext-test-'));
  for (const f of args.files ?? []) {
    await writeFile(path.join(baseDir, f.name), f.content);
  }
  const stdout = new FakeWritable();
  const stderr = new FakeWritable();
  const state: ExtractorState = args.prevState ?? { streams: {} };

  const result = await extractDocumentResource({
    integration: localIntegration(baseDir),
    resource: documentResource(args.resourceOpts),
    integrationName: 'local_docs',
    emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
    logger: new ControlLogger({ stream: stderr }),
    state,
    stateStore: createStateStore(state),
    advanceState: true,
    fullRefresh: args.fullRefresh,
    limit: args.limit,
    startedAt: Date.now(),
  });
  const messages = stdout.chunks
    .map((chunk) => chunk.toString())
    .filter((s) => s.length > 0)
    .flatMap((s) => s.split('\n').filter((line) => line.length > 0))
    .map((line) => JSON.parse(line) as { type: string; stream?: string });
  return { result, messages, baseDir, state };
}

describe('extractDocumentResource', () => {
  it('fails the run on a connection-level download error instead of recording a parse error', async () => {
    const lost = new DogsledRuntimeError({
      kind: 'provider',
      code: 'SFTP_CONNECTION_LOST',
      operation: 'extractor.sftp.download',
      retryable: true,
    });
    const download = vi
      .spyOn(LocalFileStorageClient.prototype, 'download')
      .mockRejectedValueOnce(lost);
    try {
      const state: ExtractorState = { streams: {} };
      await expect(
        runExtraction({ files: [{ name: 'a.md', content: '# A' }], prevState: state })
      ).rejects.toBe(lost);
      expect(state.streams).toEqual({});
    } finally {
      download.mockRestore();
    }
  });

  it('emits all SCHEMA messages before any RECORD (schema-before-record contract)', async () => {
    const { messages } = await runExtraction({
      files: [
        { name: 'one.md', content: '# Hi\n\nbody.' },
        { name: 'two.md', content: '# Two\n\nmore body.' },
      ],
    });
    const firstRecordIdx = messages.findIndex((m) => m.type === 'RECORD');
    const lastSchemaIdx = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.type === 'SCHEMA')
      .map(({ i }) => i)
      .at(-1);
    expect(firstRecordIdx).toBeGreaterThan(0);
    expect(lastSchemaIdx).toBeDefined();
    expect(lastSchemaIdx!).toBeLessThan(firstRecordIdx);
  });

  it('emits __documents and __chunks for parsed files', async () => {
    const { messages } = await runExtraction({
      files: [{ name: 'a.md', content: '# Title\n\nbody text here.\n' }],
    });
    const docs = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__documents');
    const chunks = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__chunks');
    expect(docs.length).toBe(1);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('appends with per-file REPLACE on incremental runs and replaces whole tables on full reads', async () => {
    const files = [{ name: 'a.md', content: '# Title\n\nbody text here.\n' }];
    const strategies = (messages: Array<Record<string, unknown>>) =>
      new Set(messages.filter((m) => m.type === 'SCHEMA').map((m) => m.load_strategy));
    const replaces = (messages: Array<Record<string, unknown>>) =>
      messages.filter((m) => m.type === 'REPLACE').map((m) => m.stream);
    const incremental = await runExtraction({
      files,
      resourceOpts: { replicationMethod: 'incremental_append' },
    });
    expect(strategies(incremental.messages)).toEqual(new Set(['append']));
    expect(replaces(incremental.messages)).toEqual(
      expect.arrayContaining(['docs__documents', 'docs__chunks', 'docs__parse_errors'])
    );
    const forced = await runExtraction({
      files,
      resourceOpts: { replicationMethod: 'incremental_append' },
      fullRefresh: true,
    });
    const configured = await runExtraction({ files });
    for (const { messages } of [forced, configured]) {
      expect(strategies(messages)).toEqual(new Set(['full_refresh']));
      expect(replaces(messages)).toEqual([]);
    }
  });

  it('emits __acl schema when permission capture is enabled even without provider rows', async () => {
    const { messages } = await runExtraction({
      files: [{ name: 'a.md', content: '# Title\n\nbody text here.\n' }],
    });
    const aclSchemas = messages.filter((m) => m.type === 'SCHEMA' && m.stream === 'docs__acl');
    expect(aclSchemas.length).toBe(1);
  });

  it('honors source.parse.formats by parser format, not raw extension alias', async () => {
    const { messages } = await runExtraction({
      files: [{ name: 'guide.markdown', content: '# Guide\n\nbody text here.\n' }],
      resourceOpts: { pathPattern: '*', formats: ['md'] },
    });
    const docs = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__documents');
    const errors = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__parse_errors');
    expect(docs.length).toBe(1);
    expect(errors.length).toBe(0);
  });

  it('honors source.parse.formats allowlist — extension outside list emits parse_errors', async () => {
    const { messages } = await runExtraction({
      files: [{ name: 'mystery.xyz', content: 'whatever' }],
      resourceOpts: { pathPattern: '*', formats: ['md'] },
    });
    const errors = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__parse_errors');
    expect(errors.length).toBe(1);
    const errorRow = errors[0]! as unknown as { record: { error_code: string; format: string } };
    expect(errorRow.record.error_code).toBe('unsupported_format');
  });

  it('on_error: skip does NOT bookmark a parser-failure file (allows retry on re-run)', async () => {
    // A malformed PDF reaches the parser-side error branch after format selection. The
    // skip case `continue`s without writing nextFiles[uri], so a re-run retries this
    // exact file.
    const { messages, state } = await runExtraction({
      files: [{ name: 'sample.pdf', content: 'not a pdf' }],
      resourceOpts: { pathPattern: '*', formats: ['pdf'], onError: 'skip' },
    });
    // A parse_errors row IS emitted (the skip branch logs the error before continuing).
    const errors = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__parse_errors');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Bookmark is NOT advanced for this file — that's the skip-vs-record difference.
    const bookmark = state.streams['local_docs/docs'] as
      { files?: Record<string, unknown> } | undefined;
    expect(bookmark?.files?.['sample.pdf']).toBeUndefined();
  });

  it('rereads unchanged documents when the resource replicates with full_refresh', async () => {
    const first = await runExtraction({
      files: [{ name: 'guide.md', content: '# Guide\n\nHello.' }],
    });
    expect(
      first.messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__documents')
    ).toHaveLength(1);

    const stdout = new FakeWritable();
    await extractDocumentResource({
      integration: localIntegration(first.baseDir),
      resource: documentResource(),
      integrationName: 'local_docs',
      emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
      logger: new ControlLogger({ stream: new FakeWritable() }),
      state: first.state,
      stateStore: createStateStore(first.state),
      advanceState: true,
      startedAt: Date.now(),
    });
    const second = stdout.chunks
      .map((chunk) => chunk.toString())
      .flatMap((s) => s.split('\n').filter((line) => line.length > 0))
      .map((line) => JSON.parse(line) as { type: string; stream?: string });
    expect(
      second.filter((m) => m.type === 'RECORD' && m.stream === 'docs__documents')
    ).toHaveLength(1);
  });

  it('does not advance bookmark on --limit-truncated chunk loop', async () => {
    // Build a doc large enough to produce several chunks (max_tokens=200 → 2+ chunks
    // for a few hundred tokens of text).
    const longText = 'paragraph here. '.repeat(400);
    const { state } = await runExtraction({
      files: [{ name: 'big.md', content: longText }],
      limit: 1,
    });
    const bookmark = state.streams['local_docs/docs'] as
      { files?: Record<string, unknown> } | undefined;
    expect(bookmark?.files?.['big.md']).toBeUndefined();
  });

  it('fileSize over max_file_size_mb produces parse_errors row + does NOT bookmark', async () => {
    const big = 'x'.repeat(200 * 1024); // 200 KB
    const { messages, state } = await runExtraction({
      files: [{ name: 'too-big.md', content: big }],
      resourceOpts: { maxFileSizeMb: 1 / 1024 / 8 }, // ~128 bytes — guarantees rejection
    });
    const errors = messages.filter((m) => m.type === 'RECORD' && m.stream === 'docs__parse_errors');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const bookmark = state.streams['local_docs/docs'] as
      { files?: Record<string, unknown> } | undefined;
    // Oversized files don't enter the bookmark map (they're rejected before the
    // download path that writes nextFiles[file.uri]).
    expect(bookmark?.files?.['too-big.md']).toBeUndefined();
  });

  it('does not write entity-graph or Model Spec specs during extraction', async () => {
    const { baseDir } = await runExtraction({
      files: [{ name: 'a.md', content: '# t\n\nbody.' }],
    });
    expect(fs.existsSync(path.join(baseDir, 'entity_graph'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, '.dogsled/model-spec'))).toBe(false);
  });
});
