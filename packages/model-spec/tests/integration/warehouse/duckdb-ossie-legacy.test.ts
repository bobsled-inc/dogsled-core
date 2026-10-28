import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CustomRunnerRegistry,
  IntegrationFileSchema,
  resolveRunner,
} from '@bobsled-inc/connections';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { runProject } from '../../../src/api/run-project.js';
import { warehouseEnabled } from './setup.js';

const fixtureDir = fileURLToPath(new URL('../../fixtures/ossie-native-legacy/', import.meta.url));

describe.skipIf(!warehouseEnabled('duckdb'))('legacy direct Ossie reader — DuckDB', () => {
  it('builds the fixture and returns the expected revenue', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ossie-docs-duckdb-'));
    let close: (() => Promise<void>) | undefined;
    try {
      await fs.cp(fixtureDir, root, { recursive: true });
      const raw = parse(await fs.readFile(path.join(root, 'warehouse.yml'), 'utf8'));
      raw.auth.path = path.join(root, 'orders.duckdb');
      const integration = IntegrationFileSchema.parse(raw);
      await fs.writeFile(path.join(root, 'warehouse.yml'), stringify(integration));
      const runner = await resolveRunner(integration);
      close = runner.close?.bind(runner);
      await runner.run(await fs.readFile(path.join(root, 'setup.sql'), 'utf8'));
      const customRunners = new CustomRunnerRegistry();
      customRunners.register('duckdb', 'file', async () => ({
        run: (sql) => runner.run(sql),
        query: runner.query ? (sql) => runner.query!(sql) : undefined,
      }));
      const result = await runProject(root, { integration: 'warehouse', customRunners });
      expect(result.ok, JSON.stringify(result.byIntegration)).toBe(true);
      expect(
        await runner.query!(
          'SELECT CAST(order_id AS INTEGER) AS id, CAST(net_amount AS DOUBLE) AS amount FROM analytics.clean_orders ORDER BY order_id'
        )
      ).toEqual([
        { id: 1, amount: 90 },
        { id: 2, amount: 45 },
      ]);
      expect(
        await runner.query!(
          'SELECT CAST(SUM(net_amount) AS DOUBLE) AS revenue FROM analytics.clean_orders'
        )
      ).toEqual([{ revenue: 135 }]);
      expect(
        await runner.query!('SELECT customer_name FROM analytics.customers ORDER BY customer_id')
      ).toEqual([{ customer_name: 'Ada' }, { customer_name: 'Lin' }]);
    } finally {
      await close?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
