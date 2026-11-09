import { describe, expect, it } from 'vitest';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { benchmarkWorkload } from '../support/agentic-benchmark.js';
import { writeWarehouseRowRun } from '../support/agentic-row-run.js';
import { createSnowflakeEmulator } from '../support/snowflake-emulator.js';

// The benchmark builds large warehouse runs this way. Reading one back through the store verifies
// every write and validates the run, so the fixture cannot drift from what the store writes.
describe.skipIf(!(await isDuckDbAvailable()))('a run written in bulk', () => {
  it('reads back through the warehouse row store as the run it built', async () => {
    const emulator = await createSnowflakeEmulator();
    try {
      const options = { schema: 'checkpoints', customRunners: emulator.customRunners };
      const built = await writeWarehouseRowRun(
        benchmarkWorkload(50, 'map', 1000),
        emulator.integration,
        { ...options, runId: 'bulk', finished: 40 }
      );
      expect(built.work.filter((work) => work.accepted)).toHaveLength(40);
      const session = await createWarehouseRowStore(emulator.integration, options).acquire(
        built.key
      );
      try {
        expect(await session.read()).toEqual(built);
      } finally {
        await session.release();
      }
    } finally {
      await emulator.close();
    }
  });
});
