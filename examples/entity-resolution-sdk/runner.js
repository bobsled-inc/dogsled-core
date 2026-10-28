import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDuckDbRunner } from '@bobsled-inc/connections';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.ENTITY_RESOLUTION_EXAMPLE_DB_PATH ??
  path.join(ROOT_DIR, '.tmp', 'entity-resolution.duckdb');
const SEED_VERSION = 'entity-resolution-sdk-v1';

let runnerPromise;

async function openRunner() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  return buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'entity_resolution_sdk',
    source_type: 'duckdb',
    connection: { schema: 'entity_graph' },
    auth: { type: 'file', path: DB_PATH },
  });
}

function seededCount(row) {
  const value = row?.seeded_count ?? row?.SEEDED_COUNT ?? 0;
  return Number(value);
}

async function seedIfNeeded(runner) {
  await runner.run('CREATE SCHEMA IF NOT EXISTS entity_graph');
  await runner.run(
    'CREATE TABLE IF NOT EXISTS entity_graph.__seed_marker (seed_version VARCHAR PRIMARY KEY)'
  );
  const rows = await runner.query(
    'SELECT COUNT(*) AS seeded_count FROM entity_graph.__seed_marker WHERE seed_version = ?',
    [SEED_VERSION]
  );
  if (seededCount(rows[0]) > 0) return;

  const seedSql = await fs.readFile(path.join(ROOT_DIR, 'fixtures', 'seed.sql'), 'utf-8');
  for (const statement of seedSql
    .split(/;\s*(?:\n|$)/)
    .map((sql) => sql.trim())
    .filter(Boolean)) {
    await runner.run(statement);
  }
  await runner.query('INSERT INTO entity_graph.__seed_marker (seed_version) VALUES (?)', [
    SEED_VERSION,
  ]);
}

async function getRunner() {
  if (!runnerPromise) {
    runnerPromise = openRunner()
      .then(async (runner) => {
        await seedIfNeeded(runner);
        return runner;
      })
      .catch((error) => {
        runnerPromise = undefined;
        throw error;
      });
  }
  return runnerPromise;
}

export async function query(sql, params) {
  const runner = await getRunner();
  return runner.query(sql, params);
}

export async function run(sql) {
  const runner = await getRunner();
  return runner.run(sql);
}

export async function close() {
  if (!runnerPromise) return;
  const promise = runnerPromise;
  runnerPromise = undefined;
  const runner = await promise;
  await runner.close?.();
}
