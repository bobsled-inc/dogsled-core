import { describe, it, expect, vi } from 'vitest';
import { CommandError } from '@bobsled-inc/protocol';

import {
  createCandidateRetrieval,
  type CandidateRetrievalQuery,
} from '../../src/runtime/candidate-retrieval/registry.js';
import type { CandidateRetrievalRow } from '../../src/runtime/candidate-retrieval/interface.js';

function row(input: {
  entity_id: string;
  entity_type?: string;
  canonical_name: string;
  sim: number;
  matched_text?: string;
  match_source?: string;
  profile_attrs?: string | null;
}): CandidateRetrievalRow {
  return {
    entity_type: input.entity_type ?? 'Customer',
    matched_text: input.matched_text ?? input.canonical_name,
    match_source: input.match_source ?? 'canonical_name',
    profile_attrs: input.profile_attrs ?? null,
    ...input,
  };
}

function fakeRunner(rows: readonly CandidateRetrievalRow[]): CandidateRetrievalQuery {
  return { query: vi.fn().mockResolvedValue(rows) };
}

describe('createCandidateRetrieval', () => {
  it('returns a DuckDB strategy when dialect is duckdb', async () => {
    const strat = createCandidateRetrieval({
      dialect: 'duckdb',
      profileTable: 'eg.profile',
      runner: fakeRunner([row({ entity_id: 'e1', canonical_name: 'Acme', sim: 0.97 })]),
    });
    expect(strat.dialect).toBe('duckdb');
    const out = await strat.retrieve({ mention_text: 'Acme', k: 5, min_sim: 0.6 });
    expect(out).toEqual([row({ entity_id: 'e1', canonical_name: 'Acme', sim: 0.97 })]);
  });

  it('returns a Postgres strategy that runs the pg_trgm SQL', async () => {
    const runner = fakeRunner([row({ entity_id: 'p1', canonical_name: 'Aperture', sim: 0.71 })]);
    const strat = createCandidateRetrieval({
      dialect: 'postgres',
      profileTable: 'eg.profile',
      runner,
    });
    const out = await strat.retrieve({ mention_text: 'Aperture', k: 10, min_sim: 0.55 });
    expect(strat.dialect).toBe('postgres');
    expect(out[0]?.entity_id).toBe('p1');
    const calls = (runner.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toContain('similarity');
    expect(calls[0]?.[0]).toContain('LIMIT $3');
  });

  it('passes entity type filters into generated SQL', async () => {
    const runner = fakeRunner([]);
    const strat = createCandidateRetrieval({
      dialect: 'duckdb',
      profileTable: 'eg.profile',
      runner,
    });
    await strat.retrieve({
      mention_text: 'MCP',
      k: 10,
      min_sim: 0.55,
      entity_types: ['Product'],
    });
    const calls = (runner.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toContain("p.entity_type IN ('Product')");
  });

  it('returns a Snowflake strategy that normalizes JAROWINKLER_SIMILARITY to 0–1', async () => {
    const runner = fakeRunner([]);
    const strat = createCandidateRetrieval({
      dialect: 'snowflake',
      profileTable: 'eg.profile',
      runner,
    });
    expect(strat.dialect).toBe('snowflake');
    await strat.retrieve({ mention_text: 'Acme', k: 10, min_sim: 0.6 });
    const calls = (runner.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toContain('JAROWINKLER_SIMILARITY');
    expect(calls[0]?.[0]).toContain('/ 100.0');
  });

  it('returns a BigQuery strategy when shinglesTable is provided', async () => {
    const runner = fakeRunner([]);
    const strat = createCandidateRetrieval({
      dialect: 'bigquery',
      profileTable: 'eg.profile',
      shinglesTable: 'eg.profile_shingles',
      runner,
    });
    expect(strat.dialect).toBe('bigquery');
    await strat.retrieve({ mention_text: 'Acme', k: 10, min_sim: 0.6 });
    const calls = (runner.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toContain('ML.NGRAMS');
    expect(calls[0]?.[0]).toContain('eg.profile_shingles');
  });

  it('throws CommandError(2) when BigQuery shinglesTable is missing', () => {
    expect.assertions(3);
    try {
      createCandidateRetrieval({
        dialect: 'bigquery',
        profileTable: 'eg.profile',
        runner: fakeRunner([]),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      if (!(error instanceof CommandError)) throw error;
      expect(error.exitCode).toBe(2);
      expect(error.message).toMatch(/requires a shinglesTable/);
    }
  });
});
