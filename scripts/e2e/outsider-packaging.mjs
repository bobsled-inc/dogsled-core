import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliPath, command, context } from './harness.mjs';
import { postgres, postgresSql, stopServices } from './services.mjs';

const PACKAGE_PATH = ['node_modules', '@bobsled-inc', 'bobsled-core'];

export const globalPrefix = process.env.BOBSLED_CORE_E2E_GLOBAL_PREFIX ?? '/global';
export const userPgConsumer = process.env.BOBSLED_CORE_E2E_USER_PG_CONSUMER ?? '/consumer-pg';
export const userPgVersion = process.env.BOBSLED_CORE_E2E_USER_PG_VERSION;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function consumerCli(consumer) {
  return path.join(consumer, ...PACKAGE_PATH, 'bin', 'cli.mjs');
}

export function emptyPackageDirectories(nodeModules) {
  const empty = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(nodeModules, entry.name);
    const packages = entry.name.startsWith('@')
      ? readdirSync(directory, { withFileTypes: true })
          .filter((scoped) => scoped.isDirectory())
          .map((scoped) => path.join(directory, scoped.name))
      : [directory];
    for (const packageDirectory of packages) {
      if (readdirSync(packageDirectory).length === 0) empty.push(packageDirectory);
    }
  }
  return empty;
}

export async function verifyGlobalInstall(prefix = globalPrefix) {
  const installed = path.join(prefix, 'lib', ...PACKAGE_PATH);
  const empty = emptyPackageDirectories(path.join(installed, 'node_modules'));
  assert.deepEqual(empty, [], 'A global install left dependency folders empty');
  const ctx = await context('global-install');
  const bin = path.join(prefix, 'bin', 'bobsled');
  const run = (args, options = {}) =>
    command(bin, args, { cwd: ctx.project, env: ctx.env, ...options });
  try {
    const { version } = readJson(path.join(installed, 'package.json'));
    assert.equal((await run(['--version'])).stdout.trim(), version);
    await run(['init', 'shop', '--duckdb']);
    const shop = path.join(ctx.project, 'shop');
    await ctx.write(
      'shop/data/orders.csv',
      'order_id,customer,amount\n1,ada,120.50\n2,grace,80.00\n'
    );
    await ctx.write(
      'shop/integrations/local_files.yml',
      [
        "spec_version: '1'",
        'type: integration',
        'name: local_files',
        'source_type: local',
        'connection: { base_directory: data }',
        'auth: { type: none }',
        '',
      ].join('\n')
    );
    await ctx.write(
      'shop/resources/local_files/orders.yml',
      [
        "spec_version: '1'",
        'type: resource',
        'name: orders',
        'integration: local_files',
        'source: { path: orders.csv, format: csv, options: { header: true } }',
        'replication: { method: full_refresh }',
        'extract: { table: { primary_key: [order_id], load_strategy: full_refresh } }',
        'output:',
        '  order_id: { type: integer }',
        '  customer: { type: string }',
        '  amount: { type: number }',
        '',
      ].join('\n')
    );
    const extracted = await run(['extract', 'run', '--integration', 'local_files', 'orders'], {
      cwd: shop,
    });
    await run(['load', 'run', '--dest', 'duckdb', '--db-path', 'shop.duckdb'], {
      cwd: shop,
      input: extracted.stdout,
    });
    const result = await run(
      ['query', 'SELECT count(*) AS n FROM orders', '--db-path', 'shop.duckdb'],
      {
        cwd: shop,
      }
    );
    assert.equal(Number(JSON.parse(result.stdout).rows[0].n), 2);
    process.stdout.write(
      `Global install verified: dogsled ${version} on PATH extracted and loaded a CSV into DuckDB.\n`
    );
    await ctx.cleanup();
  } catch (error) {
    process.stderr.write(
      `Global install check failed; temporary project retained at ${ctx.project}\n`
    );
    throw error;
  }
}

export async function verifyShippedAssets(cli = cliPath) {
  const ctx = await context('shipped-assets');
  const run = (args, options = {}) =>
    command(process.execPath, [cli, ...args], { cwd: ctx.project, env: ctx.env, ...options });
  try {
    const listed = (await run(['examples', 'list'])).stdout;
    const examples = {
      demo: ['github', 'slack', 'notion', 'linear'],
      's3-documents-ingestion': ['s3_documents', 'gcs_documents'],
    };
    for (const [name, integrations] of Object.entries(examples)) {
      assert.match(listed, new RegExp(`^  ${name} `, 'm'), `dogsled examples list omits ${name}`);
      const init = await run(['examples', 'init', name]);
      assert.match(init.stdout, /See README\.md/);
      for (const integration of integrations) {
        await run(['extract', 'validate', integration], { cwd: path.join(ctx.project, name) });
      }
    }
    const demo = path.join(ctx.project, 'demo');
    for (const script of ['walkthrough.sh', 'duckdb-walkthrough.sh']) {
      assert.equal(
        statSync(path.join(demo, script)).mode & 0o111,
        0o111,
        `${script} is not executable`
      );
    }
    await run(['model', 'validate'], { cwd: demo });
    await run(['model', 'compile', '-o', 'compiled'], { cwd: demo });
    assert.ok(existsSync(path.join(demo, 'compiled/warehouse/STG_GITHUB_REPOS.sql')));

    const installed = JSON.parse(
      (await run(['setup', 'install', '--dir', 'repo', '--json'])).stdout
    );
    assert.ok(installed.copied.includes('.claude/plugins/bobsled-setup'));
    assert.ok(
      existsSync(
        path.join(ctx.project, 'repo/.claude/plugins/bobsled-setup/.claude-plugin/plugin.json')
      )
    );
    await run(['setup', 'export', '--format', 'dir', '--output', 'kit', '--json']);
    assert.ok(
      existsSync(path.join(ctx.project, 'kit/bobsled-setup-plugin/.claude-plugin/plugin.json'))
    );

    await run(['entity-graph', 'fixtures', 'copy', 'b2b-company-master', '--output', 'fixture']);
    for (const file of ['company_basic.yml', 'company_truthset.yml', 'data/company_truthset.csv']) {
      assert.ok(existsSync(path.join(ctx.project, 'fixture', file)), `fixture is missing ${file}`);
    }
    const sourceOnly = await run(['entity-graph', 'fixtures', 'copy', 'entity-resolution-sdk'], {
      expected: 1,
    });
    assert.match(sourceOnly.stderr, /available from a source checkout only/);
    process.stdout.write(
      'Shipped assets verified: examples list/init/validate/compile, setup install/export and entity-graph fixtures copy.\n'
    );
    await ctx.cleanup();
  } catch (error) {
    process.stderr.write(
      `Shipped asset check failed; temporary project retained at ${ctx.project}\n`
    );
    throw error;
  }
}

export function verifyUserPgInstall(consumer = userPgConsumer, version = userPgVersion) {
  assert.ok(
    version,
    'BOBSLED_CORE_E2E_USER_PG_VERSION must name the pg version the project installed'
  );
  assert.equal(readJson(path.join(consumer, 'node_modules/pg/package.json')).version, version);
  const nested = path.join(consumer, ...PACKAGE_PATH, 'node_modules', 'pg');
  assert.equal(existsSync(nested), false, `Dogsled installed a second pg at ${nested}`);
  const lock = readJson(path.join(consumer, 'package-lock.json'));
  for (const [location, info] of Object.entries(lock.packages)) {
    if (location.endsWith('/node_modules/pg')) {
      assert.notEqual(info.inBundle, true, `${location} is marked as bundled but is not shipped`);
    }
  }
  process.stdout.write(`A project's own pg ${version} is shared with Dogsled.\n`);
}

export async function verifyUserPgExtraction(consumer = userPgConsumer) {
  const port = await postgres();
  await postgresSql('DROP SCHEMA IF EXISTS user_pg CASCADE');
  await postgresSql('CREATE SCHEMA user_pg');
  await postgresSql(
    'CREATE TABLE user_pg.customers (id int PRIMARY KEY, name text, plan text, updated_at timestamptz)'
  );
  await postgresSql(
    "INSERT INTO user_pg.customers VALUES (1, 'Ada Labs', 'pro', now()), (2, 'Grace Corp', 'free', now()), (3, 'Linus Ltd', 'pro', now())"
  );
  const ctx = await context('user-pg');
  const cli = consumerCli(consumer);
  const run = (args, options = {}) =>
    command(process.execPath, [cli, ...args], { cwd: ctx.project, env: ctx.env, ...options });
  Object.assign(ctx.env, {
    APP_DB_HOST: '127.0.0.1',
    APP_DB_USER: 'postgres',
    APP_DB_PASSWORD: 'unused-local-only',
    BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
  });
  await ctx.write(
    'integrations/app_db.yml',
    [
      "spec_version: '1'",
      'type: integration',
      'name: app_db',
      'source_type: postgres',
      'auth_env_vars: [APP_DB_HOST, APP_DB_USER, APP_DB_PASSWORD]',
      'connection:',
      '  host_env: APP_DB_HOST',
      `  port: ${port}`,
      '  database: showcase',
      'auth:',
      '  type: password',
      '  username_env: APP_DB_USER',
      '  password_env: APP_DB_PASSWORD',
      '',
    ].join('\n')
  );
  await ctx.write(
    'resources/app_db/customers.yml',
    [
      "spec_version: '1'",
      'type: resource',
      'name: customers',
      'extract:',
      '  integration: app_db',
      '  source:',
      '    schema: user_pg',
      '    table: customers',
      '  replication:',
      '    method: full_refresh',
      'schema:',
      '  primary_key: [id]',
      '  columns:',
      '    id: { type: integer }',
      '    name: { type: string }',
      '    plan: { type: string }',
      '    updated_at: { type: timestamp }',
      '',
    ].join('\n')
  );
  try {
    const extracted = await run(['extract', 'run', '--integration', 'app_db', 'customers']);
    await run(['load', 'run', '--dest', 'duckdb', '--db-path', 'app.duckdb'], {
      input: extracted.stdout,
    });
    const result = await run([
      'query',
      'SELECT count(*) AS n FROM customers',
      '--db-path',
      'app.duckdb',
    ]);
    assert.equal(Number(JSON.parse(result.stdout).rows[0].n), 3);
    process.stdout.write(`PostgreSQL extraction works with the project's own pg.\n`);
    await ctx.cleanup();
  } catch (error) {
    process.stderr.write(
      `User pg extraction failed; temporary project retained at ${ctx.project}\n`
    );
    throw error;
  } finally {
    await postgresSql('DROP SCHEMA IF EXISTS user_pg CASCADE');
  }
}

const modes = {
  async install() {
    await verifyGlobalInstall();
    verifyUserPgInstall();
    await verifyShippedAssets();
  },
  async runtime() {
    try {
      await verifyUserPgExtraction();
    } finally {
      await stopServices();
    }
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = modes[process.argv[2]];
  if (!mode) throw new Error(`Usage: outsider-packaging.mjs <${Object.keys(modes).join('|')}>`);
  await mode();
}
