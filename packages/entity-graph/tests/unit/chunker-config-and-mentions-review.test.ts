import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import YAML from 'yaml';

import { CommandError } from '@bobsled-inc/protocol';

import {
  buildSupersedeOrphansSql,
  ChunkerConfigChangePayloadSchema,
  createChunkerConfigChangeHandler,
} from '../../src/runtime/mention/chunker-config-change.js';
import {
  buildMentionsReviewExportQuery,
  rowsToCsv,
  runMentionsReviewExport,
  type MentionsReviewExportRow,
} from '../../src/commands/mentions-review-export.js';
import { registerMentionsCommand } from '../../src/commands/mentions.js';

describe('chunker-config-change handler', () => {
  it('schema requires reason discriminator and table identifiers', () => {
    expect(
      ChunkerConfigChangePayloadSchema.safeParse({
        reason: 'chunker_config_changed',
        old_chunks_table: 'a.old',
        new_chunks_table: 'a.new',
        mentions_table: 'a.m',
      }).success
    ).toBe(true);

    expect(
      ChunkerConfigChangePayloadSchema.safeParse({
        reason: 'something_else',
        old_chunks_table: 'a',
        new_chunks_table: 'b',
        mentions_table: 'c',
      }).success
    ).toBe(false);
  });

  it('builds the supersede-orphans UPDATE with safe identifiers only', () => {
    const sql = buildSupersedeOrphansSql({
      reason: 'chunker_config_changed',
      old_chunks_table: 'eg.old_chunks',
      new_chunks_table: 'eg.new_chunks',
      mentions_table: 'eg.mentions',
    });
    expect(sql).toContain('UPDATE eg.mentions');
    expect(sql).toContain('superseded_at = CURRENT_TIMESTAMP');
    expect(sql).toContain('chunk_id NOT IN (SELECT chunk_id FROM eg.new_chunks)');
  });

  it('rejects unsafe table identifiers', () => {
    expect(() =>
      buildSupersedeOrphansSql({
        reason: 'chunker_config_changed',
        old_chunks_table: 'a',
        new_chunks_table: 'b',
        mentions_table: 'eg.m; DROP TABLE x; --',
      })
    ).toThrow(/Invalid SQL identifier/);
  });

  it('handler executes the SQL via the injected runner', async () => {
    let executed = '';
    const handler = createChunkerConfigChangeHandler({
      exec: async (sql) => {
        executed = sql;
        return { rowCount: 7 };
      },
    });
    const count = await handler({
      task: {
        task_id: 't1',
        task_type: 'mention_resolution',
        resource_name: 'r',
        payload: {
          reason: 'chunker_config_changed',
          old_chunks_table: 'eg.old',
          new_chunks_table: 'eg.new',
          mentions_table: 'eg.m',
        },
        state: 'claimed',
        priority: 0,
        scheduled_at: '2026-05-07T00:00:00Z',
        claimed_by: 'w',
        claimed_at: '2026-05-07T00:00:00Z',
        claim_expires_at: '2026-05-07T00:05:00Z',
        attempts: 1,
        max_attempts: 5,
        last_error: null,
        created_at: '2026-05-07T00:00:00Z',
        completed_at: null,
      },
      deadline: new Date('2026-05-07T00:05:00Z'),
    });
    expect(executed).toContain('UPDATE eg.m');
    expect(count).toBe(7);
  });
});

describe('mentions review export', () => {
  const fixture: MentionsReviewExportRow[] = [
    {
      review_id: 'r1',
      decision: 'agent_review',
      confidence: 0.78,
      mention_id: 'm1',
      chunk_id: 'c1',
      document_id: 'd1',
      entity_type: 'company',
      entity_name: 'Acme',
      resolved_entity_id: 'e1',
      resolution_method: 'llm_disambiguation',
      notes: { injection_markers: [] },
    },
  ];

  it('rowsToCsv emits the model-review-envelope header followed by mention columns', () => {
    const csv = rowsToCsv(fixture);
    expect(csv.split('\n')[0]).toBe(
      'review_id,decision,confidence,mention_id,chunk_id,document_id,entity_type,entity_name,resolved_entity_id,resolution_method,notes'
    );
    expect(csv).toContain('r1,agent_review,0.78,m1');
  });

  it('handles empty rows by emitting header-only output', () => {
    const csv = rowsToCsv([]);
    expect(csv).toBe(
      'review_id,decision,confidence,mention_id,chunk_id,document_id,entity_type,entity_name,resolved_entity_id,resolution_method,notes\n'
    );
  });

  it('runMentionsReviewExport CSV path calls fetcher and writes header + rows', async () => {
    let buf = '';
    const rows = await runMentionsReviewExport('csv', {
      write: (s) => {
        buf += s;
      },
      fetcher: async () => fixture,
    });
    expect(rows).toEqual(fixture);
    expect(buf).toContain('review_id,decision');
  });

  it('runMentionsReviewExport JSON path emits structured envelope', async () => {
    let buf = '';
    await runMentionsReviewExport('json', {
      write: (s) => {
        buf += s;
      },
      fetcher: async () => fixture,
    });
    const parsed = JSON.parse(buf);
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].mention_id).toBe('m1');
  });

  it('runMentionsReviewExport quiet mode suppresses success output', async () => {
    let buf = '';
    const rows = await runMentionsReviewExport('json', {
      write: (s) => {
        buf += s;
      },
      fetcher: async () => fixture,
      quiet: true,
    });
    expect(rows).toEqual(fixture);
    expect(buf).toBe('');
  });

  it('builds a runner-backed review query with the default mentions table', () => {
    const sql = buildMentionsReviewExportQuery({ limit: 25 });
    expect(sql).toContain('FROM entity_graph.__document_mentions');
    expect(sql).toContain('WHERE superseded_at IS NULL\nAND (');
    expect(sql).toContain('resolved_entity_id IS NULL');
    expect(sql).toContain(
      "resolution_method IN ('compromise_ner', 'schema_violation', 'unresolved')"
    );
    expect(sql).toContain('LIMIT 25');
  });

  it('rejects unsafe mentions table identifiers', () => {
    expect(() =>
      buildMentionsReviewExportQuery({ table: 'entity_graph.__document_mentions; DROP TABLE x' })
    ).toThrow(/Invalid SQL identifier/);
  });

  it('registers bobsled entity-graph mentions review export', async () => {
    let buf = '';
    const program = new Command();
    program.exitOverride();
    registerMentionsCommand(program, {
      writer: { out: (s) => (buf += s), err: (s) => (buf += s) },
      fetcher: async () => fixture,
    });

    await program.parseAsync(['node', 'test', 'mentions', 'review', 'export', '--json']);

    const parsed = JSON.parse(buf);
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].mention_id).toBe('m1');
  });

  it('runMentionsReviewExport YAML path emits the same envelope as JSON (AGENTS.md parity)', async () => {
    let yamlBuf = '';
    let jsonBuf = '';
    await runMentionsReviewExport('json', {
      write: (s) => {
        jsonBuf += s;
      },
      fetcher: async () => fixture,
    });
    await runMentionsReviewExport('yaml', {
      write: (s) => {
        yamlBuf += s;
      },
      fetcher: async () => fixture,
    });
    expect(YAML.parse(yamlBuf)).toEqual(JSON.parse(jsonBuf));
  });

  it('rejects calls without a runner via CommandError(2)', async () => {
    const err = await runMentionsReviewExport('csv', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).exitCode).toBe(2);
    expect((err as Error).message).toMatch(/requires a runner/);
  });
});
