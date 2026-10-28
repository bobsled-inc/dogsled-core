import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';

import {
  resolveEntityGraphRunner,
  type EntityGraphRunnerHandle,
} from '../../../src/runtime/runner-resolver.js';
import { extractMentionsProject } from '../../../src/api/mention-extract-project.js';

const mocks = vi.hoisted(() => ({
  runnerHandle: undefined as EntityGraphRunnerHandle | undefined,
}));

vi.mock('../../../src/runtime/runner-resolver.js', () => ({
  resolveEntityGraphRunner: vi.fn(async () => mocks.runnerHandle),
}));

let tmpDir: string;

function writeProject(): void {
  mkdirSync(path.join(tmpDir, 'mdm'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'model-spec.yml'), `mdm_dir: mdm\n`, 'utf-8');
  writeFileSync(
    path.join(tmpDir, 'mdm/Customer_resolution.yml'),
    [
      `spec_version: '0.2'`,
      `name: Customer`,
      `type: resolution`,
      `description: Resolve customers.`,
      `inputs:`,
      `  - ref: raw.customers`,
      `    id_fields: [customer_id]`,
      `blocking:`,
      `  rules:`,
      `    - name: name_block`,
      `      key: name`,
      `scoring:`,
      `  method: weighted_features`,
      `  features:`,
      `    - field: name`,
      `      algorithm: exact`,
      `      weight: 1`,
      `thresholds:`,
      `  auto_merge: 0.95`,
      `  review: 0.6`,
      `  auto_reject: 0.4`,
    ].join('\n'),
    'utf-8'
  );
  writeFileSync(
    path.join(tmpDir, 'mdm/Customer_mention_extraction.yml'),
    [
      `spec_version: '0.2'`,
      `type: mention_extraction`,
      `name: Customer_mentions`,
      `entity_types: [Customer]`,
      `candidate_retrieval:`,
      `  strategy: hybrid`,
      `  k: 10`,
      `  min_similarity: 0.55`,
      `extraction_role: mention_disambiguation_v1`,
    ].join('\n'),
    'utf-8'
  );
}

interface MentionChunkRow {
  chunk_id: string;
  chunk_text: string;
  document_id: string;
  document_version_id: string;
}

interface MentionCandidateRow {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  matched_text: string;
  match_source: string;
  profile_attrs: string | null;
  sim: number;
}

function candidate(input: {
  entity_id: string;
  canonical_name: string;
  sim: number;
  entity_type?: string;
}): MentionCandidateRow {
  return {
    entity_type: input.entity_type ?? 'Customer',
    matched_text: input.canonical_name,
    match_source: 'canonical_name',
    profile_attrs: null,
    ...input,
  };
}

function createRunner(options: {
  chunks: MentionChunkRow[];
  candidates: MentionCandidateRow[];
}): EntityGraphRunnerHandle & { candidateQueries: () => number; inserts: string[] } {
  let candidateQueries = 0;
  const inserts: string[] = [];
  const runner = {
    async run(sql: string) {
      inserts.push(sql);
      return { rowCount: 1 };
    },
    async query(sql: string) {
      if (sql.includes('__chunks')) return options.chunks;
      if (sql.includes('jaro_winkler_similarity')) {
        candidateQueries += 1;
        return options.candidates;
      }
      return [];
    },
  };
  return {
    runner,
    source: 'runner_path',
    close: vi.fn(async () => undefined),
    candidateQueries: () => candidateQueries,
    inserts,
  };
}

function fallbackSpan() {
  return {
    extract: vi.fn(async () => [
      {
        entity_type: 'Customer',
        entity_name: 'Acme Corp',
        span_start: 0,
        span_end: 9,
        source_confidence: 0.55,
      },
    ]),
  };
}

describe('extractMentionsProject', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'eg-mention-project-'));
    mocks.runnerHandle = undefined;
    writeProject();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads chunks, extracts fallback mentions, writes rows, and caches candidate retrieval by mention text', async () => {
    const runner = createRunner({
      chunks: Array.from({ length: 5 }, (_, index) => ({
        chunk_id: `chunk_${index}`,
        chunk_text: 'Acme Corp renewed.',
        document_id: `doc_${index}`,
        document_version_id: `doc_${index}@v1`,
      })),
      candidates: [candidate({ entity_id: 'cust_acme', canonical_name: 'Acme Corp', sim: 0.99 })],
    });
    mocks.runnerHandle = runner;

    const result = await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallback: 'compromise',
      fallbackExtractor: fallbackSpan(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.count).toBe(5);
    expect(result.chunks_processed).toBe(5);
    expect(result.by_resolution_method).toEqual({ exact_match: 5 });
    expect(runner.candidateQueries()).toBe(1);
    expect(runner.inserts.join('\n')).toContain('__document_mentions');
  });

  it('returns a dry-run plan without requiring a runner', async () => {
    const result = await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.spec_count).toBe(1);
    expect(result.specs[0]?.name).toBe('Customer_mentions');
  });

  it('rejects invalid concurrency and batch size before scheduling work', async () => {
    await expect(
      extractMentionsProject({
        cwd: tmpDir,
        entity: 'Customer',
        schema: 'entity_graph',
        dryRun: true,
        concurrency: 0,
      })
    ).rejects.toThrow('--concurrency must be a positive integer');

    await expect(
      extractMentionsProject({
        cwd: tmpDir,
        entity: 'Customer',
        schema: 'entity_graph',
        dryRun: true,
        batchSize: 0,
      })
    ).rejects.toThrow('--batch-size must be a positive integer');
  });

  it('wraps primary LLM calls with the rate limiter', async () => {
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_1',
          chunk_text: 'Acme Corp renewed.',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
        },
        {
          chunk_id: 'chunk_2',
          chunk_text: 'Acme Corp expanded.',
          document_id: 'doc_2',
          document_version_id: 'doc_2@v1',
        },
      ],
      candidates: [candidate({ entity_id: 'cust_acme', canonical_name: 'Acme Corp', sim: 0.8 })],
    });
    mocks.runnerHandle = runner;
    const consume = vi.fn();

    const result = await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallbackExtractor: fallbackSpan(),
      rateLimiter: { consume },
      llmCall: vi.fn(async () => ({
        ok: true,
        value: { resolved_entity_id: 'cust_acme', confidence: 0.9 },
        tokenUsage: 10,
        costUsd: 0.002,
      })),
    });

    expect(result.by_resolution_method).toEqual({ llm_disambiguation: 2 });
    expect(result.budget_used).toBe(0.004);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('honors concurrency=1 for LLM calls', async () => {
    const runner = createRunner({
      chunks: Array.from({ length: 3 }, (_, index) => ({
        chunk_id: `chunk_${index}`,
        chunk_text: 'Acme Corp renewed.',
        document_id: `doc_${index}`,
        document_version_id: `doc_${index}@v1`,
      })),
      candidates: [candidate({ entity_id: 'cust_acme', canonical_name: 'Acme Corp', sim: 0.8 })],
    });
    mocks.runnerHandle = runner;
    let active = 0;
    let maxActive = 0;

    await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      concurrency: 1,
      fallbackExtractor: fallbackSpan(),
      llmCall: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
          ok: true,
          value: { resolved_entity_id: 'cust_acme', confidence: 0.9 },
          tokenUsage: 10,
          costUsd: 0,
        };
      },
    });

    expect(maxActive).toBe(1);
  });

  it('degrades remaining chunks to compromise fallback after budget exhaustion', async () => {
    const runner = createRunner({
      chunks: Array.from({ length: 3 }, (_, index) => ({
        chunk_id: `chunk_${index}`,
        chunk_text: 'Acme Corp renewed.',
        document_id: `doc_${index}`,
        document_version_id: `doc_${index}@v1`,
      })),
      candidates: [candidate({ entity_id: 'cust_acme', canonical_name: 'Acme Corp', sim: 0.8 })],
    });
    mocks.runnerHandle = runner;
    let calls = 0;

    const result = await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      concurrency: 1,
      fallbackExtractor: fallbackSpan(),
      llmCall: async () => {
        calls += 1;
        return {
          ok: false,
          error: 'budget_exceeded',
          message: 'budget exhausted',
          attempts: 1,
        };
      },
    });

    expect(calls).toBe(1);
    expect(result.by_resolution_method).toEqual({ unresolved: 1, compromise_ner: 2 });
  });

  it('threads customRunners through to the runner resolver', async () => {
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_0',
          chunk_text: 'Acme Corp renewed.',
          document_id: 'doc_0',
          document_version_id: 'doc_0@v1',
        },
      ],
      candidates: [candidate({ entity_id: 'cust_acme', canonical_name: 'Acme Corp', sim: 0.99 })],
    });
    mocks.runnerHandle = runner;
    const customRunners = new CustomRunnerRegistry();

    await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallback: 'compromise',
      fallbackExtractor: fallbackSpan(),
      customRunners,
    });

    expect(vi.mocked(resolveEntityGraphRunner)).toHaveBeenCalledWith(
      expect.objectContaining({ customRunners })
    );
  });

  it('omits customRunners from the runner resolver call when unset', async () => {
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_0',
          chunk_text: 'Acme Corp renewed.',
          document_id: 'doc_0',
          document_version_id: 'doc_0@v1',
        },
      ],
      candidates: [candidate({ entity_id: 'cust_acme', canonical_name: 'Acme Corp', sim: 0.99 })],
    });
    mocks.runnerHandle = runner;

    await extractMentionsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallback: 'compromise',
      fallbackExtractor: fallbackSpan(),
    });

    const lastCall = vi.mocked(resolveEntityGraphRunner).mock.calls.at(-1)?.[0];
    expect(lastCall).toBeDefined();
    expect(lastCall).not.toHaveProperty('customRunners');
  });
});
