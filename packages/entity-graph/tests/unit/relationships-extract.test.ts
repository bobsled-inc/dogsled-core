import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  registerRelationshipsExtractCommand,
  runRelationshipsExtract,
} from '../../src/commands/relationships-extract.js';

async function fixtureProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'relationships-extract-'));
  const entityGraphDir = path.join(cwd, 'entity-graph');
  await mkdir(entityGraphDir, { recursive: true });
  await writeFile(
    path.join(entityGraphDir, 'Customer_relationship_extraction.yml'),
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
    ].join('\n')
  );
  return cwd;
}

describe('relationships extract command', () => {
  it('dry-runs with a deterministic summary and no runner', async () => {
    const cwd = await fixtureProject();
    const result = await runRelationshipsExtract('Customer', { cwd, dryRun: true });

    expect(result.executed).toBe(false);
    expect(result.spec_count).toBe(1);
    expect(result.specs[0]?.name).toBe('Customer_relationships');
    expect(result.count).toBe(0);
  });

  it('dry-run emits JSON/YAML-equivalent receipts', async () => {
    const cwd = await fixtureProject();
    const run = async (format: 'json' | 'yaml') => {
      let buf = '';
      const program = new Command('relationships');
      program.exitOverride();
      registerRelationshipsExtractCommand(program, {
        cwd,
        writer: { out: (s) => (buf += s), err: (s) => (buf += s) },
      });
      await program.parseAsync(
        ['extract', 'Customer', '--dry-run', format === 'json' ? '--json' : '--yaml'],
        { from: 'user' }
      );
      return buf;
    };

    const json = JSON.parse(await run('json'));
    const yaml = YAML.parse(await run('yaml'));
    expect(yaml).toEqual(json);
  });

  it('maps schema_violation AI errors to validation exit code 2', async () => {
    const cwd = await fixtureProject();
    await expect(
      runRelationshipsExtract('Customer', {
        cwd,
        extractor: async () => ({ ok: false, error: 'schema_violation', message: 'bad JSON' }),
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      payload: { kind: 'schema_violation' },
    } satisfies Partial<CommandError>);
  });

  it('maps budget_exceeded AI errors to runtime exit code 1', async () => {
    const cwd = await fixtureProject();
    await expect(
      runRelationshipsExtract('Customer', {
        cwd,
        extractor: async () => ({
          ok: false,
          error: 'budget_exceeded',
          message: 'budget exhausted',
          budget_remaining: 0,
        }),
      })
    ).rejects.toMatchObject({
      exitCode: 1,
      payload: { kind: 'budget_exceeded', budget_remaining: 0 },
    } satisfies Partial<CommandError>);
  });

  it('maps provider_error AI errors to runtime exit code 1', async () => {
    const cwd = await fixtureProject();
    await expect(
      runRelationshipsExtract('Customer', {
        cwd,
        extractor: async () => ({
          ok: false,
          error: 'provider_error',
          message: 'provider unavailable',
          provider_id: 'bedrock',
        }),
      })
    ).rejects.toMatchObject({
      exitCode: 1,
      payload: { kind: 'provider_error', provider_id: 'bedrock' },
    } satisfies Partial<CommandError>);
  });
});
