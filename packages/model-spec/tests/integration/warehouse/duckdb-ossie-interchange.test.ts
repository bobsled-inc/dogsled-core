import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compileProject } from '../../../src/api/compile-project.js';
import {
  createDuckDbHarness,
  runMaterializationProject,
  type WarehouseTestHarness,
} from './harness.js';
import { warehouseEnabled } from './setup.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
async function convert(args: string[]) {
  const { stdout } = await exec(process.execPath, [cli, 'ossie', ...args, '--json']);
  return JSON.parse(stdout);
}

describe.skipIf(!warehouseEnabled('duckdb'))(
  'Ossie export/import native round trip — DuckDB',
  () => {
    let harness: WarehouseTestHarness;
    beforeAll(async () => {
      harness = createDuckDbHarness();
      await harness.setup();
    });
    afterAll(async () => {
      await harness?.teardown();
    });
    it('returns to native source/models, keeps SQL and executes the existing project', async () => {
      // Exercise an inlined model between the source and the materialized chain.
      const stagePath = join(harness.projectDir, 'models/stg_orders.yml');
      const stage = await readFile(stagePath, 'utf8');
      await writeFile(
        join(harness.projectDir, 'models/inline_orders.yml'),
        stage
          .replace('name: stg_orders', 'name: inline_orders')
          .replace('type: view', 'type: ephemeral')
      );
      await writeFile(stagePath, stage.replace('ref: duckdb.orders', 'ref: inline_orders'));
      const before = await compileProject(harness.projectDir);
      expect(before.ok).toBe(true);
      const paths = [
        'sources/orders.yml',
        'models/stg_orders.yml',
        'models/order_summary.yml',
        'models/fct_orders.yml',
        'models/inline_orders.yml',
      ];
      const exportFile = join(harness.projectDir, 'exchange.ossie.yml');
      const exported = await convert([
        'export',
        'source:duckdb.orders',
        'model:stg_orders',
        'model:order_summary',
        'model:fct_orders',
        'model:inline_orders',
        '--name',
        'orders',
        '--ossie-version',
        '0.2.0.dev0',
        '--project',
        harness.projectDir,
        '--out',
        exportFile,
      ]);
      expect(exported.diagnostics).toEqual([]);
      expect(exported.ok).toBe(true);
      expect(exported.files[0].document.datasets).toHaveLength(5);
      const imported = await convert([
        'import',
        exportFile,
        '--out',
        join(harness.projectDir, 'converted'),
      ]);
      expect(imported.ready).toBe(true);
      expect(
        imported.files.filter((f: { document: { type: string } }) => f.document.type === 'model')
      ).toHaveLength(4);
      await rm(exportFile);
      for (const path of paths) await rm(join(harness.projectDir, path));
      const after = await compileProject(harness.projectDir);
      expect(after.ok).toBe(true);
      const sql = (r: typeof before) =>
        r.byIntegration.flatMap((g) => g.results.map((e) => (e.ok ? e.sql : e.error)));
      expect(sql(after)).toEqual(sql(before));
      await runMaterializationProject(harness);
      expect(await harness.getObjectType('main.stg_orders')).toBe('VIEW');
      expect(await harness.getRowCount('main.order_summary')).toBe(3);
      expect(await harness.getRowCount('main.fct_orders')).toBe(3);
      expect(await harness.getObjectType('main.inline_orders')).toBeNull();
      const rows = await harness.runner.query!(
        'SELECT order_id, customer_id, order_total FROM main.fct_orders ORDER BY order_id'
      );
      expect(rows).toEqual([
        { order_id: 1, customer_id: 10, order_total: 50 },
        { order_id: 2, customer_id: 20, order_total: 75 },
        { order_id: 3, customer_id: 30, order_total: 125 },
      ]);
    });
  }
);
