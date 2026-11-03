import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileProject, loadProject, validateProject } from '../../../src/api/index.js';
import { fetchBigQueryColumns } from '../../../src/api/bigquery-catalog.js';
import { buildViewExistsQuery } from '../../../src/api/view-write-verify.js';
import { quoteColumnAlias, quoteIdentifier } from '../../../src/compiler/dialect.js';
import { TransformSpecSchema, WarehouseTableSourceSchema } from '../../../src/compiler/schemas.js';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-database-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

const INTEGRATIONS = {
  bigquery: `source_type: bigquery
connection:
  project_id: source-project
  dataset: analytics
auth:
  type: adc
`,
  snowflake: `source_type: snowflake
connection:
  account_identifier: demo
  warehouse: DEMO_WH
  role: DEMO_ROLE
  database: DEMO_DB
  schema: ANALYTICS
auth:
  type: pat
  token: \${{ env.SNOWFLAKE_TOKEN }}
auth_env_vars: [SNOWFLAKE_TOKEN]
`,
};

async function writeProject(
  dialect: keyof typeof INTEGRATIONS,
  targetDatabase: string,
  field: 'target_database' | 'publish' = 'target_database',
  sourceTable = 'raw.orders'
): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, `${dialect}-`));
  await writeFile(
    path.join(projectDir, 'integrations', 'wh.yml'),
    `spec_version: '1'\ntype: integration\nname: wh\n${INTEGRATIONS[dialect]}`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_orders.yml'),
    `spec_version: '0.2'
name: raw_orders
type: source
source_type: warehouse_table
connection: wh
table: ${JSON.stringify(sourceTable)}
schema:
  columns:
    - { name: order_id, type: STRING }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'post_counts.yml'),
    `spec_version: '0.2'
name: post_counts
type: model
description: Orders copy.
grain: order_id
${
  field === 'publish'
    ? `publish:\n  target: wh\n  target_database: ${JSON.stringify(targetDatabase)}`
    : `target_database: ${targetDatabase}`
}
source:
  ref: wh.raw_orders
columns:
  - { name: order_id, expr: wh.raw_orders.order_id, type: STRING }
materialization:
  type: table
`
  );
  return projectDir;
}

const base = {
  spec_version: '0.2' as const,
  name: 'my_model',
  type: 'model' as const,
  description: 'test model',
  grain: 'id',
  source: { ref: 'ecom.raw_orders' },
  columns: [{ name: 'id', expr: 'ID' }],
  materialization: { type: 'view' as const },
};

describe('model target_database identifiers', () => {
  it.each(['analytics-dev', 'analytics--dev', 'my-project-123', 'prod_db', 'a-b_c-9'])(
    'accepts %s in the model schema',
    (targetDatabase) => {
      expect(
        TransformSpecSchema.safeParse({ ...base, target_database: targetDatabase }).success
      ).toBe(true);
    }
  );

  it.each([
    'proj`; DROP TABLE x; --',
    'proj`x',
    "proj'x",
    'proj"x',
    'proj;x',
    'proj x',
    'proj\tx',
    'proj.x',
    'proj:x',
    '-proj',
    'proj-',
    'proj--',
    '123proj',
  ])('rejects hostile or malformed value %j', (targetDatabase) => {
    expect(
      TransformSpecSchema.safeParse({ ...base, target_database: targetDatabase }).success
    ).toBe(false);
  });

  it('keeps target_schema hyphen-free', () => {
    expect(TransformSpecSchema.safeParse({ ...base, target_schema: 'analytics-dev' }).success).toBe(
      false
    );
  });

  it.each(['analytics-dev', 'analytics--dev'])(
    'validates and compiles BigQuery project %s to backtick-quoted SQL',
    async (targetDatabase) => {
      const projectDir = await writeProject('bigquery', targetDatabase);
      const validation = await validateProject(projectDir, {
        project: await loadProject(projectDir),
      });
      expect(validation.ok).toBe(true);
      const compiled = await compileProject(projectDir);
      expect(compiled.ok).toBe(true);
      const sql = JSON.stringify(compiled.byIntegration[0]!.results);
      expect(sql).toContain(`\`${targetDatabase}\`.\`analytics\`.\`post_counts\``);
      expect(sql).not.toMatch(new RegExp(`(?<!\`)${targetDatabase}(?!\`)`));
    }
  );

  it('keeps hyphens rejected for other dialects at validation', async () => {
    const projectDir = await writeProject('snowflake', 'analytics-dev');
    const error: unknown = await validateProject(projectDir, {
      project: await loadProject(projectDir),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: 'validation',
      cause: { message: expect.stringContaining('only BigQuery project ids may contain hyphens') },
    });
  });

  it('keeps underscore databases working for other dialects', async () => {
    const projectDir = await writeProject('snowflake', 'analytics_dev');
    const compiled = await compileProject(projectDir);
    expect(compiled.ok).toBe(true);
    expect(JSON.stringify(compiled.byIntegration[0]!.results)).toContain(
      '\\"ANALYTICS_DEV\\".\\"ANALYTICS\\".\\"POST_COUNTS\\"'
    );
  });
});

const PUBLISH_REPRO =
  'x` AS SELECT 1 AS a; DROP TABLE t; SELECT 1 FROM UNNEST([1]) WHERE 1 IN ( --';

describe('publish.target_database identifiers', () => {
  it.each([PUBLISH_REPRO, 'x\\` AS SELECT 1 AS a; DROP TABLE t; --', 'proj\nx', 'proj.ds', 'a b'])(
    'rejects %j in the model schema',
    (targetDatabase) => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        publish: { target: 'wh', target_database: targetDatabase },
      });
      expect(result.success).toBe(false);
    }
  );

  it('rejects the hostile publish value at load, before any SQL is generated', async () => {
    const projectDir = await writeProject('bigquery', PUBLISH_REPRO, 'publish');
    const error: unknown = await compileProject(projectDir).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'validation' });
    expect(JSON.stringify(error)).not.toContain('DROP TABLE t; SELECT');
  });

  it.each(['analytics-dev', 'analytics--dev'])(
    'compiles BigQuery publish project %s to backtick-quoted SQL',
    async (targetDatabase) => {
      const projectDir = await writeProject('bigquery', targetDatabase, 'publish');
      const compiled = await compileProject(projectDir);
      expect(compiled.ok).toBe(true);
      const sql = JSON.stringify(compiled.byIntegration[0]!.results);
      expect(sql).toContain(`\`${targetDatabase}\`.\`analytics\`.\`post_counts\``);
      expect(sql).not.toMatch(new RegExp(`(?<!\`)${targetDatabase}(?!\`)`));
    }
  );

  it('rejects a hyphenated publish database for other dialects', async () => {
    const projectDir = await writeProject('snowflake', 'analytics-dev', 'publish');
    await expect(compileProject(projectDir)).rejects.toThrow(
      'sets `publish.target_database` to "analytics-dev", but only BigQuery project ids'
    );
  });
});

describe('backtick identifier quoting', () => {
  it.each(['bigquery', 'databricks', 'mysql', 'clickhouse'] as const)(
    'rejects backslashes and control characters for %s',
    (dialect) => {
      for (const value of ['x\\', 'x\\` AS SELECT 1; --', 'a\nb', 'a\rb', 'a\u0000b']) {
        expect(() => quoteIdentifier(value, dialect)).toThrow(
          'backslashes and control characters are not allowed'
        );
        expect(() => quoteColumnAlias(`Mixed${value}`, dialect)).toThrow(
          'backslashes and control characters are not allowed'
        );
      }
    }
  );

  it('rejects backticks for BigQuery and keeps doubling for other backtick dialects', () => {
    expect(() => quoteIdentifier('a`b', 'bigquery')).toThrow('cannot contain backticks');
    expect(quoteIdentifier('a`b', 'databricks')).toBe('`a``b`');
    expect(quoteIdentifier('analytics-dev', 'bigquery')).toBe('`analytics-dev`');
  });

  it('leaves double-quote dialects unchanged', () => {
    expect(quoteIdentifier('a"b', 'snowflake')).toBe('"A""B"');
    expect(quoteIdentifier('a"b', 'postgres')).toBe('"a""b"');
  });
});

const SOURCE_TABLE_REPRO = '`p`.`d\\`.`) ; DROP TABLE t; --`';

describe('warehouse source table identifiers', () => {
  it.each([
    ['backtick', SOURCE_TABLE_REPRO],
    ['double-quote', '"p"."d\\"."x"'],
  ])(
    'rejects a backslash in a %s-quoted source table before SQL generation',
    async (_style, table) => {
      const source = {
        spec_version: '0.2',
        name: 'raw_orders',
        type: 'source',
        source_type: 'warehouse_table',
        connection: 'wh',
        table,
        schema: { columns: [{ name: 'order_id', type: 'STRING' }] },
      };
      const parsed = WarehouseTableSourceSchema.safeParse(source);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('Must be a dotted identifier');
      const projectDir = await writeProject('bigquery', 'analytics_dev', 'target_database', table);
      const compiled = await compileProject(projectDir);
      expect(compiled.ok).toBe(false);
      expect(JSON.stringify(compiled)).not.toContain('DROP TABLE');
    }
  );

  it('still compiles a backtick-quoted hyphenated BigQuery source project', async () => {
    const projectDir = await writeProject(
      'bigquery',
      'analytics_dev',
      'target_database',
      '`my-proj`.raw.orders'
    );
    const compiled = await compileProject(projectDir);
    expect(compiled.ok).toBe(true);
    expect(JSON.stringify(compiled.byIntegration[0]!.results)).toContain('`my-proj`.raw.orders');
  });

  it('rejects hostile BigQuery catalog paths before querying', async () => {
    const query = async () => [];
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return query();
    };
    await expect(
      fetchBigQueryColumns(counting, { project: 'p', dataset: 'd\\', table: 't' })
    ).rejects.toThrow('backslashes and control characters are not allowed');
    await expect(
      fetchBigQueryColumns(counting, { project: 'p', dataset: 'd`x', table: 't' })
    ).rejects.toThrow('backticks are not allowed');
    expect(calls).toBe(0);
  });

  it('rejects hostile BigQuery view verification paths', () => {
    expect(() => buildViewExistsQuery('bigquery', 'd\\', 'p', 'v')).toThrow(
      'backslashes and control characters are not allowed'
    );
    expect(buildViewExistsQuery('bigquery', 'analytics', 'analytics-dev', 'v')).toContain(
      '`analytics-dev.analytics.INFORMATION_SCHEMA.VIEWS`'
    );
  });
});
