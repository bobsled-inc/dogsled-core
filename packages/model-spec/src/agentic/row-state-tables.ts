/** The tables of the row store and what connecting to them takes. No engine-specific SQL. */
import { setTimeout as delay } from 'node:timers/promises';
import { isCancellationError, type SqlParamValue } from '@bobsled-inc/connections';
import type {
  AgenticRowColumn,
  AgenticRowDb,
  AgenticRowDialect,
  AgenticRowTableShape,
} from './row-state-dialect.js';
import { AgenticStateError } from './state-errors.js';
import type { AgenticStoreLimits } from './store-limits.js';
import type { StatementTimeoutHandling } from './warehouse-statement-limit.js';

export const AGENTIC_ROW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const AGENTIC_RUNS_TABLE = '__dogsled_agentic_runs';
export const AGENTIC_ROWS_TABLE = '__dogsled_agentic_rows';
export const AGENTIC_CURSORS_TABLE = '__dogsled_agentic_cursors';

const text = (name: string): AgenticRowColumn => ({ name, type: 'text' });
const integer = (name: string): AgenticRowColumn => ({ name, type: 'integer' });
const runColumns: AgenticRowColumn[] = [
  text('run_hash'),
  text('scope'),
  text('model'),
  text('run_id'),
  integer('layout'),
  integer('revision'),
  text('lease_owner'),
  integer('lease_expires'),
  text('token'),
  text('head'),
  text('summary'),
  integer('retain_until'),
  { name: 'reclaimable', type: 'boolean' },
];
export const agenticRowColumns: AgenticRowColumn[] = [
  text('run_hash'),
  text('write_id'),
  text('parent'),
  integer('revision'),
  text('operation_id'),
  text('kind'),
  integer('item'),
  integer('part'),
  integer('parts'),
  text('data'),
];
const cursorColumns: AgenticRowColumn[] = [
  text('key_hash'),
  text('scope'),
  text('model'),
  text('target'),
  integer('version'),
  text('record'),
];

const agenticTables: readonly (AgenticRowTableShape & { key: readonly string[] })[] = [
  { name: AGENTIC_RUNS_TABLE, columns: runColumns, key: ['run_hash'] },
  {
    name: AGENTIC_ROWS_TABLE,
    columns: agenticRowColumns,
    key: ['run_hash', 'write_id', 'item', 'part'],
  },
  { name: AGENTIC_CURSORS_TABLE, columns: cursorColumns, key: ['key_hash'] },
];

/** A database reachable for one session or cursor operation. */
export interface AgenticRowConnection {
  /** Quoted schema that holds the tables. */
  namespace: string;
  /** Runs one store operation. Backends that open a file per operation do so here.
   * `cleanup` operations must run even after the session's signal aborted. */
  use<T>(operation: (db: AgenticRowDb) => Promise<T>, options?: { cleanup?: boolean }): Promise<T>;
  close(): Promise<void>;
}
export interface AgenticRowBackend {
  dialect: AgenticRowDialect;
  /** `handling` is what a timed-out statement does to the session. A warehouse backend passes
   * it to `openLimitedRunner`, which sets the server-side limit for that session. */
  connect(handling?: StatementTimeoutHandling): Promise<AgenticRowConnection>;
}
export type AgenticRowOwnership =
  /** Shared tables: ownership is a fenced lease on the store's clock. */
  | { mode: 'lease'; leaseMs: number }
  /** The caller holds exclusive access to this database for the whole session. */
  | { mode: 'exclusive'; assert(): void };
export interface AgenticRowSessionOptions {
  ownership: AgenticRowOwnership;
  limits: AgenticStoreLimits;
  retentionMs?: number;
  signal?: AbortSignal;
}

/**
 * A run's header before its first claim. The claim dates it from the store clock, so no client
 * clock is involved, and until then nothing can expire it.
 */
export function agenticNewRunHeader(
  key: { scope: string; model: string; id: string },
  hash: string,
  layout: number
) {
  return {
    run_hash: hash,
    scope: key.scope,
    model: key.model,
    run_id: key.id,
    layout,
    revision: -1,
    lease_owner: '',
    lease_expires: 0,
    token: '',
    head: '',
    summary: '',
    retain_until: BigInt(Number.MAX_SAFE_INTEGER),
    reclaimable: true,
  };
}

export function agenticRowTable(
  dialect: AgenticRowDialect,
  namespace: string,
  name: string
): string {
  return `${namespace}.${dialect.identifier(name)}`;
}

async function createAgenticRowTables(
  db: AgenticRowDb,
  dialect: AgenticRowDialect,
  namespace: string
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.run(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
      for (const { name, columns, key } of agenticTables) {
        await db.run(dialect.createTable(agenticRowTable(dialect, namespace, name), columns, key));
      }
      return;
    } catch (error) {
      // Concurrent first use can fail despite IF NOT EXISTS: PostgreSQL reports a duplicate
      // catalog row. The statements are idempotent, so repeat them.
      if (attempt >= 3 || isCancellationError(error)) throw error;
      await delay(20 * 2 ** attempt);
    }
  }
}

/** Confirms that what stands under the tables' names is what the store created. */
async function assertAgenticRowTables(
  db: AgenticRowDb,
  dialect: AgenticRowDialect,
  namespace: string
): Promise<void> {
  if (!(await dialect.hasBaseTables(db, namespace, agenticTables))) {
    throw new AgenticStateError('corrupt', {
      reason: 'state_table_replaced',
      message: 'The agentic checkpoint store is not as Dogsled created it.',
      hint: 'Stop all writers and inspect the store before resuming. It must hold nothing else.',
    });
  }
}

export async function prepareAgenticRowTables(
  db: AgenticRowDb,
  dialect: AgenticRowDialect,
  namespace: string
): Promise<void> {
  await createAgenticRowTables(db, dialect, namespace);
  await assertAgenticRowTables(db, dialect, namespace);
}

const preparedBackends = new WeakSet<AgenticRowBackend>();

/** Creates the tables once per backend. Recovery acquires again, and on a warehouse every
 * setup statement can cost a second. */
export async function ensureAgenticRowTables(
  db: AgenticRowDb,
  backend: AgenticRowBackend,
  namespace: string
): Promise<void> {
  if (preparedBackends.has(backend)) return;
  await prepareAgenticRowTables(db, backend.dialect, namespace);
  preparedBackends.add(backend);
}

/**
 * For a backend that opens its database for each operation: what setup confirmed says nothing
 * about a file that has been closed since. Before setup there is nothing to confirm yet, and
 * setup checks in the same operation.
 */
export async function reconfirmAgenticRowTables(
  db: AgenticRowDb,
  backend: AgenticRowBackend,
  namespace: string
): Promise<void> {
  if (preparedBackends.has(backend)) await assertAgenticRowTables(db, backend.dialect, namespace);
}

/** Parameters for one statement. Bind values in the order they appear in the SQL. */
export function agenticStatement(dialect: AgenticRowDialect) {
  const params: SqlParamValue[] = [];
  return {
    params,
    bind(value: SqlParamValue): string {
      params.push(value);
      return dialect.bind(params.length);
    },
  };
}
