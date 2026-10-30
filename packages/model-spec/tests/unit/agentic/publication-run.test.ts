import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { createSqlAgenticPublisher } from '../../../src/agentic/sql-publisher.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import type { AgenticPublisher } from '../../../src/agentic/publication.js';
import { runFixture } from './state-fixture.js';
import { checkpointIntegrations } from '../../support/checkpoint-transport.js';
import { agenticWarehouse } from '../../support/agentic-warehouse.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
afterEach(() => resolve.mockReset());

const integration = checkpointIntegrations[1]!;
type Row = { pair_id: string; updated_at: number };

/** Incremental runs through the real stores and SQL publisher on one warehouse double. */
function incremental() {
  const f = runFixture(0);
  f.model.sources.pairs!.incremental = { cursor_field: 'updated_at' };
  f.host.inputs = {
    undecided_pairs: [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'updated_at', type: 'integer', nullable: false },
    ],
  };
  let input: Row[] = [];
  const unanswered = new Set<string>();
  f.host.prepare = async () => input;
  const answer = f.host.executeAgent;
  f.host.executeAgent = vi.fn(async (request) => {
    const result = await answer(request);
    return {
      ...result,
      rows: request.assignment.processed_keys
        .filter(({ pair_id }) => !unanswered.has(String(pair_id)))
        .map(({ pair_id }) => ({
          pair_id,
          assessment: `answer ${String(pair_id)}`,
          _dogsled_evidence: null,
          _dogsled_confidence: null,
          _dogsled_reason: null,
        })),
    };
  });
  const warehouse = agenticWarehouse(f.context());
  warehouse.publication.absent();
  resolve.mockImplementation(async () => warehouse.acquire());
  const prepares = vi.fn();
  const run = async (id: string, mode: 'start' | 'resume' = 'start') => {
    const publisher = await createSqlAgenticPublisher(integration);
    const counted: AgenticPublisher = {
      ...publisher,
      prepare: (...args) => {
        prepares(id);
        return publisher.prepare(...args);
      },
    };
    try {
      return await executeAgenticRun(f.host, f.context(), {
        projectDirectory: '/unused',
        stateStore: createWarehouseCheckpointStore(integration, { schema: 'agentic_state' }),
        publisher: counted,
        run: { id, mode },
      });
    } finally {
      await publisher.close();
    }
  };
  const target = () =>
    warehouse.publication.exists()
      ? warehouse.publication.target().map((row) => [row.pair_id, row.assessment])
      : null;
  const cursor = () =>
    [...warehouse.cursors.rows.values()]
      .filter((row) => row.record)
      .map((row) => JSON.parse(row.record) as { values: unknown; activeRun: unknown })[0];
  return {
    f,
    warehouse,
    run,
    target,
    cursor,
    prepares,
    unanswered,
    input: (rows: Row[]) => {
      input = rows;
    },
  };
}
const rows = (...values: [string, number][]) =>
  values.map(([pair_id, updated_at]) => ({ pair_id, updated_at }));

describe('incremental publication runs', { timeout: 60_000 }, () => {
  it('publishes a second equivalent empty run without staging or changing the target', async () => {
    const t = incremental();
    t.input(rows(['a', 1], ['b', 2], ['c', 3]));
    await t.run('populate');
    const populated = t.target();
    expect(populated).toHaveLength(3);
    for (const id of ['empty-1', 'empty-2']) {
      t.warehouse.measure(0);
      const result = await t.run(id);
      expect(result).toMatchObject({ publication: 'confirmed', rows: [], processedKeys: [] });
      expect(t.target()).toEqual(populated);
      expect(t.cursor()).toMatchObject({ values: { pairs: 3 }, activeRun: null });
      // Checks still run; nothing copies the target or builds a replacement stage.
      expect(t.warehouse.operations['publication:checks']).toBeGreaterThan(0);
      expect(t.warehouse.operations['publication:copy']).toBeUndefined();
      expect(t.warehouse.operations['publication:introspection']).toBeGreaterThan(0);
    }
    expect(t.warehouse.publication.receipts()).toHaveLength(3);
    expect(t.f.host.executeAgent).toHaveBeenCalledTimes(3);
  });

  it('records an empty first run without creating the missing target', async () => {
    const t = incremental();
    const result = await t.run('first');
    expect(result.publication).toBe('confirmed');
    expect(t.target()).toBeNull();
    expect(t.warehouse.publication.receipts()).toHaveLength(1);
    expect(t.cursor()).toMatchObject({ values: {}, activeRun: null });
    const again = await t.run('second');
    expect(again.publication).toBe('confirmed');
    expect(t.target()).toBeNull();
  });

  it('removes prior output for a processed key that returns no rows', async () => {
    const t = incremental();
    t.input(rows(['a', 1], ['b', 2], ['c', 3]));
    await t.run('populate');
    t.input(rows(['a', 1], ['b', 4], ['c', 5]));
    t.unanswered.add('b');
    const result = await t.run('update');
    expect(result.processedKeys).toHaveLength(2);
    expect(result.processedKeys).toEqual(
      expect.arrayContaining([{ pair_id: 'b' }, { pair_id: 'c' }])
    );
    expect(t.target()?.sort()).toEqual([
      ['a', 'answer a'],
      ['c', 'answer c'],
    ]);
    expect(t.cursor()).toMatchObject({ values: { pairs: 5 }, activeRun: null });
  });

  it('advances the cursor only after resuming an uncertain commit', async () => {
    const t = incremental();
    t.input(rows(['a', 1], ['b', 2]));
    await t.run('populate');
    t.input(rows(['a', 1], ['b', 2], ['c', 3]));
    t.warehouse.loseResponse(/INSERT INTO \S+_RECEIPTS/i);
    t.warehouse.fail(/SELECT receipt FROM/i, 1);
    await expect(t.run('uncertain')).rejects.toThrow();
    // The commit landed, but the run has not confirmed it, so the cursor is not advanced.
    expect(t.target()).toHaveLength(3);
    expect(t.cursor()).toMatchObject({ values: { pairs: 2 }, activeRun: 'uncertain' });
    const resumed = await t.run('uncertain', 'resume');
    expect(resumed.publication).toBe('confirmed');
    expect(t.prepares.mock.calls.filter(([id]) => id === 'uncertain')).toHaveLength(1);
    expect(t.warehouse.publication.receipts()).toHaveLength(2);
    expect(t.cursor()).toMatchObject({ values: { pairs: 3 }, activeRun: null });
    expect(t.f.host.executeAgent).toHaveBeenCalledTimes(3);
  });
});
