/**
 * A state session over rows. It keeps the snapshot in memory under its ownership, applies
 * each command with the shared transition, and writes only what changed: immutable rows,
 * then one fenced update of the header. The header update is the commit. Rows it does not
 * name are orphans, so a crash between the two statements leaves the previous state intact.
 * See docs/agentic-state.md for the tables and the recovery argument.
 */
import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '@bobsled-inc/connections';
import type { AgenticRowDb } from './row-state-dialect.js';
import {
  agenticCommandItems,
  agenticCreateItems,
  agenticRunSummary,
  createAgenticRowWrite,
  isAgenticRunReclaimable,
  rebuildAgenticSnapshot,
  type AgenticRowItem,
} from './row-state-layout.js';
import {
  agenticHeaderColumns,
  insertAgenticWrite,
  purgeExpiredAgenticRuns,
  readAgenticWrites,
  type AgenticRunRows,
} from './row-state-rows.js';
import {
  AGENTIC_ROWS_TABLE,
  AGENTIC_ROW_RETENTION_MS,
  AGENTIC_RUNS_TABLE,
  agenticNewRunHeader,
  agenticRowTable,
  agenticStatement,
  ensureAgenticRowTables,
  type AgenticRowBackend,
  type AgenticRowSessionOptions,
} from './row-state-tables.js';
import {
  AgenticRunKeySchema,
  AgenticStateError,
  digestAgenticState,
  applyAgenticCheckpoint,
  type AgenticRunKey,
  type AgenticRunSnapshot,
  type AgenticStateSession,
} from './state.js';
import { checkpointJsonBytes, parseVerifiedCheckpoint } from './checkpoint-verified.js';

const LAYOUT_VERSION = 1;

/** The durable state this session confirmed. `json` is null before `create`. */
interface Durable {
  /** Verified state, so a command costs what it changes. Null before create(). */
  snapshot: AgenticRunSnapshot | null;
  revision: number;
  head: string;
}

export async function openAgenticRowSession(
  backend: AgenticRowBackend,
  rawKey: AgenticRunKey,
  options: AgenticRowSessionOptions
): Promise<AgenticStateSession> {
  throwIfCancelled(options.signal);
  const key = AgenticRunKeySchema.parse(rawKey);
  const hash = digestAgenticState(key);
  const { dialect } = backend;
  const { ownership, limits, signal } = options;
  const lease = ownership.mode === 'lease' ? ownership : undefined;
  // Thirty days in milliseconds is past 32 bits, where a driver can wrap a plain number.
  const retentionMs = BigInt(options.retentionMs ?? AGENTIC_ROW_RETENTION_MS);
  const q = dialect.identifier;
  const owner = randomUUID();
  const controller = new AbortController();
  // Why this session lost ownership. The first cause stays the reported one.
  let lost: AgenticStateError | undefined;
  // Only a confirmed header update replaces this. After an uncertain write it stays empty
  // until the next read reloads the rows, so a lost reply can never be mistaken for a failure.
  let durable: Durable | undefined;
  const loseOwnership = (error = new AgenticStateError('lease_lost')): AgenticStateError => {
    if (!lease) return new AgenticStateError('conflict');
    lost ??= error;
    durable = undefined;
    // Still an AbortError for executors; the coordinator reads the cause.
    controller.abort(new DOMException(lost.message, { name: 'AbortError', cause: lost }));
    return lost;
  };
  const connection = await backend.connect(
    // A renewal that landed late can extend the lease, so wait a whole lease from here.
    lease ? { retryAfterMs: lease.leaseMs, onTimeout: loseOwnership } : undefined
  );
  const { namespace } = connection;
  const runs = agenticRowTable(dialect, namespace, AGENTIC_RUNS_TABLE);
  const rows = agenticRowTable(dialect, namespace, AGENTIC_ROWS_TABLE);
  const clock = dialect.clock;

  // Changes with every header write. Only a session that saw the latest write can make the next.
  let token = '';
  let closed = false;
  // Local time at which the last successful lease extension was requested.
  let extendedAt = 0;
  let loaded = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const guard = (): void => {
    throwIfCancelled(signal);
    if (lost) throw lost;
    if (closed) throw new AgenticStateError('conflict');
    if (ownership.mode === 'exclusive') {
      try {
        ownership.assert();
      } catch {
        throw new AgenticStateError('conflict');
      }
    }
  };
  /** Rows owned by this session while its lease is alive. */
  const owned = (statement: ReturnType<typeof agenticStatement>): string =>
    `${q('run_hash')} = ${statement.bind(hash)} AND ${q('lease_owner')} = ${statement.bind(owner)}${
      lease ? ` AND ${q('lease_expires')} > ${clock}` : ''
    }`;

  const renew = async (db: AgenticRowDb): Promise<void> => {
    if (!lease) return;
    guard();
    const started = Date.now();
    const statement = agenticStatement(dialect);
    const next = randomUUID();
    const set = `${q('lease_expires')} = ${clock} + ${statement.bind(lease.leaseMs)}, ${q('token')} = ${statement.bind(next)}`;
    let changed: number;
    try {
      changed = await dialect.changed(
        db,
        `UPDATE ${runs} SET ${set} WHERE ${owned(statement)}`,
        statement.params
      );
    } catch {
      throwIfCancelled(signal);
      throw loseOwnership();
    }
    if (changed !== 1) throw loseOwnership();
    token = next;
    extendedAt = started;
  };
  // The heartbeat waits behind a long write, so renew inside it before the lease runs out.
  const renewIfDue = async (db: AgenticRowDb): Promise<void> => {
    if (lease && Date.now() - extendedAt >= lease.leaseMs / 3) await renew(db);
  };

  const stored = (db: AgenticRowDb): AgenticRunRows => ({ db, dialect, table: rows, hash });
  const claim = async (db: AgenticRowDb): Promise<void> => {
    await ensureAgenticRowTables(db, backend, namespace);
    if (lease) await purgeExpiredAgenticRuns(stored(db), runs, lease.leaseMs);
    await dialect.insertIfAbsent(
      db,
      runs,
      agenticNewRunHeader(key, hash, LAYOUT_VERSION),
      'run_hash',
      namespace
    );
    const statement = agenticStatement(dialect);
    const next = randomUUID();
    const set = [
      `${q('lease_owner')} = ${statement.bind(owner)}`,
      `${q('token')} = ${statement.bind(next)}`,
      `${q('retain_until')} = ${clock} + ${statement.bind(retentionMs)}`,
      ...(lease ? [`${q('lease_expires')} = ${clock} + ${statement.bind(lease.leaseMs)}`] : []),
    ].join(', ');
    const free = lease ? ` AND ${q('lease_expires')} <= ${clock}` : '';
    const started = Date.now();
    const changed = await dialect.changed(
      db,
      `UPDATE ${runs} SET ${set} WHERE ${q('run_hash')} = ${statement.bind(hash)}${free}`,
      statement.params
    );
    if (changed !== 1) {
      throw new AgenticStateError('conflict', {
        reason: 'run_in_progress',
        message: `Run "${key.id}" is owned by another Dogsled process.`,
        hint: 'Wait for that process to finish or for its lease to expire, then resume.',
      });
    }
    token = next;
    extendedAt = started;
  };

  const load = async (db: AgenticRowDb): Promise<Durable> => {
    // Only the session's first load, which comes before any write of its own, can sweep.
    const sweepOrphans = !loaded;
    loaded = true;
    const statement = agenticStatement(dialect);
    const headers = await db.query(
      `SELECT ${agenticHeaderColumns(dialect)} FROM ${runs} WHERE ${owned(statement)} LIMIT 2`,
      statement.params
    );
    if (headers.length === 0) throw loseOwnership();
    const header = headers[0]!;
    if (
      headers.length !== 1 ||
      Number(header.layout) !== LAYOUT_VERSION ||
      header.scope !== key.scope ||
      header.model !== key.model ||
      header.run_id !== key.id ||
      typeof header.summary !== 'string' ||
      typeof header.head !== 'string' ||
      typeof header.token !== 'string'
    ) {
      throw new AgenticStateError('corrupt');
    }
    token = header.token;
    const revision = Number(header.revision);
    const head = header.head;
    if (header.summary === '') {
      if (revision !== -1 || head !== '') throw new AgenticStateError('corrupt');
      return { snapshot: null, revision, head };
    }
    const writes = await readAgenticWrites(stored(db), head, revision, sweepOrphans);
    let snapshot: AgenticRunSnapshot;
    try {
      snapshot = parseVerifiedCheckpoint(
        rebuildAgenticSnapshot({ key, revision, summary: header.summary }, writes)
      );
    } catch {
      throw new AgenticStateError('corrupt');
    }
    return { snapshot, revision, head };
  };

  /** Rows first, then the single statement that commits them. */
  const save = async (
    db: AgenticRowDb,
    current: Durable,
    next: AgenticRunSnapshot,
    operationId: string,
    items: AgenticRowItem[]
  ): Promise<AgenticRunSnapshot> => {
    guard();
    if (checkpointJsonBytes(next) > limits.maxCheckpointBytes) {
      throw new AgenticStateError('limit', {
        reason: 'snapshot_too_large',
        message: `The agentic run checkpoint is larger than ${Math.floor(limits.maxCheckpointBytes / 1048576)} MiB.`,
        hint: 'Process fewer or smaller input rows per run.',
      });
    }
    const write = items.length
      ? createAgenticRowWrite(current.head, next.revision, operationId, items)
      : undefined;
    durable = undefined;
    if (write) {
      await insertAgenticWrite(stored(db), write, async () => {
        guard();
        await renewIfDue(db);
      });
    }
    await renewIfDue(db);
    guard();
    const statement = agenticStatement(dialect);
    const nextToken = randomUUID();
    const head = write?.id ?? current.head;
    const set = [
      `${q('revision')} = ${statement.bind(next.revision)}`,
      `${q('head')} = ${statement.bind(head)}`,
      `${q('token')} = ${statement.bind(nextToken)}`,
      `${q('summary')} = ${statement.bind(agenticRunSummary(next))}`,
      `${q('reclaimable')} = ${statement.bind(isAgenticRunReclaimable(next))}`,
      `${q('retain_until')} = ${clock} + ${statement.bind(retentionMs)}`,
      ...(lease ? [`${q('lease_expires')} = ${clock} + ${statement.bind(lease.leaseMs)}`] : []),
    ].join(', ');
    const fence = `${owned(statement)} AND ${q('token')} = ${statement.bind(token)} AND ${q('revision')} = ${statement.bind(current.revision)}`;
    const committing = Date.now();
    const changed = await dialect.changed(
      db,
      `UPDATE ${runs} SET ${set} WHERE ${fence}`,
      statement.params
    );
    if (changed !== 1) throw loseOwnership();
    token = nextToken;
    extendedAt = committing;
    durable = { snapshot: next, revision: next.revision, head };
    return next;
  };

  try {
    await connection.use(claim);
  } catch (error) {
    await connection.close();
    throw error;
  }
  if (lease) {
    let renewing = false;
    timer = setInterval(
      () => {
        if (renewing || closed || lost || signal?.aborted) return;
        renewing = true;
        void serial(() => connection.use(renew))
          .catch(() => {
            if (!closed && !signal?.aborted) loseOwnership();
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.floor(lease.leaseMs / 3)
    );
    timer.unref();
  }
  const current = async (db: AgenticRowDb): Promise<Durable> => (durable ??= await load(db));
  return {
    ...(lease ? { ownershipLost: controller.signal } : {}),
    // Always from the rows, so a read proves what is durable and detects damage.
    read: () =>
      serial(() =>
        connection.use(async (db) => {
          guard();
          durable = await load(db);
          return structuredClone(durable.snapshot);
        })
      ),
    create: (snapshot) =>
      serial(() =>
        connection.use(async (db) => {
          guard();
          const before = await current(db);
          if (before.snapshot !== null) throw new AgenticStateError('conflict');
          const value = parseVerifiedCheckpoint(snapshot);
          if (
            digestAgenticState(value.key) !== hash ||
            value.revision !== 0 ||
            value.status !== 'preparing' ||
            value.work.length ||
            value.charged
          ) {
            throw new AgenticStateError('conflict');
          }
          const items = agenticCreateItems(value);
          return structuredClone(await save(db, before, value, 'create', items));
        })
      ),
    checkpoint: (command) =>
      serial(() =>
        connection.use(async (db) => {
          guard();
          const before = await current(db);
          if (before.snapshot === null) throw new AgenticStateError('missing');
          const workBefore = before.snapshot.work.length;
          const value = applyAgenticCheckpoint(before.snapshot, command, Date.now());
          if (value.revision === before.snapshot.revision) {
            // A repeated command writes nothing, but obsolete ownership must still fail.
            const statement = agenticStatement(dialect);
            const alive = await db.query(
              `SELECT 1 AS alive FROM ${runs} WHERE ${owned(statement)} LIMIT 1`,
              statement.params
            );
            if (!alive.length) throw loseOwnership();
            return value;
          }
          const items = agenticCommandItems(value, command, workBefore);
          return save(db, before, value, command.operation_id, items);
        })
      ),
    release: () =>
      serial(async () => {
        if (closed) return;
        durable = undefined;
        if (timer) clearInterval(timer);
        try {
          // Release is cleanup, so it runs after cancellation too. A successor has a
          // different owner, which makes this a no-op.
          if (!lost) {
            await connection.use(
              (db) => {
                const statement = agenticStatement(dialect);
                const set = `${q('lease_owner')} = '', ${q('lease_expires')} = 0`;
                const where = `${q('run_hash')} = ${statement.bind(hash)} AND ${q('lease_owner')} = ${statement.bind(owner)}`;
                return db.query(`UPDATE ${runs} SET ${set} WHERE ${where}`, statement.params);
              },
              { cleanup: true }
            );
          }
        } finally {
          closed = true;
          await connection.close();
        }
      }),
  };
}
