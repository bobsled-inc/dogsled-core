import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BobsledRuntimeError } from '@bobsled-inc/protocol';
import { loadProject, runProject, validateProject } from '../../src/api/index.js';

let tmpDir = '';

async function expectLoadFailure(projectDir: string, message: RegExp): Promise<void> {
  const error = await loadProject(projectDir).catch((value) => value as BobsledRuntimeError);
  expect(error).toMatchObject({
    kind: 'validation',
    message: 'Dogsled could not validate the request.',
  });
  expect(error.cause?.message).toMatch(message);
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeBaseProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'project-'));
  await writeFile(
    path.join(projectDir, 'integrations', 'crm.yml'),
    `spec_version: '1'
type: integration
name: crm
source_type: duckdb
connection: {}
auth:
  type: file
  path: ${JSON.stringify(path.join(projectDir, 'crm.duckdb'))}
`
  );
  await writeFile(
    path.join(projectDir, 'integrations', 'orders.yml'),
    `spec_version: '1'
type: integration
name: orders
source_type: duckdb
connection: {}
auth:
  type: file
  path: ${JSON.stringify(path.join(projectDir, 'orders.duckdb'))}
`
  );
  await writeFile(
    path.join(projectDir, 'integrations', 'mart.yml'),
    `spec_version: '1'
type: integration
name: mart
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(path.join(projectDir, 'mart.duckdb'))}
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'customers.yml'),
    `spec_version: '0.2'
name: customers
type: source
source_type: warehouse_table
connection: crm
table: main.customers
schema:
  columns:
    - { name: customer_id, type: integer, primary_key: true }
    - { name: email, type: string }
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'orders.yml'),
    `spec_version: '0.2'
name: orders
type: source
source_type: warehouse_table
connection: orders
table: main.orders
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
    - { name: amount, type: number }
`
  );
  return projectDir;
}

async function writePublishedModel(projectDir: string, materialization = 'table'): Promise<void> {
  await writeFile(
    path.join(projectDir, 'models', 'customer_orders.yml'),
    `spec_version: '0.2'
name: customer_orders
type: model
description: Cross-warehouse customer order mart.
grain: order_id
publish: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.orders.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: orders.orders.amount, type: number }
materialization:
  type: ${materialization}
`
  );
}

describe('cross-warehouse publish planning', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-xwh-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('stamps publish models to the publish integration and validates them with full source registry', async () => {
    const projectDir = await writeBaseProject();
    await writePublishedModel(projectDir);

    const project = await loadProject(projectDir);
    expect(project.models.find((model) => model.name === 'customer_orders')?.integration).toBe(
      'mart'
    );

    const result = await validateProject(projectDir, { project });
    expect(result.ok).toBe(true);
    expect(result.byIntegration.map((entry) => entry.handle)).toEqual(['mart']);
  });

  it('supports publish object form with target schema and database overrides', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'models', 'customer_orders.yml'),
      `spec_version: '0.2'
name: customer_orders
type: model
description: Cross-warehouse customer order mart.
grain: order_id
publish:
  target: mart
  target_schema: analytics
  target_database: reporting
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.orders.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: orders.orders.amount, type: number }
materialization:
  type: table
`
    );

    let capturedTargetSchema: string | undefined;
    let capturedTargetDatabase: string | undefined;
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: async (model) => {
        capturedTargetSchema = model.targetSchema;
        capturedTargetDatabase = model.targetDatabase;
        return {
          executionResult: { modelName: 'customer_orders', status: 'success' },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.byIntegration[0]).toMatchObject({
      handle: 'mart',
      models: [{ name: 'customer_orders', materializationType: 'table' }],
    });
    expect(capturedTargetSchema).toBe('analytics');
    expect(capturedTargetDatabase).toBe('reporting');
  });

  it('forwards the managed token provider to cross-warehouse publishing', async () => {
    const projectDir = await writeBaseProject();
    await writePublishedModel(projectDir);
    const tokenProvider = vi.fn(async () => ({
      accessToken: 'managed-token',
      expiresAt: 3_600,
    }));
    let capturedTokenProvider: unknown;

    const result = await runProject(projectDir, {
      integration: 'mart',
      tokenProvider,
      crossWarehousePublisher: async (_model, context) => {
        capturedTokenProvider = context.tokenProvider;
        return {
          executionResult: { modelName: 'customer_orders', status: 'success' },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedTokenProvider).toBe(tokenProvider);
  });

  it('rejects zero-data-movement publish materializations', async () => {
    const projectDir = await writeBaseProject();
    await writePublishedModel(projectDir, 'view');

    await expectLoadFailure(
      projectDir,
      /publish: supports materialization\.type: table, incremental, or snapshot/
    );
  });

  it('accepts incremental and snapshot publish models', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'models', 'customer_orders.yml'),
      `spec_version: '0.2'
name: customer_orders
type: model
description: Cross-warehouse customer order mart.
grain: order_id
publish: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.orders.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: orders.orders.amount, type: number }
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  cursor_field: order_id
`
    );

    await expect(loadProject(projectDir)).resolves.toMatchObject({
      models: [
        expect.objectContaining({ name: 'customer_orders', materialization: 'incremental' }),
      ],
    });

    await writeFile(
      path.join(projectDir, 'models', 'customer_orders.yml'),
      `spec_version: '0.2'
name: customer_orders
type: model
description: Cross-warehouse customer order snapshot.
grain: order_id
publish: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.orders.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: orders.orders.amount, type: number }
materialization:
  type: snapshot
  unique_key: order_id
`
    );
    await expect(loadProject(projectDir)).resolves.toMatchObject({
      models: [expect.objectContaining({ name: 'customer_orders', materialization: 'snapshot' })],
    });
  });

  it('requires hosts to inject a publisher before executing publish models', async () => {
    const projectDir = await writeBaseProject();
    await writePublishedModel(projectDir);

    await expect(runProject(projectDir, { integration: 'mart' })).rejects.toThrow(
      /cross-warehouse models require a publisher/
    );
  });

  it('skips published models when an upstream model failed planning', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'sources', 'seed.yml'),
      `spec_version: '0.2'
name: seed
type: source
source_type: warehouse_table
connection: mart
table: main.seed
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
    - { name: amount, type: number }
`
    );
    await writeFile(
      path.join(projectDir, 'models', 'mart_seed.yml'),
      `spec_version: '0.2'
name: mart_seed
type: model
description: Seeded mart model.
grain: order_id
source:
  ref: mart.seed
columns:
  - { name: order_id, expr: mart.seed.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: mart.seed.customer_id, type: integer }
  - { name: amount, expr: mart.seed.amount, type: number }
materialization:
  type: table
`
    );
    await writeFile(
      path.join(projectDir, 'models', 'customer_orders.yml'),
      `spec_version: '0.2'
name: customer_orders
type: model
description: Published model with a local upstream dependency.
grain: order_id
publish: mart
source:
  ref: mart_seed
joins:
  - ref: crm.customers
    type: left
    on: mart_seed.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: mart_seed.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: mart_seed.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: mart_seed.amount, type: number }
materialization:
  type: table
`
    );
    await writeFile(
      path.join(projectDir, '.dogsled/model-spec', 'run-state.json'),
      JSON.stringify(
        {
          models: {
            'mart.mart_seed': {
              lastRunAt: '2026-05-01T00:00:00.000Z',
              materialization: 'snapshot',
              specChecksum: 'previous',
            },
          },
        },
        null,
        2
      )
    );

    const publisher = vi.fn(async () => ({
      executionResult: { modelName: 'customer_orders', status: 'success' as const },
    }));
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publisher,
    });

    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
    expect(result.byIntegration[0]?.executionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelName: 'mart_seed', status: 'failed' }),
        expect.objectContaining({ modelName: 'customer_orders', status: 'skipped' }),
      ])
    );
  });

  it('threads recreate preDdl through to the publisher so prior type drops run on the destination', async () => {
    const projectDir = await writeBaseProject();
    await writePublishedModel(projectDir, 'table');

    // Synthesize prior state showing the published model existed as a `view`
    // on `mart`. `planTransition` should return kind: 'recreate' carrying a
    // DROP VIEW preDdl that the publisher must execute against the
    // destination warehouse before the new CREATE TABLE materialization runs.
    await writeFile(
      path.join(projectDir, '.dogsled/model-spec', 'run-state.json'),
      JSON.stringify({
        models: {
          'mart.customer_orders': {
            lastRunAt: '2026-05-01T00:00:00.000Z',
            materialization: 'view',
            specChecksum: 'previous',
            selectSignature: 'previous',
            columns: [],
          },
        },
      })
    );

    let capturedPreDdl: string[] | undefined;
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: async (model) => {
        capturedPreDdl = model.preDdl;
        return {
          executionResult: { modelName: model.node.name, status: 'success' },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedPreDdl).toBeDefined();
    expect(capturedPreDdl?.length).toBe(1);
    expect(capturedPreDdl?.[0]).toMatch(/^DROP VIEW IF EXISTS .*customer_orders/i);
  });

  it('leaves preDdl undefined when planTransition returns proceed (no prior materialization)', async () => {
    const projectDir = await writeBaseProject();
    await writePublishedModel(projectDir, 'table');

    let capturedPreDdl: string[] | undefined;
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: async (model) => {
        capturedPreDdl = model.preDdl;
        return {
          executionResult: { modelName: model.node.name, status: 'success' },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedPreDdl).toBeUndefined();
  });

  it('rejects oauth source auth on a published model (token TTL cannot cover long publishes)', async () => {
    const projectDir = await writeBaseProject();
    // Override the orders integration to use Snowflake + OAuth — this is the
    // realistic scenario where a customer points a Snowflake source at a
    // published model and would otherwise hit token expiry mid-publish.
    await writeFile(
      path.join(projectDir, 'integrations', 'orders.yml'),
      `spec_version: '1'
type: integration
name: orders
source_type: snowflake
connection:
  account_identifier: acct
  user: u
  warehouse: w
  database: d
  schema: s
  role: r
auth:
  type: oauth
  client_id: cid
  client_secret: secret
  token_url: https://example.com/oauth/token
`
    );
    // Rewrite the source to be a snowflake warehouse_table (matches new integration).
    await writeFile(
      path.join(projectDir, 'sources', 'orders.yml'),
      `spec_version: '0.2'
name: orders
type: source
source_type: warehouse_table
connection: orders
table: D.S.ORDERS
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
    - { name: amount, type: number }
`
    );
    await writePublishedModel(projectDir);

    await expectLoadFailure(projectDir, /uses oauth auth.*OAuth tokens have short TTLs/);
  });

  it('rejects oauth_m2m source auth on a published model', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'integrations', 'orders.yml'),
      `spec_version: '1'
type: integration
name: orders
source_type: databricks
connection:
  workspace_url: https://workspace.cloud.databricks.com
  http_path: /sql/1.0/warehouses/abc
  catalog: main
  schema: raw
auth:
  type: oauth_m2m
  client_id: cid
  client_secret: secret
`
    );
    await writeFile(
      path.join(projectDir, 'sources', 'orders.yml'),
      `spec_version: '0.2'
name: orders
type: source
source_type: warehouse_table
connection: orders
table: main.raw.orders
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
    - { name: amount, type: number }
`
    );
    await writePublishedModel(projectDir);

    await expectLoadFailure(projectDir, /uses oauth_m2m auth.*Use pat auth for Databricks sources/);
  });

  it('allows an oauth-authed api_resource leaf on a published model (carve-out)', async () => {
    const projectDir = await writeBaseProject();
    // The `orders` integration becomes Snowflake + OAuth — the api_resource
    // leaf below caches/destinations into it. A warehouse_table on this same
    // integration is rejected (see the test above); an api_resource leaf is a
    // short fetch-then-stage, so the OAuth-TTL rationale does not apply.
    await writeFile(
      path.join(projectDir, 'integrations', 'orders.yml'),
      `spec_version: '1'
type: integration
name: orders
source_type: snowflake
connection:
  account_identifier: acct
  user: u
  warehouse: w
  database: d
  schema: s
  role: r
auth:
  type: oauth
  client_id: cid
  client_secret: secret
  token_url: https://example.com/oauth/token
`
    );
    // Replace the orders warehouse source with an api_resource leaf whose
    // connection (cache destination) is the oauth snowflake integration.
    await writeFile(
      path.join(projectDir, 'sources', 'orders.yml'),
      `spec_version: '0.2'
name: signups
type: source
source_type: api_resource
connection: orders
integration: some_api
resource: signups
mode: lazy
schema:
  columns:
    - { name: signup_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
`
    );
    // Published model joining the warehouse customers + the api_resource signups.
    await writeFile(
      path.join(projectDir, 'models', 'customer_signups.yml'),
      `spec_version: '0.2'
name: customer_signups
type: model
description: Mixed model joining a warehouse source and an oauth api_resource leaf.
grain: signup_id
publish: mart
source:
  ref: orders.signups
joins:
  - ref: crm.customers
    type: left
    on: orders.signups.customer_id = crm.customers.customer_id
columns:
  - { name: signup_id, expr: orders.signups.signup_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.signups.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
materialization:
  type: table
`
    );

    // Pre-carve-out this rejected with the oauth-TTL error; the api_resource
    // leaf is now exempt, so the project loads.
    await expect(loadProject(projectDir)).resolves.toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ name: 'customer_signups' })]),
    });
  });

  it('rejects execution.engine pointing at an unknown integration handle', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'models', 'mixed.yml'),
      `spec_version: '0.2'
name: mixed
type: model
description: Mixed model with a bogus engine handle.
grain: order_id
execution:
  engine: ghost
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
materialization:
  type: view
`
    );
    await expectLoadFailure(
      projectDir,
      /execution\.engine: "ghost", but no integration with that handle exists/
    );
  });

  it('accepts a persisted execution.engine model on a mixed-handle graph', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'models', 'mixed.yml'),
      `spec_version: '0.2'
name: mixed
type: model
description: Mixed model materialized into the mart engine.
grain: order_id
execution:
  engine: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
materialization:
  type: table
`
    );
    await expect(loadProject(projectDir)).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ name: 'mixed', integration: 'mart' }),
      ]),
    });
  });

  it('rejects a non-persisted DuckDB-engine model over a foreign warehouse leaf without a live source', async () => {
    const projectDir = await writeBaseProject();
    await writeFile(
      path.join(projectDir, 'models', 'mixed.yml'),
      `spec_version: '0.2'
name: mixed
type: model
description: Live view over cross-warehouse sources, with no live source to stage it.
grain: order_id
execution:
  engine: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
materialization:
  type: view
`
    );
    await expectLoadFailure(
      projectDir,
      /needs a live\/lazy api_resource source|use materialization\.type: table/
    );
  });

  it('accepts a non-persisted DuckDB-engine model over a foreign warehouse leaf when a live source exists', async () => {
    const projectDir = await writeBaseProject();
    // A live api_resource source triggers the DuckDB-engine staging path.
    await writeFile(
      path.join(projectDir, 'sources', 'pings.yml'),
      `spec_version: '0.2'
name: pings
type: source
source_type: api_resource
integration: some_api
resource: pings
connection: mart
mode: live
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
`
    );
    await writeFile(
      path.join(projectDir, 'models', 'mixed.yml'),
      `spec_version: '0.2'
name: mixed
type: model
description: Live view joining an api source with a foreign warehouse leaf.
grain: order_id
execution:
  engine: mart
source:
  ref: mart.pings
joins:
  - ref: crm.customers
    type: left
    on: mart.pings.order_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: mart.pings.order_id, type: integer, primary_key: true }
materialization:
  type: view
`
    );
    await expect(loadProject(projectDir)).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ name: 'mixed', integration: 'mart' }),
      ]),
    });
  });
});
