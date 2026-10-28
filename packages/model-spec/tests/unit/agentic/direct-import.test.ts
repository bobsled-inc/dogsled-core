import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.each(['run', 'publication'])(
  'initializes %s directly in a fresh ESM process',
  async (entry) => {
    const url = new URL(`../../../src/agentic/${entry}.ts`, import.meta.url).href;
    const stateUrl = new URL('../../../src/agentic/state.ts', import.meta.url).href;
    // Vitest's module loader and the public barrel's export order can mask ESM cycles.
    const script = `
    import assert from 'node:assert/strict';
    await import(${JSON.stringify(url)});
    const { AgenticCheckpointCommandSchema } = await import(${JSON.stringify(stateUrl)});
    const digest = 'a'.repeat(64);
    const intent = {
      identity: {
        operation_id: digest,
        run: { scope: 'lake', model: 'pairs', id: 'run' },
        definition_digest: digest,
        target: 'main.pairs',
        schema_digest: digest,
        results_digest: digest,
        processed_keys_digest: digest,
      },
      expected_version: 0,
      stage: 'stage_' + digest,
    };
    const prepare = { type: 'prepare_publication', operation_id: 'prepare', expected_revision: 0, intent };
    const confirm = {
      type: 'confirm_publication', operation_id: 'confirm', expected_revision: 1,
      receipt: { intent, committed_version: 1 },
    };
    assert.deepEqual(AgenticCheckpointCommandSchema.parse(prepare), prepare);
    assert.deepEqual(AgenticCheckpointCommandSchema.parse(confirm), confirm);
    assert.equal(AgenticCheckpointCommandSchema.safeParse({ ...prepare, intent: {} }).success, false);
    assert.equal(AgenticCheckpointCommandSchema.safeParse({ ...confirm, receipt: {} }).success, false);
  `;
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      }
    );
    expect(result.stderr).toBe('');
  },
  65_000
);
