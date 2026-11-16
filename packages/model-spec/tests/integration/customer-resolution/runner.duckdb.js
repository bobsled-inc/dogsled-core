import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../../..');
const require = createRequire(join(repoRoot, 'packages/bobsled-core/package.json'));
const { DuckDBInstance } = require('@duckdb/node-api');

const dbPath = join(__dirname, 'customer_resolution.db');
let instancePromise;

function getInstance() {
  if (!instancePromise) {
    instancePromise = DuckDBInstance.create(dbPath);
  }
  return instancePromise;
}

async function openConnection() {
  const instance = await getInstance();
  return instance.connect();
}

async function exec(sql) {
  const conn = await openConnection();
  try {
    await conn.run(sql);
  } finally {
    conn.disconnectSync();
  }
}

async function all(sql) {
  const conn = await openConnection();
  try {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJS();
  } finally {
    conn.disconnectSync();
  }
}

let bootstrapped = false;
let bootstrapPromise;

async function ensureSchemas() {
  if (bootstrapped) {
    return;
  }
  if (bootstrapPromise) {
    await bootstrapPromise;
    return;
  }

  bootstrapPromise = (async () => {
    await exec(`
      CREATE SCHEMA IF NOT EXISTS raw;
      CREATE SCHEMA IF NOT EXISTS entity_graph_test;
    `);
    bootstrapped = true;
  })();

  try {
    await bootstrapPromise;
  } finally {
    bootstrapPromise = undefined;
  }
}

export default async function run(sql) {
  await ensureSchemas();
  await exec(sql);
  return { rowCount: undefined };
}

export async function query(sql) {
  await ensureSchemas();
  return all(sql);
}
