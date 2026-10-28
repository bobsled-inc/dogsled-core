import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const require = createRequire(join(repoRoot, 'packages/dogsled/package.json'));
const { DuckDBInstance } = require('@duckdb/node-api');

const dbPath = join(__dirname, 'demo.db');
let instancePromise;
let connectionPromise;

function getInstance() {
  if (!instancePromise) {
    instancePromise = DuckDBInstance.create(dbPath).catch((err) => {
      instancePromise = undefined;
      throw err;
    });
  }
  return instancePromise;
}

async function getConnection() {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const instance = await getInstance();
      return instance.connect();
    })().catch((err) => {
      connectionPromise = undefined;
      throw err;
    });
  }
  return connectionPromise;
}

async function runSql(sql) {
  const conn = await getConnection();
  await conn.run(sql);
}

async function readAll(sql) {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS();
}

let bootstrapped = false;

async function ensureSchemas() {
  if (bootstrapped) return;
  await runSql('CREATE SCHEMA IF NOT EXISTS raw; CREATE SCHEMA IF NOT EXISTS main;');
  bootstrapped = true;
}

export default async function run(sql) {
  await ensureSchemas();
  await runSql(sql);
  return { rowCount: undefined };
}

export async function query(sql) {
  await ensureSchemas();
  return readAll(sql);
}

export async function close() {
  try {
    if (connectionPromise) {
      const conn = await connectionPromise;
      conn.disconnectSync();
    }
  } catch {
  } finally {
    connectionPromise = undefined;
  }
  try {
    const instance = instancePromise ? await instancePromise : undefined;
    instance?.closeSync();
  } catch {
  } finally {
    instancePromise = undefined;
    bootstrapped = false;
  }
}
