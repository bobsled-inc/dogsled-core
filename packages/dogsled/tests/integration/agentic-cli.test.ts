import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';

import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const dogsledRoot = path.join(repoRoot, 'packages/dogsled');
const example = path.join(repoRoot, 'examples/agentic-pairs');
const cli = path.join(dogsledRoot, 'bin/cli.mjs');
let project = '';

// The real local executor still builds schemas, reserves tokens, and validates results.
// Only its provider call is replaced. The child process cannot make a provider request.
const provider = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createExecutor } from './executor.mjs';
export const executeAgent = createExecutor(async (_connection, options) => {
  const { input } = JSON.parse(options.prompt);
  const pair = input.rows[0];
  appendFileSync('calls.jsonl', JSON.stringify(pair.pair_id) + '\\n');
  if (process.env.AGENTIC_TEST_CRASH === '1' && pair.pair_id === 'pair-2' && !existsSync('crashed')) {
    writeFileSync('crashed', 'yes');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  const assessment = { 'pair-1': 'same_user', 'pair-2': 'different_user', 'pair-3': 'insufficient_evidence' }[pair.pair_id];
  const value = options.schema.parse({ rows: [{
    pair_id: pair.pair_id, assessment, reason: 'Prepared synthetic evidence only.',
    evidence: pair.prepared_evidence,
    _dogsled_evidence: null, _dogsled_confidence: null, _dogsled_reason: null,
  }] });
  return { ok: true, value, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, tokenUsage: 150, costUsd: 0 };
});
`;

// The real loop and SQL source adapter run; only the provider response is fixed.
const loopProvider = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createLoopExecutor } from './loop-executor.mjs';
export const executeAgent = createLoopExecutor(async (_connection, options) => {
  const { input, history, allowed_sources } = JSON.parse(options.prompt);
  const pair = input.rows[0];
  assert.deepEqual(allowed_sources, ['undecided_pairs']);
  appendFileSync('calls.jsonl', JSON.stringify({ pair: pair.pair_id, turn: history.length }) + '\\n');
  if (history.length === 0) {
    return { ok: true, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      value: { decision: { action: 'read',
        source: process.env.AGENTIC_TEST_DENIED === '1' ? 'raw_pairs' : 'undecided_pairs',
        arguments: { limit: 10, columns: ['pair_id'], search: null } } } };
  }
  if (process.env.AGENTIC_TEST_CRASH === '1' && pair.pair_id === 'pair-2' && !existsSync('crashed')) {
    writeFileSync('crashed', 'yes');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].response.rows.map(row => row.pair_id).sort(), ['pair-1', 'pair-2', 'pair-3']);
  assert.ok(history[0].response.retrieved_at);
  const assessment = { 'pair-1': 'same_user', 'pair-2': 'different_user', 'pair-3': 'insufficient_evidence' }[pair.pair_id];
  return { ok: true, usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
    value: { decision: { action: 'finish', rows: [{ pair_id: pair.pair_id,
      assessment, reason: 'Checked scoped source rows.', evidence: pair.prepared_evidence,
      _dogsled_evidence: [{ source: 'undecided_pairs', reference: pair.pair_id,
        support_excerpt: null, observation: 1 }],
      _dogsled_confidence: null, _dogsled_reason: null,
    }] } } };
});
`;

async function useLoop() {
  const model = path.join(project, 'models/pair_assessments.yml');
  await fs.writeFile(
    model,
    (await fs.readFile(model, 'utf8'))
      .replace(
        'execution: { mode: llm_call }',
        'execution: { mode: agent_loop }\n      context_sources: [pairs]'
      )
      .replace(
        'Do not search for more data.',
        'Read the permitted source before returning a result.'
      )
  );
  await fs.writeFile(path.join(project, 'test-executor.mjs'), loopProvider);
}

async function run(resume = false, crash = false, denied = false) {
  try {
    const result = await exec(
      process.execPath,
      [
        cli,
        'model',
        'run',
        '+pair_decisions',
        '--integration',
        'local',
        '--agent-executor',
        './test-executor.mjs',
        '--agent-run-id',
        'cli-proof',
        '--agent-tokens-per-assignment',
        '8192',
        ...(resume ? ['--agent-resume'] : []),
        '--json',
      ],
      {
        cwd: project,
        timeout: 30000,
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          AGENTIC_TEST_CRASH: crash ? '1' : '0',
          AGENTIC_TEST_DENIED: denied ? '1' : '0',
        },
      }
    );
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function calls() {
  return (await fs.readFile(path.join(project, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function results(
  sql = 'SELECT pair_id, assessment, next_action, merge_authorized FROM main.pair_decisions ORDER BY pair_id'
) {
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'local',
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: path.join(project, 'data/pairs.duckdb'), read_only: true },
  });
  try {
    return await runner.query!(sql);
  } finally {
    await runner.close?.();
  }
}

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-agentic-cli-'));
  for (const name of [
    'model-spec.yml',
    'dogsled.yml',
    'models',
    'sources',
    'integrations',
    'executor.mjs',
    'loop-executor.mjs',
    'seed.mjs',
  ]) {
    await fs.cp(path.join(example, name), path.join(project, name), { recursive: true });
  }
  await fs.mkdir(path.join(project, 'node_modules/@bobsled-inc'), { recursive: true });
  await fs.symlink(dogsledRoot, path.join(project, 'node_modules/@bobsled-inc/dogsled'), 'dir');
  await fs.symlink(
    await fs.realpath(path.join(dogsledRoot, 'node_modules/zod')),
    path.join(project, 'node_modules/zod'),
    'dir'
  );
  await fs.writeFile(path.join(project, 'test-executor.mjs'), provider);
  await exec(process.execPath, ['seed.mjs'], { cwd: project, timeout: 15000 });
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe('standalone agentic CLI with a local executor and native DuckDB', () => {
  it('runs SQL → agentic → SQL and resumes without repeating accepted calls', async () => {
    const first = await run();
    expect(first, first.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, agent_run_id: 'cli-proof' });
    expect(await calls()).toEqual(['pair-1', 'pair-2', 'pair-3']);
    expect(await results()).toEqual([
      {
        pair_id: 'pair-1',
        assessment: 'same_user',
        next_action: 'review_merge',
        merge_authorized: false,
      },
      {
        pair_id: 'pair-2',
        assessment: 'different_user',
        next_action: 'keep_separate',
        merge_authorized: false,
      },
      {
        pair_id: 'pair-3',
        assessment: 'insufficient_evidence',
        next_action: 'request_more_evidence',
        merge_authorized: false,
      },
    ]);
    const resumed = await run(true);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    expect(await calls()).toEqual(['pair-1', 'pair-2', 'pair-3']);
  }, 60000);

  it('runs two maps and a named reduce, publishes only the final step, and resumes', async () => {
    const file = path.join(project, 'models/pair_assessments.yml');
    const model = parse(await fs.readFile(file, 'utf8'));
    const first = model.plan.steps[0];
    const second = { ...structuredClone(first), id: 'check' };
    const reduce = {
      ...structuredClone(first),
      id: 'combine',
      source: { ref: 'assess' },
      reduce: { over: ['assess', 'check'], group_by: ['pair_id'] },
      instructions: 'Combine the two named assessments.',
    };
    delete reduce.map;
    model.plan.steps = [first, second, reduce];
    model.output.from = 'combine';
    model.limits.tokens = 100000;
    await fs.writeFile(file, stringify(model));
    await fs.writeFile(
      path.join(project, 'test-executor.mjs'),
      provider
        .replace(
          'const { input } = JSON.parse(options.prompt);',
          `const { input, inputs } = JSON.parse(options.prompt);
       if (input.ref === 'assess') {
         if (!inputs.assess.complete || !inputs.check.complete || inputs.check.rows.length !== 1)
           throw new Error('Missing named reduce input');
       }`
        )
        .replace(
          'evidence: pair.prepared_evidence,',
          'evidence: pair.prepared_evidence ?? pair.evidence,'
        )
    );
    const firstRun = await run();
    expect(firstRun, firstRun.stderr).toMatchObject({ code: 0 });
    expect(await calls()).toHaveLength(9);
    expect(await results()).toHaveLength(3);
    const resumed = await run(true);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    expect(await calls()).toHaveLength(9);
    expect((await results()).every((row) => row.merge_authorized === false)).toBe(true);
  }, 60000);

  it('recovers after a killed call and keeps the result accepted before the crash', async () => {
    const interrupted = await run(false, true);
    expect(interrupted.code).not.toBe(0);
    expect(await calls()).toEqual(['pair-1', 'pair-2']);
    const resumed = await run(true);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    expect(await calls()).toEqual(['pair-1', 'pair-2', 'pair-2', 'pair-3']);
    expect(await results()).toHaveLength(3);
    expect((await results()).every((row) => row.merge_authorized === false)).toBe(true);
  }, 60000);

  it('runs a real scoped read inside each loop, publishes downstream, and resumes without calls', async () => {
    await useLoop();
    const first = await run();
    expect(first, first.stderr).toMatchObject({ code: 0 });
    const expected = ['pair-1', 'pair-2', 'pair-3'].flatMap((pair) => [
      { pair, turn: 0 },
      { pair, turn: 1 },
    ]);
    expect(await calls()).toEqual(expected);
    expect(await results()).toEqual([
      {
        pair_id: 'pair-1',
        assessment: 'same_user',
        next_action: 'review_merge',
        merge_authorized: false,
      },
      {
        pair_id: 'pair-2',
        assessment: 'different_user',
        next_action: 'keep_separate',
        merge_authorized: false,
      },
      {
        pair_id: 'pair-3',
        assessment: 'insufficient_evidence',
        next_action: 'request_more_evidence',
        merge_authorized: false,
      },
    ]);
    const resumed = await run(true);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    expect(await calls()).toEqual(expected);
    expect(await results()).toHaveLength(3);
  }, 60000);

  it('rejects an undeclared loop source before publication and downstream SQL', async () => {
    await useLoop();
    const failed = await run(false, false, true);
    expect(failed.code).not.toBe(0);
    expect(await calls()).toEqual([{ pair: 'pair-1', turn: 0 }]);
    expect(
      await results(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name IN ('pair_assessments', 'pair_decisions')"
      )
    ).toEqual([]);
  }, 60000);

  it('restarts an interrupted loop but reuses the accepted assignment after a process crash', async () => {
    await useLoop();
    const interrupted = await run(false, true);
    expect(interrupted.code).not.toBe(0);
    const initial = ['pair-1', 'pair-2'].flatMap((pair) => [
      { pair, turn: 0 },
      { pair, turn: 1 },
    ]);
    expect(await calls()).toEqual(initial);
    const resumed = await run(true);
    expect(resumed, resumed.stderr).toMatchObject({ code: 0 });
    expect(await calls()).toEqual([
      ...initial,
      ...['pair-2', 'pair-3'].flatMap((pair) => [
        { pair, turn: 0 },
        { pair, turn: 1 },
      ]),
    ]);
    expect(await results()).toHaveLength(3);
    expect((await results()).every((row) => row.merge_authorized === false)).toBe(true);
  }, 60000);
});
