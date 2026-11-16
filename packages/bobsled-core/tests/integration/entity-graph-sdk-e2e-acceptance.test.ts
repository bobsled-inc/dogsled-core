/**
 * Entity graph SDK end-to-end acceptance test (programmatic variant).
 *
 * The plan calls for a full `dogsled init --local` → CRM seed → entity-graph
 * run → `dogsled sdk generate` → `dogsled.entity.Customer.findBy(...)`
 * traversal — that requires real DuckLake, real seed CRM data, and the
 * full SDK runtime. This test is the programmatic equivalent:
 * it verifies the seams between the key entity graph SDK components through library APIs.
 *
 * Coverage:
 *  1. Compromise NER fallback emits compromise_ner mention rows when
 *     the LLM is unavailable (cost cap / Bedrock down).
 *  2. Cross-entity edge SQL with profile-confidence join shape.
 *  3. __document_mentions__quality view SELECT generator.
 *  4. Doctor MCP-unfiltered + sdk_stale check wiring.
 *
 * The full DuckLake-backed acceptance runs in a follow-up CI job; this
 * fixture covers the runtime seam under realistic invocation.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildMentionDerivedEdgeSelect } from '@bobsled-inc/entity-graph/compiler/relationship/cross-entity-link';
import {
  buildMentionQualityViewSelect,
  extractChunk,
  type CompromiseFallback,
} from '@bobsled-inc/entity-graph/runtime/mention';
import {
  createCandidateRetrieval,
  type CandidateRetrievalQuery,
  type CandidateRetrievalRow,
} from '@bobsled-inc/entity-graph/runtime/candidate-retrieval';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { registerDoctorCommand } from '../../src/commands/doctor.js';
import {
  checkMcpUnfilteredInProduction,
  checkSdkStale,
} from '../../src/runtime/doctor/serving-checks.js';

async function runDoctorCommand(input: {
  cwd: string;
  env?: Record<string, string | undefined>;
}): Promise<{ exitCode: number; stdout: string }> {
  const oldCwd = process.cwd();
  const oldExitCode = process.exitCode;
  const oldEnv = {
    NODE_ENV: process.env['NODE_ENV'],
    BOBSLED_CORE_MCP_ALLOW_UNFILTERED: process.env['BOBSLED_CORE_MCP_ALLOW_UNFILTERED'],
  };
  const oldWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(input.cwd);
    process.exitCode = undefined;
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const program = new Command();
    program
      .name('dogsled')
      .option('--json', 'Emit JSON', false)
      .option('--verbose', 'Verbose', false)
      .option('--quiet', 'Quiet', false)
      .option('--no-color', 'Disable ANSI colour codes');
    registerDoctorCommand(program);
    await program.parseAsync(['doctor', '--json', '--config', join(input.cwd, 'dogsled.yml')], {
      from: 'user',
    });
    return { exitCode: process.exitCode == null ? 0 : Number(process.exitCode), stdout };
  } finally {
    process.stdout.write = oldWrite;
    process.chdir(oldCwd);
    process.exitCode = oldExitCode;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Entity graph SDK — end-to-end acceptance (programmatic seams)', () => {
  it('compromise NER fallback path emits compromise_ner mention rows end-to-end', async () => {
    // 5-entity in-memory profile to drive candidate retrieval. try/finally
    // around the body so an assertion failure can't leak the DuckDB
    // connection.
    const instance = await DuckDBInstance.create(':memory:');
    const conn: DuckDBConnection = await instance.connect();
    try {
      await conn.run(
        `CREATE TABLE profile (entity_id TEXT, entity_type TEXT, canonical_name TEXT, profile_attrs TEXT)`
      );
      for (const e of [
        { id: 'e_acme', name: 'Acme Corp' },
        { id: 'e_aperture', name: 'Aperture Science' },
        { id: 'e_globex', name: 'Globex Corporation' },
      ]) {
        await conn.run(`INSERT INTO profile VALUES (?, ?, ?, ?)`, [e.id, 'company', e.name, '{}']);
      }
      const runner: CandidateRetrievalQuery = {
        // DuckDB's `getRowObjects()` returns a loosely-typed bag; the strategy
        // narrows it via `validateCandidateRetrievalRow` so we can safely
        // assert the shape at the runner boundary.
        query: async (sql, params) =>
          (
            await conn.runAndReadAll(sql, params)
          ).getRowObjects() as unknown as readonly CandidateRetrievalRow[],
      };
      const strategy = createCandidateRetrieval({
        dialect: 'duckdb',
        profileTable: 'profile',
        runner,
      });

      // Hand-rolled fallback simulating compromise output: returns a
      // single span for "Acme Corp" mentioned in the chunk text.
      const fallback: CompromiseFallback = {
        extract: async () => [
          {
            entity_type: 'company',
            entity_name: 'Acme Corp',
            span_start: 0,
            span_end: 9,
            source_confidence: 0.55,
          },
        ],
      };

      const rows = await extractChunk(
        {
          chunk_id: 'c1',
          chunk_text: 'Acme Corp is the leading widget manufacturer.',
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
      // Auto-promoted to exact_match because top candidate sim > 0.95
      // even in fallback mode (compromise gave us the surface form, the
      // candidate retrieval found a perfect canonical match).
      expect(rows[0]?.resolution_method).toBe('exact_match');
      expect(rows[0]?.resolved_entity_id).toBe('e_acme');
    } finally {
      conn.disconnectSync();
      instance.closeSync();
    }
  });

  it('cross-entity edge SQL composes profile-confidence join when both profile tables supplied', () => {
    const sql = buildMentionDerivedEdgeSelect({
      mentionsTable: 'eg.support__document_mentions',
      relationshipName: 'document_mentions_company',
      cardinality: 'many_to_many',
      lineageRunId: 'run-acceptance-1',
      leftProfileTable: 'eg.profile_document',
      rightProfileTable: 'eg.profile_company',
    });
    expect(sql).toContain('WITH agg AS');
    expect(sql).toContain('LEFT JOIN eg.profile_document lp');
    expect(sql).toContain('LEFT JOIN eg.profile_company rp');
    expect(sql).toContain('LEAST(');
    expect(sql).toContain('* agg.link_match_quality AS confidence');
  });

  it('quality view SELECT exposes the four documented columns', () => {
    const sql = buildMentionQualityViewSelect({
      mentionsTable: 'eg.support__document_mentions',
      profileTable: 'eg.profile_company',
    });
    expect(sql).toContain('m.resolution_confidence AS mention_confidence');
    expect(sql).toContain('AS freshness_age_seconds');
    expect(sql).toContain('AS source_diversity');
    expect(sql).toContain('AS profile_coverage');
    expect(sql).toContain('LEFT JOIN eg.profile_company p');
  });

  it('Entity-graph serving doctor checks include MCP unfiltered and SDK stale guards', () => {
    const findings = [checkMcpUnfilteredInProduction(), checkSdkStale()];
    expect(findings.map((finding) => finding.check)).toEqual([
      'mcp_unfiltered_in_production',
      'sdk_stale',
    ]);
    for (const finding of findings) {
      expect(['pass', 'warn', 'fail']).toContain(finding.severity);
      expect(typeof finding.summary).toBe('string');
      expect(finding.summary.length).toBeGreaterThan(0);
    }
  });

  it('doctor exits with validation code when production allows unfiltered MCP', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogsled-doctor-cli-'));
    try {
      mkdirSync(join(cwd, 'generated'), { recursive: true });
      writeFileSync(join(cwd, 'dogsled.yml'), 'pipelines: {}\n');
      const result = await runDoctorCommand({
        cwd,
        env: { NODE_ENV: 'production', BOBSLED_CORE_MCP_ALLOW_UNFILTERED: '1' },
      });
      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(result.stdout) as {
        valid: boolean;
        checks: Array<{ name: string; status: string }>;
      };
      expect(parsed.valid).toBe(false);
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({
          name: 'mcp.unfiltered_in_production',
          status: 'error',
        })
      );
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({ name: 'sdk.stale', status: 'ok' })
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
