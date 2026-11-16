import { runFixture } from '../../unit/agentic/state-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildDuckDbRunner, type DuckDbIntegration } from '@bobsled-inc/connections';
import { executeAgenticRun, createDuckDbAgenticPublisher } from '../../../src/agentic/index.js';
import { warehouseEnabled } from './setup.js';

it.skipIf(!warehouseEnabled('duckdb'))(
  'shares one durable DuckDB cursor table across models',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bobsled-duckdb-cursors-'));
    const integration: DuckDbIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      auth: { type: 'file', path: join(directory, 'data.duckdb') },
    };
    const key = { scope: 'project', model: 'pairs', target: 'main.pairs' };
    const signature = 'a'.repeat(64);
    let publisher = await createDuckDbAgenticPublisher(integration);
    try {
      expect(await publisher.cursors!.begin(key, signature, 'one')).toEqual({});
      await expect(publisher.cursors!.begin(key, signature, 'two')).rejects.toThrow();
      await publisher.cursors!.commit(key, signature, 'one', { pairs: 10 });
      await publisher.close();
      publisher = await createDuckDbAgenticPublisher(integration);
      expect(await publisher.cursors!.begin(key, signature, 'two')).toEqual({ pairs: 10 });
      await publisher.cursors!.commit(key, signature, 'two', { pairs: 20 });
      await publisher.cursors!.begin({ ...key, model: 'other' }, signature, 'three');
      await publisher.close();
      const runner = await buildDuckDbRunner(integration);
      try {
        expect(
          await runner.query!(
            'SELECT count(*)::INTEGER AS n FROM _bobsled_agentic_publication.cursors'
          )
        ).toEqual([{ n: 2 }]);
      } finally {
        await runner.close!();
      }
    } finally {
      await publisher.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.skipIf(!warehouseEnabled('duckdb'))(
  'publishes empty findings and resumes incremental batches with DuckDB',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bobsled-duckdb-incremental-'));
    const integration: DuckDbIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      auth: { type: 'file', path: join(directory, 'data.duckdb') },
    };
    const publisher = await createDuckDbAgenticPublisher(integration);
    const f = runFixture(2);
    f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
    f.host.inputs = {
      undecided_pairs: [
        { name: 'pair_id', type: 'string', nullable: false },
        { name: 'updated_at', type: 'integer', nullable: false },
      ],
    };
    let inputs = [
      { pair_id: 'a', updated_at: 1 },
      { pair_id: 'b', updated_at: 2 },
    ];
    f.host.prepare = async () => inputs;
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    const run = (id: string) =>
      executeAgenticRun(f.host, f.context(), {
        publisher,
        projectDirectory: directory,
        run: { id, mode: 'start' },
      });
    try {
      expect((await run('one')).publication).toBe('confirmed');
      expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
      expect((await run('two')).publication).toBe('confirmed');
      expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
      inputs = [
        { pair_id: 'a', updated_at: 3 },
        { pair_id: 'b', updated_at: 2 },
      ];
      vi.mocked(f.host.executeAgent!).mockRejectedValueOnce(new Error('lost response'));
      await expect(run('failed')).rejects.toThrow();
      expect((await run('three')).publication).toBe('confirmed');
      expect(f.host.executeAgent).toHaveBeenCalledTimes(4);
      await expect(run('failed')).rejects.toThrow('superseded');
      await run('unchanged');
      expect(f.host.executeAgent).toHaveBeenCalledTimes(4);
    } finally {
      await publisher.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
