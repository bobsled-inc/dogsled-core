import { describe, it, expect, vi } from 'vitest';

import { extractChunk } from '../../src/runtime/mention/extract-chunk.js';
import type { MentionExtractionDiagnostics } from '../../src/runtime/mention/extract-chunk.js';
import type { ProfileAliasCandidate } from '../../src/runtime/mention/profile-alias.js';
import type { CompromiseFallback } from '../../src/runtime/mention/compromise-fallback.js';
import type {
  Candidate,
  CandidateRetrievalStrategy,
} from '../../src/runtime/candidate-retrieval/interface.js';

function fakeFallback(
  spans: Array<{ name: string; type: 'company' | 'person'; start: number; end: number }>
): CompromiseFallback {
  return {
    extract: vi.fn().mockResolvedValue(
      spans.map((s) => ({
        entity_type: s.type,
        entity_name: s.name,
        span_start: s.start,
        span_end: s.end,
        source_confidence: s.type === 'person' ? 0.7 : 0.55,
      }))
    ),
  };
}

function candidate(input: {
  entity_id: string;
  canonical_name: string;
  sim: number;
  entity_type?: string;
}): Candidate {
  return {
    entity_type: input.entity_type ?? 'company',
    matched_text: input.canonical_name,
    match_source: 'canonical_name',
    profile_attrs: null,
    ...input,
  };
}

function fakeStrategy(rows: Candidate[]): CandidateRetrievalStrategy {
  return {
    dialect: 'duckdb',
    retrieve: vi.fn().mockResolvedValue(rows),
  };
}

function diagnostics(): MentionExtractionDiagnostics {
  return {
    surface_proposer_failures: {},
    fallback_none_chunks: 0,
    dropped_generic_spans: 0,
    dropped_surface_spans: {},
    profile_alias_matches: 0,
  };
}

describe('extractChunk fallback mode (compromise NER without LLM)', () => {
  it('emits compromise_ner rows when no exact-match candidate', async () => {
    const fallback = fakeFallback([{ name: 'Acme Corp', type: 'company', start: 0, end: 9 }]);
    const strategy = fakeStrategy([
      candidate({ entity_id: 'e1', canonical_name: 'Acme', sim: 0.6 }),
    ]);
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme Corp announced',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'mention.extract.role',
        mode: 'fallback',
      }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolution_method).toBe('compromise_ner');
    expect(rows[0]?.resolved_entity_id).toBeNull();
    expect(rows[0]?.resolution_confidence).toBe(0.55); // source_confidence for 'company'
    expect(rows[0]?.notes?.review_route).toBe('agent_review');
  });

  it('promotes to exact_match when top candidate sim > 0.95 (no LLM call)', async () => {
    const fallback = fakeFallback([{ name: 'Acme Corp', type: 'company', start: 0, end: 9 }]);
    const strategy = fakeStrategy([
      candidate({ entity_id: 'e1', canonical_name: 'Acme Corp', sim: 0.99 }),
    ]);
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme Corp announced',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'mention.extract.role',
        mode: 'fallback',
      }
    );
    expect(rows[0]?.resolution_method).toBe('exact_match');
    expect(rows[0]?.resolved_entity_id).toBe('e1');
    expect(rows[0]?.resolution_confidence).toBeCloseTo(0.99);
    expect(rows[0]?.notes?.review_route).toBe('agent_applied');
  });

  it('emits an empty array when fallback finds no spans', async () => {
    const fallback = fakeFallback([]);
    const strategy = fakeStrategy([]);
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'no entities here',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
      }
    );
    expect(rows).toEqual([]);
  });

  it('can restrict spans to ontology-referenced entity types', async () => {
    const fallback = fakeFallback([
      { name: 'Acme', type: 'company', start: 0, end: 4 },
      { name: 'Alice', type: 'person', start: 9, end: 14 },
    ]);
    const strategy = fakeStrategy([]);
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme met Alice',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
        allowedEntityTypes: ['company'],
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_type).toBe('company');
  });

  it('does not exact-match fallback candidates outside allowed entity types', async () => {
    const fallback = fakeFallback([{ name: 'MCP', type: 'company', start: 0, end: 3 }]);
    const strategy = fakeStrategy([
      candidate({ entity_id: 'product-1', canonical_name: 'MCP', sim: 1, entity_type: 'Product' }),
    ]);
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'MCP',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
        allowedEntityTypes: ['Customer'],
        candidateLedEntityType: true,
      }
    );

    expect(rows).toEqual([]);
  });

  it('drops unresolved generic fallback rows in multi-entity extraction', async () => {
    const fallback = fakeFallback([
      { name: 'Cloud Run service', type: 'company', start: 0, end: 17 },
    ]);
    const strategy = fakeStrategy([]);
    const diag = diagnostics();
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Cloud Run service',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
        fallbackMode: 'compromise',
        allowedEntityTypes: ['Customer', 'Engineer'],
        candidateLedEntityType: true,
        diagnostics: diag,
      }
    );

    expect(rows).toEqual([]);
    expect(diag.dropped_generic_spans).toBe(1);
  });

  it('still promotes generic fallback spans when an allowed exact candidate exists', async () => {
    const fallback = fakeFallback([{ name: 'Acme', type: 'company', start: 0, end: 4 }]);
    const strategy = fakeStrategy([
      candidate({
        entity_id: 'cust_acme',
        canonical_name: 'Acme',
        sim: 1,
        entity_type: 'Customer',
      }),
    ]);
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
        fallbackMode: 'compromise',
        allowedEntityTypes: ['Customer', 'Engineer'],
        candidateLedEntityType: true,
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_type).toBe('Customer');
    expect(rows[0]?.resolution_method).toBe('exact_match');
    expect(rows[0]?.resolved_entity_id).toBe('cust_acme');
  });

  it('honors fallback none when the surface proposer fails', async () => {
    const fallback = fakeFallback([{ name: 'Acme', type: 'company', start: 0, end: 4 }]);
    const diag = diagnostics();
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy: fakeStrategy([]),
        fallback,
        extractionRole: 'role',
        mode: 'primary',
        fallbackMode: 'none',
        surfaceProposer: vi.fn().mockResolvedValue({
          ok: false,
          error: 'provider_error',
          message: 'down',
          attempts: 1,
        }),
        llmCall: vi.fn().mockResolvedValue({
          ok: true,
          value: { resolved_entity_id: 'UNRESOLVED', confidence: 0 },
          tokenUsage: 0,
          costUsd: 0,
        }),
        diagnostics: diag,
      }
    );

    expect(rows).toEqual([]);
    expect(fallback.extract).not.toHaveBeenCalled();
    expect(diag.surface_proposer_failures.provider_error).toBe(1);
    expect(diag.fallback_none_chunks).toBe(1);
  });

  it('applies default markdown surface hygiene before fallback insertion', async () => {
    const fallback = fakeFallback([
      { name: 'Cloud Run service', type: 'company', start: 2, end: 19 },
    ]);
    const diag = diagnostics();
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: '# Cloud Run service\nDetails',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy: fakeStrategy([]),
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
        diagnostics: diag,
      }
    );

    expect(rows).toEqual([]);
    expect(diag.dropped_surface_spans.markdown_heading).toBe(1);
  });

  it('applies configured surface filters before fallback insertion', async () => {
    const fallback = fakeFallback([{ name: 'User & Group', type: 'company', start: 0, end: 12 }]);
    const diag = diagnostics();
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'User & Group',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy: fakeStrategy([]),
        fallback,
        extractionRole: 'role',
        mode: 'fallback',
        surfaceFilters: { stopwords: ['user & group'] },
        diagnostics: diag,
      }
    );

    expect(rows).toEqual([]);
    expect(diag.dropped_surface_spans.stopword).toBe(1);
  });

  it('promotes profile aliases before LLM proposal or compromise fallback', async () => {
    const fallback = fakeFallback([]);
    const aliases: ProfileAliasCandidate[] = [
      {
        entity_id: 'cust_acme',
        entity_type: 'Customer',
        canonical_name: 'Acme Corporation',
        aliases: ['Acme'],
      },
    ];
    const diag = diagnostics();
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme renewed.',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy: fakeStrategy([]),
        fallback,
        extractionRole: 'role',
        mode: 'primary',
        fallbackMode: 'none',
        allowedEntityTypes: ['Customer'],
        profileAliasCandidates: aliases,
        diagnostics: diag,
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolution_method).toBe('exact_match');
    expect(rows[0]?.resolved_entity_id).toBe('cust_acme');
    expect(rows[0]?.notes?.proposal_source).toBe('profile_alias');
    expect(diag.profile_alias_matches).toBe(1);
  });

  it('fallback mode degrades to compromise_ner when retrieve() throws (best-effort)', async () => {
    const fallback = fakeFallback([{ name: 'Acme', type: 'company', start: 0, end: 4 }]);
    const strategy: CandidateRetrievalStrategy = {
      dialect: 'duckdb',
      retrieve: vi.fn().mockRejectedValue(new Error('warehouse down')),
    };
    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme rocks',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'mention.extract.role',
        mode: 'fallback',
      }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolution_method).toBe('compromise_ner');
    expect(rows[0]?.resolved_entity_id).toBeNull();
    expect(rows[0]?.notes?.review_route).toBe('agent_review');
  });

  it('primary mode requires llmCall — throws when omitted', async () => {
    const fallback = fakeFallback([{ name: 'Acme', type: 'company', start: 0, end: 4 }]);
    const strategy = fakeStrategy([]);
    await expect(
      extractChunk(
        {
          chunk_id: 'c1',
          chunk_text: 'Acme',
          document_id: 'd1',
          document_version_id: 'd1@v1',
        },
        {
          strategy,
          fallback,
          extractionRole: 'r',
          mode: 'primary',
        }
      )
    ).rejects.toThrow(/requires options\.llmCall/);
  });

  it('primary mode serializes mention lookups within a chunk', async () => {
    const fallback = fakeFallback([
      { name: 'Acme', type: 'company', start: 0, end: 4 },
      { name: 'Globex', type: 'company', start: 9, end: 15 },
    ]);
    let active = 0;
    let maxActive = 0;
    const strategy: CandidateRetrievalStrategy = {
      dialect: 'duckdb',
      retrieve: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return [candidate({ entity_id: 'e1', canonical_name: 'Acme Corp', sim: 0.6 })];
      }),
    };

    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme met Globex',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'mention.extract.role',
        mode: 'primary',
        llmCall: vi.fn().mockResolvedValue({
          ok: true,
          value: { resolved_entity_id: 'UNRESOLVED', confidence: 0 },
          tokenUsage: 0,
          costUsd: 0,
        }),
      }
    );

    expect(rows).toHaveLength(2);
    expect(maxActive).toBe(1);
  });

  it('uses proposed surfaces and skips compromise when proposer succeeds', async () => {
    const fallback = fakeFallback([{ name: 'Fallback Corp', type: 'company', start: 0, end: 13 }]);
    const strategy = fakeStrategy([
      candidate({ entity_id: 'e1', canonical_name: 'Acme Corp', sim: 0.99 }),
    ]);

    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme Corp announced',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'mention.extract.role',
        mode: 'primary',
        allowedEntityTypes: ['company'],
        surfaceProposer: vi.fn().mockResolvedValue({
          ok: true,
          tokenUsage: 10,
          costUsd: 0.01,
          surfaces: [
            {
              surface_text: 'Acme Corp',
              entity_type: 'company',
              span_start: 0,
              span_end: 9,
              source_confidence: 0.92,
            },
          ],
        }),
        llmCall: vi.fn().mockResolvedValue({
          ok: true,
          value: { resolved_entity_id: 'UNRESOLVED', confidence: 0 },
          tokenUsage: 0,
          costUsd: 0,
        }),
      }
    );

    expect(fallback.extract).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_name).toBe('Acme Corp');
    expect(rows[0]?.resolution_method).toBe('exact_match');
    expect(rows[0]?.notes?.proposal_source).toBe('llm');
  });

  it('falls back to compromise spans and records proposal failure when proposer fails', async () => {
    const fallback = fakeFallback([{ name: 'Acme Corp', type: 'company', start: 0, end: 9 }]);
    const strategy = fakeStrategy([
      candidate({ entity_id: 'e1', canonical_name: 'Acme Corp', sim: 0.99 }),
    ]);

    const rows = await extractChunk(
      {
        chunk_id: 'c1',
        chunk_text: 'Acme Corp announced',
        document_id: 'd1',
        document_version_id: 'd1@v1',
      },
      {
        strategy,
        fallback,
        extractionRole: 'mention.extract.role',
        mode: 'primary',
        allowedEntityTypes: ['company'],
        surfaceProposer: vi.fn().mockResolvedValue({
          ok: false,
          error: 'schema_violation',
          message: 'bad type',
          attempts: 1,
        }),
        llmCall: vi.fn().mockResolvedValue({
          ok: true,
          value: { resolved_entity_id: 'UNRESOLVED', confidence: 0 },
          tokenUsage: 0,
          costUsd: 0,
        }),
      }
    );

    expect(fallback.extract).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notes?.proposal_source).toBe('compromise');
    expect(rows[0]?.notes?.proposal_failure).toBe('schema_violation');
  });
});
