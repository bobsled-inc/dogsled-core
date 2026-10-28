import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_READY, makeProject, parseJsonStdout, run } from './helpers.js';

const SPAWN_TEST_TIMEOUT_MS = 60_000;
const MULTI_SPAWN_TEST_TIMEOUT_MS = 120_000;

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

  it('keeps one build runner open across incremental planning and execution', () => {
    const runnerPath = path.join(tmpDir, 'build-runner.mjs');
    const eventsPath = path.join(tmpDir, 'build-runner-events.log');
    fs.writeFileSync(
      runnerPath,
      [
        `import { appendFileSync } from 'node:fs';`,
        `const eventsPath = process.env.BUILD_RUNNER_EVENTS_PATH;`,
        `let closed = false;`,
        `function event(name) { appendFileSync(eventsPath, name + '\\n'); }`,
        `function assertOpen(operation) { if (closed) throw new Error('runner closed before ' + operation); }`,
        `export async function query() {`,
        `  assertOpen('query');`,
        `  event('query');`,
        `  return [];`,
        `}`,
        `export async function run() {`,
        `  assertOpen('run');`,
        `  event('run');`,
        `  return { rowCount: 1 };`,
        `}`,
        `export async function close() {`,
        `  event('close');`,
        `  closed = true;`,
        `}`,
      ].join('\n')
    );

    const result = run(
      [
        'build',
        'company',
        '--runner',
        runnerPath,
        '--incremental',
        '--json',
        '--quiet',
        '--dialect',
        'duckdb',
      ],
      projectDir,
      { BUILD_RUNNER_EVENTS_PATH: eventsPath }
    );

    expect(result.exitCode).toBe(0);
    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    expect(events[0]).toBe('query');
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    expect(events.at(-1)).toBe('close');
    expect(events.filter((event) => event === 'run').length).toBeGreaterThan(0);
  });

  it(
    'validates resolve inspect cluster ID flags',
    () => {
      const conflict = run(
        [
          'resolve',
          'inspect',
          'cluster',
          '--entity',
          'company',
          '--entity-id',
          'entity-1',
          '--cluster-id',
          'cluster-2',
          '--json',
          '--dialect',
          'snowflake',
        ],
        projectDir
      );
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stderr).toContain('--entity-id and --cluster-id conflict');

      const missing = run(
        [
          'resolve',
          'inspect',
          'cluster',
          '--entity',
          'company',
          '--json',
          '--dialect',
          'snowflake',
        ],
        projectDir
      );
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain('Provide --entity-id or --cluster-id');
    },
    MULTI_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    'emits resolve inspect cluster JSON for unexecuted ID lookup forms',
    () => {
      for (const args of [
        ['--entity-id', 'entity-1'],
        ['--cluster-id', 'entity-1'],
        ['--entity-id', 'entity-1', '--cluster-id', 'entity-1'],
      ]) {
        const result = run(
          [
            'resolve',
            'inspect',
            'cluster',
            '--entity',
            'company',
            ...args,
            '--json',
            '--dialect',
            'snowflake',
          ],
          projectDir
        );

        expect(result.exitCode).toBe(0);
        const json = parseJsonStdout<{
          command: string;
          entity_id: string;
          cluster_id: string;
          executed: boolean;
          found: null;
          query: string;
        }>(result);
        expect(json).toMatchObject({
          command: 'resolve.inspect.cluster',
          entity_id: 'entity-1',
          cluster_id: 'entity-1',
          executed: false,
          found: null,
        });
        expect(json.query).toContain('COMPANY__CLUSTERS');
      }
    },
    MULTI_SPAWN_TEST_TIMEOUT_MS
  );
});
