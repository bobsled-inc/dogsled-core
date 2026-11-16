import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const require = createRequire(join(repoRoot, 'packages/bobsled-core/package.json'));
const { DuckDBInstance } = require('@duckdb/node-api');

const dbPath = join(__dirname, 'company_resolution.db');

// Cache a single instance + connection per module load.
let instancePromise;
let connectionPromise;
// Keep synchronously-accessible references so the process exit handler can
// call disconnectSync()/closeSync() without needing to await promises.
let resolvedConnection = null;
let resolvedInstance = null;

async function createInstanceWithRecovery() {
  try {
    return await DuckDBInstance.create(dbPath);
  } catch (err) {
    // WAL deserialization errors happen when the server process was killed
    // without cleanly checkpointing. Delete the WAL and retry — data committed
    // by pipeline subprocesses is safe in the main DB file.
    const msg = String(err);
    if (msg.includes('Serialization Error') || msg.includes('deserialize')) {
      const { unlink } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const walPath = `${dbPath}.wal`;
      if (existsSync(walPath)) {
        await unlink(walPath).catch(() => {});
        return DuckDBInstance.create(dbPath);
      }
    }
    throw err;
  }
}

function getInstance() {
  if (!instancePromise) {
    instancePromise = createInstanceWithRecovery().catch((err) => {
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

// Checkpoint + close synchronously on process exit so the WAL is flushed to
// the main DB file before the process dies. Closing the instance (not just the
// connection) is what releases the OS file lock and writes the checkpoint.
process.on('exit', () => {
  if (resolvedConnection) {
    try {
      resolvedConnection.disconnectSync();
    } catch {
      /* ignore */
    }
    resolvedConnection = null;
  }
  if (resolvedInstance) {
    try {
      resolvedInstance.closeSync();
    } catch {
      /* ignore */
    }
    resolvedInstance = null;
  }
});

// SIGTERM (how Next.js stops the dev server) does not trigger 'exit' by default.
// Call process.exit() to ensure the 'exit' handler above runs and flushes the WAL.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// DuckDB connections are not concurrency-safe. Serialize all operations through
// a promise chain so concurrent HTTP requests don't race on the same connection.
let queryMutex = Promise.resolve();
function withMutex(fn) {
  const ticket = queryMutex.then(fn);
  queryMutex = ticket.then(
    () => {},
    () => {}
  );
  return ticket;
}

async function runSql(sql) {
  return withMutex(async () => {
    const conn = await getConnection();
    await conn.run(sql);
  });
}

async function readAll(sql) {
  return withMutex(async () => {
    const conn = await getConnection();
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJS();
  });
}

let bootstrapped = false;
let bootstrapPromise;

async function ensureSchemas() {
  if (bootstrapped) return;
  if (bootstrapPromise) {
    await bootstrapPromise;
    return;
  }

  bootstrapPromise = (async () => {
    await runSql(`
      CREATE SCHEMA IF NOT EXISTS raw;
      CREATE SCHEMA IF NOT EXISTS entity_graph_demo;
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
  await runSql(sql);
  return { rowCount: undefined };
}

export async function query(sql) {
  await ensureSchemas();
  return readAll(sql);
}

/**
 * Close the connection AND the instance so the OS file lock is fully released.
 * Must be called before spawning CLI subprocesses that need write access to the
 * same database file (e.g. the Entity Graph pipeline seed/resolve steps).
 */
export async function close() {
  if (connectionPromise) {
    try {
      const conn = await connectionPromise;
      conn.disconnectSync();
    } catch {
      // ignore — the connection may already be invalid
    } finally {
      connectionPromise = undefined;
      resolvedConnection = null;
    }
  }
  if (instancePromise) {
    try {
      const instance = await instancePromise;
      instance.closeSync();
    } catch {
      // ignore
    } finally {
      instancePromise = undefined;
      resolvedInstance = null;
    }
  }
  bootstrapped = false;
}
