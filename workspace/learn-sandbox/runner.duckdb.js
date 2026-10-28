import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const require = createRequire(join(repoRoot, 'packages/dogsled/package.json'));
const { DuckDBInstance } = require('@duckdb/node-api');

const dbPath = join(__dirname, 'learn.duckdb');

let instancePromise;
let connectionPromise;
let resolvedConnection = null;
let resolvedInstance = null;

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
      resolvedInstance = instance;
      const conn = await instance.connect();
      resolvedConnection = conn;
      return conn;
    })().catch((err) => {
      connectionPromise = undefined;
      throw err;
    });
  }
  return connectionPromise;
}

process.on('exit', () => {
  if (resolvedConnection) {
    try {
      resolvedConnection.disconnectSync();
    } catch {
      /* ignore */
    }
  }
  if (resolvedInstance) {
    try {
      resolvedInstance.closeSync();
    } catch {
      /* ignore */
    }
  }
});

let queryMutex = Promise.resolve();
function withMutex(fn) {
  const ticket = queryMutex.then(fn);
  queryMutex = ticket.then(
    () => {},
    () => {}
  );
  return ticket;
}

export default async function run(sql) {
  await withMutex(async () => {
    const conn = await getConnection();
    await conn.run(sql);
  });
  return { rowCount: undefined };
}

export async function query(sql) {
  return withMutex(async () => {
    const conn = await getConnection();
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJS();
  });
}
