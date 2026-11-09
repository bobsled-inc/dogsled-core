/**
 * A large run in a DuckDB run file, built in seconds rather than by running every assignment. The
 * coordinator creates and seals it, the shared transition applies each attempt in place, without
 * the checks a session makes, and the rows go in with a few large statements. The file then holds
 * what the store would have written, so opening it through the store verifies every write and
 * validates the whole run, as any resume does: a mistake here reads as a damaged run, never as a
 * fast one.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { duckDbStateFile } from '../../src/agentic/duckdb-state.js';
import type { ExperimentalAgenticProbe } from '../../src/agentic/probe.js';
import { buildAgenticStepAssignments } from '../../src/agentic/plan-work.js';
import { agenticRowDb, duckDbRowDialect } from '../../src/agentic/row-state-dialect.js';
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
import {
  AGENTIC_ROWS_TABLE,
  AGENTIC_ROW_RETENTION_MS,
  agenticNewRunHeader,
  agenticRowColumns,
  agenticRowTable,
  agenticStatement,
  placeAgenticRunHeader,
  prepareAgenticRowTables,
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

/** The header layout this fixture writes, as `row-state.ts` does. */
const LAYOUT_VERSION = 1;

interface Workload {
  host: Omit<ExperimentalAgenticProbe, 'publish'>;
  context: () => Parameters<typeof executeAgenticRun>[1];
}

/** Runs the coordinator until its first model call and keeps what it saved. */
async function sealedRun(workload: Workload, runId: string) {
  const { limits } = duckDbRowDialect;
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
      reserve: async (tokens) => ({ id: randomUUID(), attempt_id: attemptId, tokens }),
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

/**
 * Writes the run `runId` of `workload` to its DuckDB run file in `project`, with the first
 * `finished` assignments done and the rest never started. Spend-cap accounting only.
 */
export async function writeDuckDbRun(
  workload: Workload,
  options: { project: string; runId: string; finished: number }
): Promise<AgenticRunSnapshot> {
  const { key, initial, steps, sealed } = await sealedRun(workload, options.runId);
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
  for (let done = 0; done < options.finished; ) {
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
  // One chain of writes, each naming its parent, then all of their rows in large statements.
  const stored: AgenticStoredRow[] = [];
  let head = '';
  for (const write of items) {
    const next = createAgenticRowWrite(head, write.revision, write.operationId, write.items);
    stored.push(...agenticStoredRows(next, duckDbRowDialect.maxRowChars));
    head = next.id;
  }
  const directory = join(options.project, '.dogsled/model-spec/agentic-state');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hash = digestAgenticState(key);
  const runner = await buildDuckDbRunner(duckDbStateFile(join(directory, `run-${hash}.duckdb`)), {
    isolated: true,
  });
  try {
    const db = agenticRowDb(runner);
    const dialect = duckDbRowDialect;
    const namespace = dialect.identifier('main');
    await prepareAgenticRowTables(db, dialect, namespace);
    const runs = await placeAgenticRunHeader(
      db,
      dialect,
      namespace,
      agenticNewRunHeader(key, hash, LAYOUT_VERSION)
    );
    const table = agenticRowTable(dialect, namespace, AGENTIC_ROWS_TABLE);
    const columns = agenticRowColumns.map((column) => column.name);
    for (let start = 0; start < stored.length; ) {
      let end = start;
      let chars = 0;
      while (
        end < stored.length &&
        end - start < dialect.maxInsertRows &&
        (end === start || chars + stored[end]!.data.length <= dialect.maxInsertChars)
      ) {
        chars += stored[end]!.data.length;
        end++;
      }
      const batch = stored.slice(start, end);
      await db.query(
        dialect.insertRows(table, columns, batch.length),
        batch.flatMap((row) => [
          hash,
          row.write_id,
          row.parent,
          row.revision,
          row.operation_id,
          row.kind,
          row.item,
          row.part,
          row.parts,
          row.data,
        ])
      );
      start = end;
    }
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
  } finally {
    await runner.close?.();
  }
  return snapshot;
}
