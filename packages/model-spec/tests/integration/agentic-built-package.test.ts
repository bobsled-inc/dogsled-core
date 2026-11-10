import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import { createWarehouseRowStore, type AgenticPublisher } from '@bobsled-inc/model-spec/agentic';
import { runProject } from '@bobsled-inc/model-spec/project';
import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createSnowflakeEmulator } from '../support/snowflake-emulator.js';
import { runFixture } from '../unit/agentic/state-fixture.js';

it.skipIf(!(await isDuckDbAvailable()))(
  'runs more than 1,000 rows through the built agentic and project entries',
  async () => {
    const emulator = await createSnowflakeEmulator();
    const directory = mkdtempSync(join(tmpdir(), 'agentic-built-package-'));
    try {
      const rowCount = 1_001;
      const { host, model } = runFixture(rowCount);
      model.limits.tokens = 1_000_000;
      model.sources.pairs!.ref = 'lake.pairs';
      host.inputs['lake.pairs'] = host.inputs.undecided_pairs!;
      const execute = vi.spyOn(host, 'executeAgent');

      for (const folder of ['integrations', 'sources', 'models']) {
        mkdirSync(join(directory, folder));
      }
      writeFileSync(
        join(directory, 'integrations/lake.yml'),
        stringify({
          spec_version: '1',
          type: 'integration',
          name: 'lake',
          source_type: 'duckdb',
          connection: { schema: 'main' },
          auth: { type: 'file', path: join(directory, 'lake.duckdb'), read_only: false },
        })
      );
      writeFileSync(
        join(directory, 'sources/pairs.yml'),
        stringify({
          spec_version: '0.2',
          type: 'source',
          name: 'pairs',
          source_type: 'warehouse_table',
          connection: 'lake',
          table: 'raw.pairs',
          schema: { columns: [{ name: 'pair_id', type: 'STRING' }] },
        })
      );
      writeFileSync(join(directory, 'models/agentic.yml'), stringify(model));

      const stateStore = createWarehouseRowStore(emulator.integration, {
        schema: 'checkpoints',
        customRunners: emulator.customRunners,
      });
      // Confirm publication through the host contract so this exercises the row store's bounds.
      const publisher: AgenticPublisher = {
        preflight: async () => {},
        claim: async () => ({ version: 0, fence: 'fence' }),
        prepare: async (_context, identity) => ({
          identity,
          expected_version: 0,
          stage: `stage_${identity.operation_id}`,
        }),
        inspect: async () => null,
        commit: async (intent) => ({ intent, committed_version: 1 }),
        close: async () => {},
      };
      const result = await runProject(directory, { agentic: { host, stateStore, publisher } });

      expect(result.ok, result.byIntegration[0]?.error).toBe(true);
      expect(result.byIntegration[0]?.executionResults).toMatchObject([
        { modelName: model.name, status: 'success' },
      ]);
      expect(execute).toHaveBeenCalledTimes(rowCount);
    } finally {
      await emulator.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000
);
