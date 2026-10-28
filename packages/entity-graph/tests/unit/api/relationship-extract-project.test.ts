import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';

import { extractRelationshipsProject } from '../../../src/api/relationship-extract-project.js';
import {
  resolveEntityGraphRunner,
  type EntityGraphRunnerHandle,
} from '../../../src/runtime/runner-resolver.js';

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
  for (const entity of ['Customer', 'Deal']) {
    writeFileSync(
      path.join(tmpDir, `mdm/${entity}_resolution.yml`),
      [
        `spec_version: '0.2'`,
        `name: ${entity}`,
        `type: resolution`,
        `description: Resolve ${entity}.`,
        `entity_semantics:`,
        `  definition: ${entity} business definition.`,
        `  positive_examples: ["${entity} appears in relationship evidence."]`,
        `  negative_examples: ["Not a ${entity}."]`,
        `inputs:`,
        `  - ref: raw.${entity.toLowerCase()}`,
        `    id_fields: [id]`,
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
  }
  writeFileSync(
    path.join(tmpDir, 'mdm/relationship_ontology.yml'),
    [
      `spec_version: '0.2'`,
      `type: relationship_ontology`,
      `name: default_relationships`,
      `relations:`,
      `  - relation_type: customer_has_deal`,
      `    description: A customer is associated with a deal.`,
      `    left_entity: Customer`,
      `    right_entity: Deal`,
      `    direction: directed`,
      `    cardinality: one_to_many`,
      `    aliases: []`,
      `    exclusive_with: []`,
      `    temporal: stateful`,
      `    review_thresholds:`,
      `      auto_confirm: 0.92`,
      `      review: 0.55`,
      `      auto_reject: 0.3`,
      `  - relation_type: document_mentions_customer`,
      `    description: A document mentions a customer.`,
      `    left_entity: Document`,
      `    right_entity: Customer`,
      `    direction: directed`,
      `    cardinality: many_to_many`,
      `    aliases: []`,
      `    exclusive_with: []`,
      `    temporal: event`,
      `    review_thresholds:`,
      `      auto_confirm: 0.92`,
      `      review: 0.55`,
      `      auto_reject: 0.3`,
    ].join('\n'),
    'utf-8'
  );
  writeFileSync(
    path.join(tmpDir, 'mdm/Customer_relationship_extraction.yml'),
    [
      `spec_version: '0.2'`,
      `type: relationship_extraction`,
      `name: Customer_relationships`,
      `ontology_ref: default_relationships`,
      `chunk_filter:`,
      `  has_resolved_mentions_min: 2`,
      `candidate_pair_rules:`,
      `  max_pairs_per_chunk: 8`,
      `  same_chunk_only: true`,
      `extraction:`,
      `  role: relationship_extraction_v1`,
      `  prompt_version: v1`,
      `  constrained_decoding: true`,
      `  require_span_evidence: true`,
      `review:`,
      `  use_ontology_thresholds: true`,
    ].join('\n'),
    'utf-8'
  );
}

function createRunner(options: {
  chunks: Array<Record<string, unknown>>;
  mentions: Array<Record<string, unknown>>;
}): EntityGraphRunnerHandle & { inserts: string[]; queries: string[] } {
  const inserts: string[] = [];
  const queries: string[] = [];
  const runner = {
    async run(sql: string) {
      inserts.push(sql);
      return { rowCount: 1 };
    },
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('__chunks')) return options.chunks;
      if (sql.includes('__document_mentions')) return options.mentions;
      return [];
    },
  };
  return {
    runner,
    source: 'runner_path',
    close: vi.fn(async () => undefined),
    inserts,
    queries,
  };
}

describe('extractRelationshipsProject', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'eg-relationship-project-'));
    mocks.runnerHandle = undefined;
    writeProject();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads committed mentions, calls the relationship runtime, and writes evidence', async () => {
    const chunkText = 'Acme Corp signed Project Atlas.';
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_1',
          chunk_text: chunkText,
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
        },
      ],
      mentions: [
        {
          mention_id: 'm_customer',
          chunk_id: 'chunk_1',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
          entity_type: 'Customer',
          entity_name: 'Acme Corp',
          resolved_entity_id: 'cust_acme',
          confidence: 0.9,
          resolution_confidence: 0.99,
          span_start: 0,
          span_end: 9,
        },
        {
          mention_id: 'm_deal',
          chunk_id: 'chunk_1',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
          entity_type: 'Deal',
          entity_name: 'Project Atlas',
          resolved_entity_id: 'deal_atlas',
          confidence: 0.9,
          resolution_confidence: 0.99,
          span_start: 17,
          span_end: 30,
        },
      ],
    });
    mocks.runnerHandle = runner;

    const result = await extractRelationshipsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      llmCall: async (prompt) => {
        expect(prompt.user).toContain('<entity_definitions>');
        expect(prompt.user).toContain('<definition>Customer business definition.</definition>');
        expect(prompt.user).toContain('<definition>Deal business definition.</definition>');
        return {
          ok: true,
          model_id: 'test-model',
          value: {
            extractions: [
              {
                relation_type: 'customer_has_deal',
                left_entity_id: 'cust_acme',
                right_entity_id: 'deal_atlas',
                span_start: 0,
                span_end: chunkText.length,
                evidence_excerpt: chunkText,
                confidence: 0.91,
              },
            ],
          },
        };
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.count).toBe(1);
    expect(result.by_resolution_method).toEqual({ llm_extraction: 1 });
    expect(result.chunks_processed).toBe(1);
    expect(result.diagnostics).toMatchObject({
      candidate_pairs_considered: 1,
      llm_calls: 1,
      accepted_relationships: 1,
      inserted_relationships: 1,
    });
    expect(runner.inserts.join('\n')).toContain('__entity_relationship_evidence');
    expect(runner.queries.join('\n')).toContain('p.entity_type = m.entity_type');
    expect(runner.queries.join('\n')).toContain(
      "m.resolution_method IN ('exact_match', 'llm_disambiguation')"
    );
  });

  it('writes document mention-link evidence in fallback mode without an LLM', async () => {
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_1',
          chunk_text: 'Acme Corp renewed.',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
        },
      ],
      mentions: [
        {
          mention_id: 'm_customer',
          chunk_id: 'chunk_1',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
          entity_type: 'Customer',
          entity_name: 'Acme Corp',
          resolved_entity_id: 'cust_acme',
          confidence: 0.9,
          resolution_confidence: 0.99,
          span_start: 0,
          span_end: 9,
        },
      ],
    });
    mocks.runnerHandle = runner;

    const result = await extractRelationshipsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallback: 'compromise',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.count).toBe(1);
    expect(result.by_resolution_method).toEqual({ mention_link: 1 });
    expect(result.diagnostics).toMatchObject({ inserted_relationships: 1 });
    expect(runner.inserts.join('\n')).toContain('document_mentions_customer');
  });

  it('threads customRunners through to the runner resolver', async () => {
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_1',
          chunk_text: 'Acme Corp renewed.',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
        },
      ],
      mentions: [
        {
          mention_id: 'm_customer',
          chunk_id: 'chunk_1',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
          entity_type: 'Customer',
          entity_name: 'Acme Corp',
          resolved_entity_id: 'cust_acme',
          confidence: 0.9,
          resolution_confidence: 0.99,
          span_start: 0,
          span_end: 9,
        },
      ],
    });
    mocks.runnerHandle = runner;
    const customRunners = new CustomRunnerRegistry();

    await extractRelationshipsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallback: 'compromise',
      customRunners,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(vi.mocked(resolveEntityGraphRunner)).toHaveBeenCalledWith(
      expect.objectContaining({ customRunners })
    );
  });

  it('omits customRunners from the runner resolver call when unset', async () => {
    const runner = createRunner({
      chunks: [
        {
          chunk_id: 'chunk_1',
          chunk_text: 'Acme Corp renewed.',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
        },
      ],
      mentions: [
        {
          mention_id: 'm_customer',
          chunk_id: 'chunk_1',
          document_id: 'doc_1',
          document_version_id: 'doc_1@v1',
          entity_type: 'Customer',
          entity_name: 'Acme Corp',
          resolved_entity_id: 'cust_acme',
          confidence: 0.9,
          resolution_confidence: 0.99,
          span_start: 0,
          span_end: 9,
        },
      ],
    });
    mocks.runnerHandle = runner;

    await extractRelationshipsProject({
      cwd: tmpDir,
      entity: 'Customer',
      schema: 'entity_graph',
      fallback: 'compromise',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const lastCall = vi.mocked(resolveEntityGraphRunner).mock.calls.at(-1)?.[0];
    expect(lastCall).toBeDefined();
    expect(lastCall).not.toHaveProperty('customRunners');
  });
});
