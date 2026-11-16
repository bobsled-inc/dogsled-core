/**
 * A large run on a row store, built in seconds rather than by running every assignment. The
 * coordinator creates and seals it, the shared transition applies each attempt in place, without
 * the checks a session makes, and the rows go in with the store's own batched inserts. The store
 * then holds what it would have written, so opening the run through it verifies every write and
 * validates the whole run, as any resume does: a mistake here reads as a damaged run, never as a
 * fast one.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDuckDbRunner, type IntegrationFile } from '@bobsled-inc/connections';
import { duckDbStateFile } from '../../src/agentic/duckdb-state.js';
import type { ExperimentalAgenticProbe } from '../../src/agentic/probe.js';
import { buildAgenticStepAssignments } from '../../src/agentic/plan-work.js';
import {
  agenticRowDb,
  duckDbRowDialect,
  type AgenticRowDb,
  type AgenticRowDialect,
} from '../../src/agentic/row-state-dialect.js';
import {
  agenticCommandItems,
  agenticCreateItems,
  agenticRunSummary,
  agenticStoredRows,
  createAgenticRowWrite,
  isAgenticRunReclaimable,
  type AgenticRowItem,
  type AgenticStoredRow,
} from '../../src/agentic/row-state-layout.js';
import { insertAgenticRows } from '../../src/agentic/row-state-rows.js';
import {
  AGENTIC_ROWS_TABLE,
  AGENTIC_ROW_RETENTION_MS,
  agenticNewRunHeader,
  agenticRowTable,
  agenticStatement,
  placeAgenticRunHeader,
  prepareAgenticRowTables,
  type AgenticRowBackend,
} from '../../src/agentic/row-state-tables.js';
import { executeAgenticRun } from '../../src/agentic/run.js';
import { estimateAssignmentTokens } from '../../src/agentic/spend.js';
import { applyAgenticCheckpointWithin } from '../../src/agentic/checkpoint-verified.js';
import {
  AgenticStateError,
  applyParsedCommand,
  digestAgenticState,
  type AgenticCheckpointCommand,
  type AgenticRunKey,
  type AgenticRunSnapshot,
  type AgenticStateStore,
} from '../../src/agentic/state.js';
import type { AgenticStoreLimits } from '../../src/agentic/store-limits.js';
import {
  warehouseRowStoreBackend,
  type WarehouseRowStoreOptions,
} from '../../src/agentic/warehouse-row-state.js';

/** The header layout this fixture writes, as `row-state.ts` does. */
const LAYOUT_VERSION = 1;

interface Workload {
  host: Omit<ExperimentalAgenticProbe, 'publish'>;
  context: () => Parameters<typeof executeAgenticRun>[1];
}

/** Runs the coordinator until its first model call and keeps what it saved. */
async function sealedRun(workload: Workload, runId: string, limits: AgenticStoreLimits) {
  let key: AgenticRunKey | undefined;
  let saved: AgenticRunSnapshot | null = null;
  const steps: {
    command: AgenticCheckpointCommand;
    after: AgenticRunSnapshot;
    workBefore: number;
  }[] = [];
  let initial: AgenticRunSnapshot | undefined;
  const store: AgenticStateStore = {
    limits,
    async acquire(runKey) {
      key = runKey;
      return {
        read: async () => saved,
        create: async (snapshot) => (saved = initial = snapshot),
        checkpoint: async (command) => {
          if (command.type === 'start_attempt') throw new AgenticStateError('conflict');
          const workBefore = saved!.work.length;
          saved = applyAgenticCheckpointWithin(saved!, command, Date.now(), limits);
          steps.push({ command, after: saved, workBefore });
          return saved;
        },
        release: async () => {},
      };
    },
  };
  await executeAgenticRun(workload.host, workload.context(), {
    projectDirectory: '/unused',
    stateStore: store,
    run: { id: runId, mode: 'start' },
  }).catch(() => undefined);
  if (!key || !initial || !saved || !steps.length) throw new Error('The run did not seal its work');
  return { key, initial, steps, sealed: saved as AgenticRunSnapshot };
}

/** What a host returns for one assignment, as the coordinator would save it. */
async function finishCommand(
  host: Workload['host'],
  snapshot: AgenticRunSnapshot,
  work: number,
  attemptId: string
): Promise<AgenticCheckpointCommand> {
  const assignment = snapshot.work[work]!.assignment;
  const outcome = await host.executeAgent!({
    assignment: structuredClone({ ...assignment, attempt_id: attemptId }),
    budget: {
      reserve: async (tokens: number) => ({ id: randomUUID(), attempt_id: attemptId, tokens }),
      settle: async () => {},
    },
    signal: new AbortController().signal,
  } as never);
  const charge = outcome.usage.status === 'measured' ? outcome.usage.total_tokens : 0;
  return {
    type: 'finish_attempt',
    operation_id: `finish_attempt:${attemptId}`,
    expected_revision: snapshot.revision,
    work,
    attempt_id: attemptId,
    outcome,
    charge,
    charge_microusd: 0,
  };
}

/** A run as the store would have written it: its final state and every stored row. */
interface BuiltAgenticRun {
  key: AgenticRunKey;
  snapshot: AgenticRunSnapshot;
  rows: AgenticStoredRow[];
  head: string;
}

/**
 * Builds the run `runId` of `workload` for a store with `dialect`, with the first `finished`
 * assignments done and the rest never started. Spend-cap accounting only.
 */
async function buildAgenticRun(
  workload: Workload,
  dialect: AgenticRowDialect,
  options: { runId: string; finished: number }
): Promise<BuiltAgenticRun> {
  const { key, initial, steps, sealed } = await sealedRun(workload, options.runId, dialect.limits);
  const items: { revision: number; operationId: string; items: AgenticRowItem[] }[] = [
    { revision: initial.revision, operationId: 'create', items: agenticCreateItems(initial) },
    ...steps.map(({ command, after, workBefore }) => ({
      revision: after.revision,
      operationId: command.operation_id,
      items: agenticCommandItems(after, command, workBefore),
    })),
  ];
  // One mutable copy, changed in place by the transition. Each command's rows are taken at once,
  // before the next command changes what they describe.
  const snapshot = JSON.parse(JSON.stringify(sealed)) as AgenticRunSnapshot;
  const attempts = new Set<string>();
  const apply = (command: AgenticCheckpointCommand) => {
    const workBefore = snapshot.work.length;
    applyParsedCommand(snapshot, command, Date.now(), {
      hasOvercharge: () => false,
      hasAttempt: (id) => attempts.has(id),
    });
    if ('attempt_id' in command) attempts.add(command.attempt_id);
    items.push({
      revision: snapshot.revision,
      operationId: command.operation_id,
      items: agenticCommandItems(snapshot, command, workBefore),
    });
  };
  const steps_ = (workload.context().resolved as { steps: { step: { id: string } }[] }).steps;
  for (let done = 0; done < options.finished;) {
    const work = snapshot.work.findIndex((item) => !item.accepted);
    if (work === -1) {
      // Everything sealed so far is accepted: the next step's assignments come from it.
      const index = snapshot.sealed_steps?.length ?? steps_.length;
      if (!snapshot.sealed_steps || index >= steps_.length) break;
      apply({
        type: 'append_step',
        operation_id: `append_step:${steps_[index]!.step.id}`,
        expected_revision: snapshot.revision,
        step_id: steps_[index]!.step.id,
        assignments: buildAgenticStepAssignments(snapshot, index),
      });
      continue;
    }
    const attemptId = randomUUID();
    apply({
      type: 'start_attempt',
      operation_id: `start_attempt:${attemptId}`,
      expected_revision: snapshot.revision,
      work,
      attempt_id: attemptId,
      charge: estimateAssignmentTokens(snapshot.work[work]!.assignment),
      charge_microusd: 0,
    });
    apply(await finishCommand(workload.host, snapshot, work, attemptId));
    done++;
  }
  // One chain of writes, each naming its parent.
  const rows: AgenticStoredRow[] = [];
  let head = '';
  for (const write of items) {
    const next = createAgenticRowWrite(head, write.revision, write.operationId, write.items);
    rows.push(...agenticStoredRows(next, dialect.maxRowChars));
    head = next.id;
  }
  return { key, snapshot, rows, head };
}

/** Writes `run` through `db` as the store would: its tables, its batched inserts, its header. */
async function writeAgenticRun(
  db: AgenticRowDb,
  dialect: AgenticRowDialect,
  namespace: string,
  run: BuiltAgenticRun,
  hasSchema?: AgenticRowBackend['hasSchema']
): Promise<void> {
  const { snapshot, head } = run;
  const hash = digestAgenticState(run.key);
  await prepareAgenticRowTables(db, dialect, namespace, hasSchema);
  const runs = await placeAgenticRunHeader(
    db,
    dialect,
    namespace,
    agenticNewRunHeader(run.key, hash, LAYOUT_VERSION)
  );
  const table = agenticRowTable(dialect, namespace, AGENTIC_ROWS_TABLE);
  await insertAgenticRows({ db, dialect, table, hash }, run.rows, async () => {});
  const q = dialect.identifier;
  const statement = agenticStatement(dialect);
  const set = [
    `${q('revision')} = ${statement.bind(snapshot.revision)}`,
    `${q('head')} = ${statement.bind(head)}`,
    `${q('token')} = ${statement.bind(randomUUID())}`,
    `${q('summary')} = ${statement.bind(agenticRunSummary(snapshot))}`,
    `${q('reclaimable')} = ${statement.bind(isAgenticRunReclaimable(snapshot))}`,
    `${q('retain_until')} = ${dialect.clock} + ${statement.bind(BigInt(AGENTIC_ROW_RETENTION_MS))}`,
  ].join(', ');
  const changed = await dialect.changed(
    db,
    `UPDATE ${runs} SET ${set} WHERE ${q('run_hash')} = ${statement.bind(hash)}`,
    statement.params
  );
  if (changed !== 1) throw new Error('The run header was not written');
}

/**
 * Writes the run `runId` of `workload` to its DuckDB run file in `project`, with the first
 * `finished` assignments done and the rest never started. Spend-cap accounting only.
 */
export async function writeDuckDbRun(
  workload: Workload,
  options: { project: string; runId: string; finished: number }
): Promise<AgenticRunSnapshot> {
  const run = await buildAgenticRun(workload, duckDbRowDialect, options);
  const directory = join(options.project, '.bobsled/model-spec/agentic-state');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `run-${digestAgenticState(run.key)}.duckdb`);
  const runner = await buildDuckDbRunner(duckDbStateFile(file), { isolated: true });
  try {
    const dialect = duckDbRowDialect;
    await writeAgenticRun(agenticRowDb(runner), dialect, dialect.identifier('main'), run);
  } finally {
    await runner.close?.();
  }
  return run.snapshot;
}

/**
 * Writes the run `runId` of `workload` to the warehouse row store that `integration` and
 * `options` open, through that store's own backend, as `writeDuckDbRun` does for a run file.
 */
export async function writeWarehouseRowRun(
  workload: Workload,
  integration: IntegrationFile,
  options: WarehouseRowStoreOptions & { runId: string; finished: number }
): Promise<AgenticRunSnapshot> {
  const { runId, finished, ...storeOptions } = options;
  const backend = warehouseRowStoreBackend(integration, storeOptions);
  const run = await buildAgenticRun(workload, backend.dialect, { runId, finished });
  const connection = await backend.connect();
  try {
    await connection.use((db) =>
      writeAgenticRun(db, backend.dialect, connection.namespace, run, backend.hasSchema)
    );
  } finally {
    await connection.close();
  }
  return run.snapshot;
}
