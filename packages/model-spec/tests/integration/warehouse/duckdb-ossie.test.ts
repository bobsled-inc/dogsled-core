import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { compileProject } from '../../../src/api/compile-project.js';
import { SourceSpecSchema, TransformSpecSchema } from '../../../src/compiler/schemas.js';
import { logicalTypeForSqlType } from '../../../src/ossie/index.js';
import {
  createDuckDbHarness,
  runMaterializationProject,
  type WarehouseTestHarness,
} from './harness.js';
import { warehouseEnabled } from './setup.js';

const extension = (data: object) => [{ vendor_name: 'BOBSLED', data: JSON.stringify(data) }];
const expression = (name: string) => ({ dialects: [{ dialect: 'ANSI_SQL', expression: name }] });

describe.skipIf(!warehouseEnabled('duckdb'))('Ossie mixed project — DuckDB execution', () => {
  let harness: WarehouseTestHarness;
  beforeAll(async () => {
    harness = createDuckDbHarness();
    await harness.setup();
  });
  afterAll(async () => {
    await harness?.teardown();
  });
  it('compiles equivalent SQL and executes view, table and incremental models', async () => {
    const original = await compileProject(harness.projectDir);
    expect(original.ok).toBe(true);
    const sourcePath = join(harness.projectDir, 'sources/orders.yml');
    const modelPath = join(harness.projectDir, 'models/stg_orders.yml');
    const source = SourceSpecSchema.parse(parse(await readFile(sourcePath, 'utf8')));
    if (source.source_type === 'api_resource') throw new Error('Expected warehouse source');
    const model = TransformSpecSchema.parse(parse(await readFile(modelPath, 'utf8')));
    await writeFile(
      join(harness.projectDir, 'semantic.yml'),
      stringify({
        version: '0.2.0.dev0',
        name: 'orders_semantics',
        datasets: [
          {
            name: source.name,
            description: source.description,
            source: source.table,
            fields: source.schema.columns.map((column) => ({
              name: column.name,
              datatype: logicalTypeForSqlType(column.type),
              expression: expression(column.name),
              custom_extensions: extension({ sql_type: column.type }),
            })),
            custom_extensions: extension({
              extension_version: '1',
              kind: 'source',
              connection: source.connection,
            }),
          },
          {
            name: model.name,
            description: model.description,
            source: `main.${model.name}`,
            fields: model.columns.map((column) => ({
              name: column.name,
              expression: expression(column.name),
              custom_extensions: extension({ build_expression: column.expr }),
            })),
            custom_extensions: extension({
              extension_version: '1',
              kind: 'derived',
              grain: model.grain,
              build: {
                source: model.source,
                materialization: model.materialization,
                target_schema: model.target_schema,
              },
            }),
          },
        ],
      })
    );
    await rm(sourcePath);
    await rm(modelPath);
    const translated = await compileProject(harness.projectDir);
    expect(translated.ok).toBe(true);
    const sql = (result: typeof original) =>
      result.byIntegration.flatMap((group) =>
        group.results.map((entry) => (entry.ok ? entry.sql : entry.error))
      );
    expect(sql(translated)).toEqual(sql(original));
    await runMaterializationProject(harness);
    expect(await harness.getObjectType('main.stg_orders')).toBe('VIEW');
    expect(await harness.getRowCount('main.order_summary')).toBe(3);
    expect(await harness.getRowCount('main.fct_orders')).toBe(3);
  });
});
