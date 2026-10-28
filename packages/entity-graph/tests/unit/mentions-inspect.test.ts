import { CommandError } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import { inspectMentions } from '../../src/commands/mentions-inspect.js';

const chunks = [
  {
    chunk_id: 'chunk_1',
    document_id: 'doc_1',
    document_version_id: 'doc_1@v1',
    chunk_index: 1,
    source_uri: 'https://notion.example/doc_1',
    chunk_text: 'Globex asked for Reports.',
  },
  {
    chunk_id: 'chunk_2',
    document_id: 'doc_2',
    document_version_id: 'doc_2@v1',
    chunk_index: 2,
    source_uri: 'https://notion.example/doc_2',
    chunk_text: 'An unresolved alias appears here.',
  },
] satisfies Record<string, unknown>[];

const mentions = [
  {
    mention_id: 'mention_1',
    chunk_id: 'chunk_1',
    document_id: 'doc_1',
    document_version_id: 'doc_1@v1',
    entity_type: 'Customer',
    entity_name: 'Globex',
    confidence: 0.98,
    span_start: 0,
    span_end: 6,
    resolved_entity_id: 'customer:globex',
    resolution_method: 'llm_disambiguation',
    resolution_confidence: 0.93,
    superseded_at: null,
    extraction_role: 'mention_disambiguation_v1',
  },
  {
    mention_id: 'mention_2',
    chunk_id: 'chunk_2',
    document_id: 'doc_2',
    document_version_id: 'doc_2@v1',
    entity_type: 'Product',
    entity_name: 'Unknown Product',
    confidence: 0.5,
    span_start: 3,
    span_end: 21,
    resolved_entity_id: null,
    resolution_method: 'unresolved',
    resolution_confidence: 0,
    superseded_at: null,
    extraction_role: 'mention_disambiguation_v1',
  },
] satisfies Record<string, unknown>[];

const profiles = [
  {
    entity_id: 'customer:globex',
    entity_type: 'Customer',
    canonical_name: 'Globex',
  },
  {
    entity_id: 'product:reports',
    entity_type: 'Product',
    canonical_name: 'Reports',
  },
] satisfies Record<string, unknown>[];

const evidence = [
  {
    evidence_id: 'evidence_1',
    relationship_id: 'relationship_1',
    relation_type: 'customer_uses_product',
    left_entity_id: 'customer:globex',
    right_entity_id: 'product:reports',
    evidence_kind: 'same_chunk',
    evidence_ref: 'chunk_1',
    source_chunk_id: 'chunk_1',
    evidence_excerpt: 'Globex asked for Reports',
    confidence: 0.88,
  },
] satisfies Record<string, unknown>[];

function quotedValues(sql: string): string[] {
  return [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function makeRunner() {
  return {
    async query(sql: string): Promise<Record<string, unknown>[]> {
      if (sql.includes('__document_mentions')) {
        const values = quotedValues(sql);
        return mentions.filter((row) => {
          if (sql.includes('chunk_id =')) return row.chunk_id === values[0];
          if (sql.includes('mention_id =')) return row.mention_id === values[0];
          if (sql.includes('entity_type =')) return row.entity_type === values[0];
          if (sql.includes('resolution_method =')) return row.resolution_method === values[0];
          return true;
        });
      }
      if (sql.includes('__chunks')) {
        const values = new Set(quotedValues(sql));
        return chunks.filter((row) => values.has(String(row.chunk_id)));
      }
      if (sql.includes('__entity_relationship_evidence')) {
        const values = new Set(quotedValues(sql));
        return evidence.filter((row) => values.has(String(row.source_chunk_id)));
      }
      if (sql.includes('__entity_profile')) {
        const values = new Set(quotedValues(sql));
        return profiles.filter((row) => values.has(String(row.entity_id)));
      }
      return [];
    },
  };
}

describe('mentions inspect command', () => {
  it('inspects a chunk with full chunk text and same-chunk relationship evidence', async () => {
    const result = await inspectMentions({
      queryRunner: makeRunner(),
      chunkId: 'chunk_1',
      includeChunk: true,
    });

    expect(result.summary).toEqual({ chunks: 1, mentions: 1, relationship_evidence: 1 });
    expect(result.chunks[0]).toMatchObject({
      source_uri: 'https://notion.example/doc_1',
      chunk_id: 'chunk_1',
      chunk_text: chunks[0]!.chunk_text,
    });
    expect(result.chunks[0]?.mentions[0]).toMatchObject({
      mention_id: 'mention_1',
      span_text: 'Globex',
      resolved_profile: { canonical_name: 'Globex' },
    });
    expect(result.chunks[0]?.relationship_evidence[0]).toMatchObject({
      relation_type: 'customer_uses_product',
      left_entity_name: 'Globex',
      right_entity_name: 'Reports',
    });
  });

  it('filters by mention id and preserves unresolved mention rows', async () => {
    const result = await inspectMentions({
      queryRunner: makeRunner(),
      mentionId: 'mention_2',
    });

    expect(result.summary.mentions).toBe(1);
    expect(result.chunks[0]?.mentions[0]).toMatchObject({
      mention_id: 'mention_2',
      resolution_method: 'unresolved',
      resolved_entity_id: null,
      resolved_profile: null,
    });
  });

  it('supports resolution method filters', async () => {
    const result = await inspectMentions({
      queryRunner: makeRunner(),
      resolutionMethod: 'llm_disambiguation',
    });

    expect(result.summary.mentions).toBe(1);
    expect(result.chunks[0]?.mentions[0]?.resolution_method).toBe('llm_disambiguation');
  });

  it('returns validation errors for missing explicit chunks', async () => {
    await expect(
      inspectMentions({
        queryRunner: makeRunner(),
        chunkId: 'missing_chunk',
      })
    ).rejects.toMatchObject({
      exitCode: 2,
    } satisfies Partial<CommandError>);
  });

  it('rejects unsafe schema names', async () => {
    await expect(
      inspectMentions({
        queryRunner: makeRunner(),
        schema: 'entity_graph; drop table x',
      })
    ).rejects.toThrow('--schema must be a safe SQL identifier');
  });
});
