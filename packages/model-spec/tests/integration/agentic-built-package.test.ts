import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomRunnerRegistry, isDuckDbAvailable } from '@bobsled-inc/connections';
import { createWarehouseRowStore } from '@bobsled-inc/model-spec/agentic';
import { runProject } from '@bobsled-inc/model-spec/project';
import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { publicationWarehouse } from '../support/publication-warehouse.js';
import { createSnowflakeEmulator } from '../support/snowflake-emulator.js';
import { runFixture } from '../unit/agentic/state-fixture.js';

// The row count must exceed 1,000, so the cost is fixed: about 6 seconds on an idle machine and 33
// to 63 seconds on a CI runner that shares its cores with three other workers. Three times the
// slowest CI run still fails a hang.
const BUILT_PACKAGE_TIMEOUT_MS = 180_000;

it.skipIf(!(await isDuckDbAvailable()))(
  'publishes more than 1,000 rows through the built agentic and project entries',
  async () => {
    const emulator = await createSnowflakeEmulator();
    const directory = mkdtempSync(join(tmpdir(), 'agentic-built-package-'));
    try {
      const rowCount = 1_001;
      const { host, model, context } = runFixture(rowCount);
      model.limits.tokens = 1_000_000;
      model.sources.pairs!.ref = 'lake.pairs';
      host.inputs['lake.pairs'] = host.inputs.undecided_pairs!;
      host.supportedDialects = ['postgres'];
      const execute = vi.spyOn(host, 'executeAgent').mockImplementation(async ({ assignment }) => ({
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage: { status: 'unknown', reason: 'unavailable' },
        rows: [
          {
            pair_id: assignment.group_key.pair_id,
            assessment: 'review',
            _dogsled_evidence: null,
            _dogsled_confidence: null,
            _dogsled_reason: null,
          },
        ],
      }));
      const publication = publicationWarehouse('postgres', { context: context() });
      publication.absent();
      const customRunners = new CustomRunnerRegistry();
      customRunners.register('postgres', 'password', async () => publication.runner);

      for (const folder of ['integrations', 'sources', 'models']) {
        mkdirSync(join(directory, folder));
      }
      writeFileSync(
        join(directory, 'integrations/lake.yml'),
        stringify({
          spec_version: '1',
          type: 'integration',
          name: 'lake',
          source_type: 'postgres',
          connection: { host: 'localhost', database: 'test', port: 5432, schema: 'main' },
          auth: { type: 'password', user: 'test', password: 'test-only' },
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
      const result = await runProject(directory, { customRunners, agentic: { host, stateStore } });

      expect(result.ok, result.byIntegration[0]?.error).toBe(true);
      expect(result.byIntegration[0]?.executionResults).toMatchObject([
        { modelName: model.name, status: 'success' },
      ]);
      expect(execute).toHaveBeenCalledTimes(rowCount);
      expect(publication.target()).toHaveLength(rowCount);
      expect(publication.receipts()).toHaveLength(1);
    } finally {
      await emulator.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  BUILT_PACKAGE_TIMEOUT_MS
);
