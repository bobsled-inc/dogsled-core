import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_READY, makeProject, parseJsonStdout, run } from './helpers.js';

const SPAWN_TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!CLI_READY)('entity-graph CLI (e2e)', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let tmpDir: string;
  let projectDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-graph-cli-'));
    projectDir = makeProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits resolve inspect cluster JSON for executed results', () => {
    const runnerPath = path.join(tmpDir, 'inspect-runner.mjs');
    fs.writeFileSync(
      runnerPath,
      [
        `export async function run() { return { status: 'success' }; }`,
        `export async function query() {`,
        `  return [`,
        `    { section: 'contributing_decisions', entity_id: 'requested-alias', cluster_id: 'requested-alias', pair_id: 'pair-1' },`,
        `    { section: 'golden_record', entity_id: 'stable-entity', cluster_id: 'stable-entity', attribute_name: 'domain', attribute_value: 'acme.com' },`,
        `    { section: 'audit', entity_id: 'stable-entity', cluster_id: 'stable-entity', event_id: 'evt-1', category: 'resolution', subject_type: 'cluster', subject_id: 'stable-entity', payload: '{"kind":"merge","entity_id":"stable-entity"}', audit_reason: 'cluster_rebuilt' },`,
        `    { section: 'members', entity_id: 'stable-entity', cluster_id: 'stable-entity', record_id: 'rec-1', source_ref: 'crm', source_system: 'crm', source_entity_id: 'crm-1', confidence_score: 0.9 }`,
        `  ];`,
        `}`,
      ].join('\n')
    );

    const result = run(
      [
        'resolve',
        'inspect',
        'cluster',
        '--entity',
        'company',
        '--entity-id',
        'requested-alias',
        '--runner',
        runnerPath,
        '--json',
        '--dialect',
        'snowflake',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(0);
    const json = parseJsonStdout<{
      entity_id: string;
      cluster_id: string;
      executed: boolean;
      found: boolean;
      members: unknown[];
      crosswalks: unknown[];
      golden_record: unknown[];
      contributing_decisions: unknown[];
      audit: Array<{ payload: unknown; audit_reason: string | null }>;
    }>(result);
    expect(json).toMatchObject({
      entity_id: 'stable-entity',
      cluster_id: 'stable-entity',
      executed: true,
      found: true,
    });
    expect(json.members).toHaveLength(1);
    expect(json.crosswalks).toEqual([]);
    expect(json.audit).toEqual([
      expect.objectContaining({
        payload: { kind: 'merge', entity_id: 'stable-entity' },
        audit_reason: 'cluster_rebuilt',
      }),
    ]);
  });

  it('does not report audit-only inspect cluster rows as found', () => {
    const runnerPath = path.join(tmpDir, 'inspect-audit-runner.mjs');
    fs.writeFileSync(
      runnerPath,
      [
        `export async function run() { return { status: 'success' }; }`,
        `export async function query() {`,
        `  return [`,
        `    { section: 'audit', entity_id: 'deleted-entity', cluster_id: 'deleted-entity', event_id: 'evt-1', category: 'resolution', subject_type: 'cluster', subject_id: 'deleted-entity' }`,
        `  ];`,
        `}`,
      ].join('\n')
    );

    const result = run(
      [
        'resolve',
        'inspect',
        'cluster',
        '--entity',
        'company',
        '--entity-id',
        'deleted-entity',
        '--runner',
        runnerPath,
        '--json',
        '--dialect',
        'snowflake',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(0);
    const json = parseJsonStdout<{
      entity_id: string;
      cluster_id: string;
      executed: boolean;
      found: boolean;
    }>(result);
    expect(json).toMatchObject({
      entity_id: 'deleted-entity',
      cluster_id: 'deleted-entity',
      executed: true,
      found: false,
    });
  });
});
