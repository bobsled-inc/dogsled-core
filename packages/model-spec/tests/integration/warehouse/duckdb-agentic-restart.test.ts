import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildDuckDbRunner, type DuckDbIntegration } from '@bobsled-inc/connections';
import {
  createDuckDbAgenticPublisher,
  executeAgenticRun,
  type AgenticRunProgress,
} from '../../../src/agentic/index.js';
import { runFixture } from '../../unit/agentic/state-fixture.js';
import { warehouseEnabled } from './setup.js';

it.skipIf(!warehouseEnabled('duckdb'))(
  'restarts failed incremental work, publishes once, and advances the cursor only after success',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dogsled-restart-'));
    const integration: DuckDbIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      auth: { type: 'file', path: join(directory, 'data.duckdb') },
    };
    const publisher = await createDuckDbAgenticPublisher(integration);
    try {
      const f = runFixture(2);
      f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
      f.host.inputs.undecided_pairs!.push({ name: 'updated_at', type: 'integer', nullable: false });
      f.host.prepare = vi.fn(async () => [
        { pair_id: 'a', updated_at: 1 },
        { pair_id: 'b', updated_at: 2 },
      ]);
      let repaired = false;
      const calls: string[] = [];
      f.host.executeAgent = async ({ assignment }) => {
        const pair = String(assignment.group_key.pair_id);
        calls.push(pair);
        const base = {
          contract_version: 2 as const,
          attempt_id: assignment.attempt_id,
          usage: {
            status: 'measured' as const,
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        };
        if (calls.length === 2 && !repaired) {
          return {
            ...base,
            status: 'failed',
            error: { kind: 'validation', code: 'INVALID_OUTPUT', retryable: false },
          };
        }
        return {
          ...base,
          status: 'succeeded',
          rows: [
            {
              pair_id: pair,
              assessment: 'ready',
              _bobsled_evidence: null,
              _bobsled_confidence: null,
              _bobsled_reason: null,
            },
          ],
        };
      };
      const progress: AgenticRunProgress[] = [];
      const options = {
        projectDirectory: directory,
        publisher,
        run: { id: 'run', mode: 'start' as const },
        onProgress: (value: AgenticRunProgress) => {
          progress.push(value);
        },
      };
      await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow(
        /Agentic step "assess" assignment \S+ failed/
      );
      const originalCalls = [...calls];
      expect(originalCalls).toHaveLength(2);
      repaired = true;
      const resume = {
        ...options,
        run: { id: 'run', mode: 'resume' as const },
        retryFailedAssignments: true,
      };
      expect((await executeAgenticRun(f.host, f.context(), resume)).publication).toBe('confirmed');
      expect(calls).toEqual([...originalCalls, originalCalls[1]]);
      expect(f.host.prepare).toHaveBeenCalledTimes(1);
      expect(progress.at(-1)).toMatchObject({ total: 2, accepted: 2, publication: 'confirmed' });
      await executeAgenticRun(f.host, f.context(), resume);
      expect(calls).toEqual([...originalCalls, originalCalls[1]]);
      f.host.prepare = async () => [
        { pair_id: 'a', updated_at: 1 },
        { pair_id: 'b', updated_at: 2 },
        { pair_id: 'c', updated_at: 3 },
      ];
      await executeAgenticRun(f.host, f.context(), {
        ...options,
        run: { id: 'next', mode: 'start' },
      });
      expect(calls).toEqual([...originalCalls, originalCalls[1], 'c']);
      await publisher.close();
      const runner = await buildDuckDbRunner(integration);
      try {
        expect(
          await runner.query!('SELECT pair_id FROM main.pair_assessments ORDER BY pair_id')
        ).toEqual([{ pair_id: 'a' }, { pair_id: 'b' }, { pair_id: 'c' }]);
      } finally {
        await runner.close!();
      }
    } finally {
      await publisher.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000
);
