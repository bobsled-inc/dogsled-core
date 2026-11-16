import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { queryResource } from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import { runProject } from '@bobsled-inc/model-spec/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishCrossWarehouse } from '../../../src/runtime/cross-warehouse.js';

import type { DuckDbIntegration } from '@bobsled-inc/connections';

// Stage an api_resource leaf without hitting a real API: the publisher imports
// these two functions directly, so mock them at the module boundary.
vi.mock('@bobsled-inc/extractor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bobsled-inc/extractor')>()),
  queryResource: vi.fn(),
}));
vi.mock('@bobsled-inc/integrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bobsled-inc/integrations')>()),
  loadQueryableResourceSpecs: vi.fn(),
}));

const queryResourceMock = vi.mocked(queryResource);
const loadQueryableResourceSpecsMock = vi.mocked(loadQueryableResourceSpecs);

let tmpDir = '';

function duckIntegration(name: string, dbPath: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath, read_only: false },
  };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function seedDuckDb(integration: DuckDbIntegration, sql: string[]): Promise<void> {
  const runner = await buildDuckDbRunner(integration);
  try {
    for (const statement of sql) {
      await runner.run(statement);
    }
  } finally {
    await runner.close?.();
  }
}

async function queryDuckDb(
  integration: DuckDbIntegration,
  sql: string
): Promise<Record<string, unknown>[]> {
  const runner = await buildDuckDbRunner(integration);
  try {
    return await runner.query!(sql);
  } finally {
    await runner.close?.();
  }
}

describe('publishCrossWarehouse — api_resource staging', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-xwh-api-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
    vi.clearAllMocks();
  });

  it('stages a live/lazy api_resource leaf into the publish target alongside a warehouse leaf', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      apiCache: path.join(tmpDir, 'api_cache.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id INTEGER, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com'), (2, 'b@example.com')",
    ]);

    const projectDir = path.join(tmpDir, 'project');
    await writeFile(
      path.join(projectDir, 'integrations', 'crm.yml'),
      `spec_version: '1'\ntype: integration\nname: crm\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(paths.crm)}\n`
    );
    // Declared only so validateSourceIntegrationRefs is satisfied; the api leaf
    // is fetched via queryResource, so this runner is never opened.
    await writeFile(
      path.join(projectDir, 'integrations', 'api_cache.yml'),
      `spec_version: '1'\ntype: integration\nname: api_cache\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(paths.apiCache)}\n`
    );
    await writeFile(
      path.join(projectDir, 'integrations', 'mart.yml'),
      `spec_version: '1'\ntype: integration\nname: mart\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(paths.mart)}\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'customers.yml'),
      `spec_version: '0.2'\nname: customers\ntype: source\nsource_type: warehouse_table\nconnection: crm\ntable: main.customers\nschema:\n  columns:\n    - { name: customer_id, type: integer, primary_key: true }\n    - { name: email, type: string }\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'signups.yml'),
      `spec_version: '0.2'\nname: signups\ntype: source\nsource_type: api_resource\nconnection: api_cache\nintegration: some_api\nresource: signups\nmode: lazy\nschema:\n  columns:\n    - { name: signup_id, type: integer, primary_key: true }\n    - { name: customer_id, type: integer }\n`
    );
    await writeFile(
      path.join(projectDir, 'models', 'customer_signups.yml'),
      `spec_version: '0.2'\nname: customer_signups\ntype: model\ndescription: Mixed model joining a warehouse leaf and an api_resource leaf.\ngrain: customer_id\npublish: mart\nsource:\n  ref: crm.customers\njoins:\n  - ref: api_cache.signups\n    type: inner\n    on: crm.customers.customer_id = api_cache.signups.customer_id\ncolumns:\n  - { name: customer_id, expr: crm.customers.customer_id, type: integer, primary_key: true }\n  - { name: email, expr: crm.customers.email, type: string }\n  - { name: signup_id, expr: api_cache.signups.signup_id, type: integer }\nmaterialization:\n  type: table\n`
    );

    loadQueryableResourceSpecsMock.mockReturnValue({ integration: {}, resource: {} } as never);
    queryResourceMock.mockResolvedValue({
      records: [
        { signup_id: 100, customer_id: 1 },
        { signup_id: 200, customer_id: 2 },
      ],
      limitReached: false,
    } as never);

    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });

    expect(result.ok).toBe(true);
    expect(queryResourceMock).toHaveBeenCalledTimes(1);
    // CAST to INTEGER so the DuckDB driver returns numbers, not bigints.
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT CAST(customer_id AS INTEGER) AS customer_id, email, CAST(signup_id AS INTEGER) AS signup_id FROM main.customer_signups ORDER BY customer_id'
      )
    ).resolves.toEqual([
      { customer_id: 1, email: 'a@example.com', signup_id: 100 },
      { customer_id: 2, email: 'b@example.com', signup_id: 200 },
    ]);
  });

  it('routes a mixed model declared via execution.engine (no publish:) through the staging path', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      apiCache: path.join(tmpDir, 'api_cache.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id INTEGER, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com')",
    ]);

    const projectDir = path.join(tmpDir, 'project');
    for (const [name, p] of [
      ['crm', paths.crm],
      ['api_cache', paths.apiCache],
      ['mart', paths.mart],
    ] as const) {
      await writeFile(
        path.join(projectDir, 'integrations', `${name}.yml`),
        `spec_version: '1'\ntype: integration\nname: ${name}\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: ${JSON.stringify(p)}\n`
      );
    }
    await writeFile(
      path.join(projectDir, 'sources', 'customers.yml'),
      `spec_version: '0.2'\nname: customers\ntype: source\nsource_type: warehouse_table\nconnection: crm\ntable: main.customers\nschema:\n  columns:\n    - { name: customer_id, type: integer, primary_key: true }\n    - { name: email, type: string }\n`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'signups.yml'),
      `spec_version: '0.2'\nname: signups\ntype: source\nsource_type: api_resource\nconnection: api_cache\nintegration: some_api\nresource: signups\nmode: lazy\nschema:\n  columns:\n    - { name: signup_id, type: integer, primary_key: true }\n    - { name: customer_id, type: integer }\n`
    );
    // execution.engine instead of publish: — the engine is the co-location point.
    await writeFile(
      path.join(projectDir, 'models', 'customer_signups.yml'),
      `spec_version: '0.2'\nname: customer_signups\ntype: model\ndescription: Mixed model routed via execution.engine.\ngrain: customer_id\nexecution:\n  engine: mart\nsource:\n  ref: crm.customers\njoins:\n  - ref: api_cache.signups\n    type: inner\n    on: crm.customers.customer_id = api_cache.signups.customer_id\ncolumns:\n  - { name: customer_id, expr: crm.customers.customer_id, type: integer, primary_key: true }\n  - { name: email, expr: crm.customers.email, type: string }\n  - { name: signup_id, expr: api_cache.signups.signup_id, type: integer }\nmaterialization:\n  type: table\n`
    );

    loadQueryableResourceSpecsMock.mockReturnValue({ integration: {}, resource: {} } as never);
    queryResourceMock.mockResolvedValue({
      records: [{ signup_id: 100, customer_id: 1 }],
      limitReached: false,
    } as never);

    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });

    expect(result.ok).toBe(true);
    expect(queryResourceMock).toHaveBeenCalledTimes(1);
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT CAST(customer_id AS INTEGER) AS customer_id, email, CAST(signup_id AS INTEGER) AS signup_id FROM main.customer_signups'
      )
    ).resolves.toEqual([{ customer_id: 1, email: 'a@example.com', signup_id: 100 }]);
  });
});
