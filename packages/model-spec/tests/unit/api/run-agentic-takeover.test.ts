import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { expect, it, vi } from 'vitest';
import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { runProject } from '../../../src/api/index.js';
import {
  createLocalAgenticCursorStore,
  type AgenticPublisher,
} from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from '../agentic/state-fixture.js';

it('starts fresh after failure when the caller omits run IDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentic-fresh-start-'));
  try {
    for (const directory of ['integrations', 'sources', 'models']) mkdirSync(join(root, directory));
    writeFileSync(
      join(root, 'integrations/lake.yml'),
      stringify({
        spec_version: '1',
        type: 'integration',
        name: 'lake',
        source_type: 'duckdb',
        connection: { schema: 'main' },
        auth: { type: 'file', path: join(root, 'unused.duckdb') },
      })
    );
    const columns = [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'updated_at', type: 'integer', nullable: false },
    ] as const;
    writeFileSync(
      join(root, 'sources/pairs.yml'),
      stringify({
        spec_version: '0.2',
        type: 'source',
        name: 'pairs',
        source_type: 'warehouse_table',
        connection: 'lake',
        table: 'raw.pairs',
        schema: { columns },
      })
    );
    const f = runFixture(1);
    f.model.sources.pairs = { ref: 'lake.pairs', incremental: { cursor_field: 'updated_at' } };
    f.model.limits.tokens = 150;
    f.host.inputs = { 'lake.pairs': [...columns] };
    f.host.prepare = async () => [{ pair_id: 'one', updated_at: 1 }];
    f.host.executeAgent = vi.fn(f.host.executeAgent).mockRejectedValueOnce(new Error('offline'));
    writeFileSync(join(root, 'models/agentic.yml'), stringify(f.model));
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run: async () => ({ rowCount: 0 }) }));
    const publisher: AgenticPublisher = {
      preflight: async () => {},
      claim: async () => ({ version: 0, fence: 'owner' }),
      prepare: async (_context, identity) => ({
        identity,
        expected_version: 0,
        stage: `stage_${identity.operation_id}`,
      }),
      inspect: async () => null,
      commit: async (intent) => ({ intent, committed_version: 1 }),
      close: async () => {},
    };
    const stateStore = new MemoryStateStore();
    const options = {
      customRunners,
      agentic: {
        host: f.host,
        publisher,
        stateStore,
        cursorStore: createLocalAgenticCursorStore(root),
      },
    };
    expect((await runProject(root, options)).ok).toBe(false);
    const second = await runProject(root, options);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect((await runProject(root, options)).ok).toBe(true);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    const runs = [...stateStore.runs.values()];
    expect(new Set(runs.map((run) => run.key.id)).size).toBe(3);
    expect(runs[0]).toMatchObject({ superseded: true, charged: 100 });
    expect(runs[1]).toMatchObject({ publication: 'confirmed', cursor_values: { pairs: 1 } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
